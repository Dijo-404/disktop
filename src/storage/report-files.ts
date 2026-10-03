import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, link, lstat, open, rename, stat, unlink } from "node:fs/promises";
import type { OperationFailure } from "../domain/errors.js";
import type { RawPath, Warning } from "../domain/models.js";
import { pathBytes, rawPathFromBytes } from "../domain/paths.js";
import type { ReportFilePort, ReportWriteOutcome } from "../ports/reports.js";

/** A report names files somebody owns, so it starts out readable by them alone. */
export const REPORT_FILE_MODE = 0o600;

const SLASH = 0x2f;

/**
 * Errors `link(2)` gives on a filesystem that has no hard links at all —
 * vfat and exFAT on a USB stick, and some FUSE filesystems. A report written
 * to one is still a legitimate thing to want.
 */
const NO_HARD_LINKS = new Set(["EPERM", "EOPNOTSUPP", "ENOTSUP", "ENOSYS"]);

/** Directories whose fsync the filesystem does not support, which is not a failure. */
const NO_DIRECTORY_SYNC = new Set(["EINVAL", "EOPNOTSUPP", "ENOTSUP", "EBADF"]);

export interface ReportFileOptions {
  /** Replaceable so a test can stand in for a filesystem without hard links. */
  readonly link?: typeof link;
}

/**
 * Write a report under a name nothing holds yet, completely or not at all.
 *
 * The content goes to a staging file created exclusively in the same
 * directory, is flushed, and is then published with `link`, which fails
 * rather than replace anything already at the name — a file, a directory, or
 * a symlink, dangling or not. Nothing is ever written through a symlink at
 * the final component. A crash leaves at most a hidden staging file, never a
 * truncated report under the name somebody asked for.
 *
 * This is Disktop writing a file of its own making, which is why it lives
 * with the rest of Disktop's storage and not with the helper: it never
 * touches anything that already exists.
 */
export function createReportFiles(options: ReportFileOptions = {}): ReportFilePort {
  const linkFile = options.link ?? link;

  return {
    async check(target) {
      const bytes = Buffer.from(pathBytes(target));
      const directory = parentOf(bytes);
      try {
        await lstat(bytes);
        return { kind: "refused", failure: await existsFailure(target, bytes) };
      } catch (error) {
        if (codeOf(error) !== "ENOENT") {
          return { kind: "refused", failure: failureFor(error, target, directory) };
        }
      }
      try {
        const found = await stat(directory);
        if (!found.isDirectory()) {
          return {
            kind: "refused",
            failure: { code: "invalid-input", message: `${display(directory)} is not a directory, so ${target.display} cannot be created in it.` },
          };
        }
        await access(directory, constants.W_OK | constants.X_OK);
      } catch (error) {
        return { kind: "refused", failure: failureFor(error, target, directory) };
      }
      return { kind: "clear" };
    },

    async createExclusive(target, content) {
      const bytes = Buffer.from(pathBytes(target));
      const directory = parentOf(bytes);
      // A short name of Disktop's own, so a target at the 255-byte limit
      // still has room for its staging file beside it.
      const staging = Buffer.concat([directory, Buffer.from(`/.disktop-report-${randomBytes(8).toString("hex")}.partial`)]);

      let handle;
      try {
        handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, REPORT_FILE_MODE);
      } catch (error) {
        return { kind: "refused", failure: failureFor(error, target, directory) };
      }
      try {
        await handle.writeFile(content);
        // The bytes have to be on the device before a name points at them.
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(staging).catch(() => undefined);
        return { kind: "refused", failure: failureFor(error, target, directory) };
      }
      await handle.close();

      const warnings: Warning[] = [];
      try {
        await linkFile(staging, bytes);
      } catch (error) {
        if (!NO_HARD_LINKS.has(codeOf(error) ?? "")) {
          await unlink(staging).catch(() => undefined);
          return {
            kind: "refused",
            failure: codeOf(error) === "EEXIST" ? await existsFailure(target, bytes) : failureFor(error, target, directory),
          };
        }
        const claimed = await publishWithoutLinks(staging, bytes, target, directory);
        if (claimed !== undefined) {
          return claimed;
        }
        return finish(directory, content, warnings);
      }

      try {
        await unlink(staging);
      } catch (error) {
        warnings.push({
          code: "report-staging-left",
          message: `The report was written, but its staging file ${display(staging)} could not be removed: ${codeOf(error) ?? "unknown error"}.`,
          path: rawPathFromBytes(staging),
        });
      }
      return finish(directory, content, warnings);
    },
  };
}

/**
 * Publish on a filesystem that cannot link: claim the name with an exclusive
 * create, then rename the finished staging file over the empty file this call
 * just made. The rename only ever replaces that placeholder, so the promise
 * not to replace anything still holds, and the name holds either nothing,
 * the placeholder, or the whole report.
 */
async function publishWithoutLinks(
  staging: Buffer,
  bytes: Buffer,
  target: RawPath,
  directory: Buffer,
): Promise<ReportWriteOutcome | undefined> {
  let placeholder;
  try {
    const handle = await open(bytes, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, REPORT_FILE_MODE);
    placeholder = await handle.stat({ bigint: true });
    await handle.close();
  } catch (error) {
    await unlink(staging).catch(() => undefined);
    return {
      kind: "refused",
      failure: codeOf(error) === "EEXIST" ? await existsFailure(target, bytes) : failureFor(error, target, directory),
    };
  }
  try {
    await rename(staging, bytes);
  } catch (error) {
    await unlink(staging).catch(() => undefined);
    // Take the placeholder back only if it is still the empty file made
    // above; anything else at that name is somebody else's.
    const now = await lstat(bytes, { bigint: true }).catch(() => undefined);
    if (now !== undefined && now.ino === placeholder.ino && now.dev === placeholder.dev && now.size === 0n) {
      await unlink(bytes).catch(() => undefined);
    }
    return { kind: "refused", failure: failureFor(error, target, directory) };
  }
  return undefined;
}

async function finish(directory: Buffer, content: Uint8Array, warnings: Warning[]): Promise<ReportWriteOutcome> {
  const unsynced = await syncDirectory(directory);
  return {
    kind: "written",
    bytesWritten: BigInt(content.byteLength),
    warnings: unsynced === undefined ? warnings : [...warnings, unsynced],
  };
}

/** Flush the new directory entry, so the report survives a power cut as well as a crash. */
async function syncDirectory(directory: Buffer): Promise<Warning | undefined> {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    await handle.sync();
    return undefined;
  } catch (error) {
    if (NO_DIRECTORY_SYNC.has(codeOf(error) ?? "")) {
      return undefined;
    }
    return {
      code: "report-not-durable",
      message: `The report was written, but ${display(directory)} could not be flushed to disk (${codeOf(error) ?? "unknown error"}); a power cut could still lose it.`,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function existsFailure(target: RawPath, bytes: Buffer): Promise<OperationFailure> {
  const found = await lstat(bytes).catch(() => undefined);
  const what = found?.isDirectory() === true ? "is a directory" : found?.isSymbolicLink() === true ? "is a symlink" : "already exists";
  return {
    code: "invalid-input",
    message: `${target.display} ${what}. Disktop never replaces a file with a report: name a new file, or move the old one away first.`,
  };
}

function failureFor(error: unknown, target: RawPath, directory: Buffer): OperationFailure {
  const code = codeOf(error);
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
      return { code: "invalid-input", message: `${display(directory)} is not an existing directory, so ${target.display} cannot be created.` };
    case "ENAMETOOLONG":
      return { code: "invalid-input", message: `${target.display} is longer than this filesystem allows for a name.` };
    case "ELOOP":
      return { code: "invalid-input", message: `${target.display} cannot be reached without following too many symlinks.` };
    case "EISDIR":
      return { code: "invalid-input", message: `${target.display} is a directory. Name a file inside it instead.` };
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return { code: "permission-denied", message: `Disktop may not create ${target.display} in ${display(directory)} (${code}).` };
    case "ENOSPC":
    case "EDQUOT":
      return { code: "internal-error", message: `There is no room left for ${target.display} (${code}). Nothing was published.` };
    default:
      return {
        code: "internal-error",
        message: `Writing ${target.display} failed (${code ?? (error instanceof Error ? error.message : "unknown error")}). Nothing was published.`,
      };
  }
}

/** Everything before the last slash; a relative name never reaches here. */
function parentOf(bytes: Buffer): Buffer {
  const last = bytes.lastIndexOf(SLASH);
  return last <= 0 ? Buffer.from("/") : bytes.subarray(0, last);
}

function display(bytes: Buffer): string {
  return rawPathFromBytes(bytes).display;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}
