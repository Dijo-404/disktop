import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capability } from "../domain/models.js";

export type HelperIntegrity = "checksum-verified" | "development-build";

export interface HelperLocation {
  readonly executablePath: string;
  readonly target: string;
  readonly integrity: HelperIntegrity;
}

export type HelperLookup =
  | { readonly found: true; readonly location: HelperLocation }
  | { readonly found: false; readonly capability: Capability };

const ARCHITECTURES: Readonly<Record<string, string>> = { x64: "x64", arm64: "arm64" };

/** Where the packaged binaries and their recorded checksums live in the tarball. */
const VENDOR_DIRECTORY = new URL("../../vendor/bin/", import.meta.url);
const CHECKSUM_FILE = "checksums.json";

/**
 * The locally built helper. `npm run build:native` produces it, and it never
 * ships: a packaged install has no `native/` directory to fall back to.
 */
const DEVELOPMENT_BINARY = new URL("../../native/disktop-fs/target/debug/disktop-fs", import.meta.url);

export function helperTarget(architecture: string = process.arch, libc: string = detectLibc()): string | undefined {
  const mapped = ARCHITECTURES[architecture];
  return mapped === undefined ? undefined : `linux-${mapped}-${libc}`;
}

/**
 * glibc builds report their runtime version; a musl build reports nothing. The
 * answer only selects which packaged binary to run, and a wrong pick fails the
 * handshake rather than running anything unexpected.
 */
export function detectLibc(): "glibc" | "musl" {
  const header = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return typeof header?.header?.glibcVersionRuntime === "string" ? "glibc" : "musl";
}

/**
 * Find the helper for this machine and prove it is the binary that was packaged.
 *
 * A packaged binary is accepted only when its recorded SHA-256 matches and it is
 * executable. There is no fallback that compiles, downloads, or runs an
 * unverified binary; if nothing matches, the caller gets a capability state.
 *
 * `target` is required, and `undefined` means this machine has no supported
 * target. It is not a request to detect one: a caller that meant to detect
 * passes `helperTarget()`, and the two must not look alike.
 */
export async function locateHelper(
  target: string | undefined,
  vendorDirectory: URL = VENDOR_DIRECTORY,
): Promise<HelperLookup> {
  if (target === undefined) {
    return {
      found: false,
      capability: {
        status: "unsupported-architecture",
        explanation: `Disktop packages a helper for x86-64 and ARM64 only; this process runs on ${process.arch}.`,
      },
    };
  }

  const packaged = posix.join(fileURLToPath(vendorDirectory), `disktop-fs-${target}`);
  const packagedCheck = await verifyPackaged(packaged, target, fileURLToPath(vendorDirectory));
  if (packagedCheck !== undefined) {
    return packagedCheck;
  }

  const development = fileURLToPath(DEVELOPMENT_BINARY);
  if (await isExecutableFile(development)) {
    return { found: true, location: { executablePath: development, target, integrity: "development-build" } };
  }

  return {
    found: false,
    capability: {
      status: "unsupported-architecture",
      explanation: `No helper binary for ${target} was found in this installation. Scans and cleanup are unavailable; inventory does not need the helper.`,
    },
  };
}

async function verifyPackaged(path: string, target: string, vendorDirectory: string): Promise<HelperLookup | undefined> {
  if (!(await isExecutableFile(path))) {
    return undefined;
  }

  const expected = await recordedChecksum(posix.join(vendorDirectory, CHECKSUM_FILE), target);
  if (expected === undefined) {
    return {
      found: false,
      capability: {
        status: "unsupported-architecture",
        explanation: `The helper for ${target} has no recorded checksum in ${CHECKSUM_FILE}, so it is not run.`,
      },
    };
  }

  const actual = createHash("sha256").update(await readFile(path)).digest("hex");
  if (actual !== expected) {
    return {
      found: false,
      capability: {
        status: "unsupported-architecture",
        explanation: `The helper for ${target} does not match its recorded checksum and is not run.`,
      },
    };
  }

  return { found: true, location: { executablePath: path, target, integrity: "checksum-verified" } };
}

async function recordedChecksum(checksumPath: string, target: string): Promise<string | undefined> {
  try {
    const document: unknown = JSON.parse(await readFile(checksumPath, "utf8"));
    if (typeof document !== "object" || document === null) {
      return undefined;
    }
    const value = (document as Record<string, unknown>)[`disktop-fs-${target}`];
    return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return false;
    }
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
