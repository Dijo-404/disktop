import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, stat } from "node:fs/promises";
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

/**
 * Every helper a release packages. Each is `vendor/bin/disktop-fs-<target>`,
 * and `scripts/build-release.mjs`, both workflows, and ADR 0003 name the same
 * four; `tests/unit/release-contract.test.mjs` fails if any of them drifts.
 */
export const HELPER_TARGETS = ["linux-x64-gnu", "linux-x64-musl", "linux-arm64-gnu", "linux-arm64-musl"] as const;

export type HelperTarget = (typeof HELPER_TARGETS)[number];

/**
 * The recorded checksums, in exactly the format `sha256sum` writes and
 * `sha256sum --check --strict` reads, so a person can verify an install with
 * the tool they already have.
 */
export const CHECKSUM_FILE = "SHA256SUMS";

/** Four lines of about a hundred bytes each; anything much larger is not ours. */
const CHECKSUM_FILE_MAX_BYTES = 4096;

const ARCHITECTURES: Readonly<Record<string, string>> = { x64: "x64", arm64: "arm64" };

/** One `sha256sum` line: digest, a space, the text or binary mode mark, the name. */
const CHECKSUM_LINE = /^([0-9a-f]{64}) [ *](disktop-fs-linux-(?:x64|arm64)-(?:gnu|musl))$/;

/** Where the packaged binaries and their recorded checksums live in the tarball. */
const VENDOR_DIRECTORY = new URL("../../vendor/bin/", import.meta.url);

/**
 * The locally built helper. `npm run build:native` produces it, and it never
 * ships: a packaged install has no `native/` directory to fall back to.
 */
const DEVELOPMENT_BINARY = new URL("../../native/disktop-fs/target/debug/disktop-fs", import.meta.url);

export function helperBinaryName(target: string): string {
  return `disktop-fs-${target}`;
}

export function helperTarget(architecture: string = process.arch, libc: string = detectLibc()): HelperTarget | undefined {
  const mapped = ARCHITECTURES[architecture];
  if (mapped === undefined) {
    return undefined;
  }
  const target = `linux-${mapped}-${libc}`;
  return (HELPER_TARGETS as readonly string[]).includes(target) ? (target as HelperTarget) : undefined;
}

/**
 * glibc builds report their runtime version; a musl build reports nothing. The
 * answer only selects which packaged binary to run, and a wrong pick fails the
 * handshake rather than running anything unexpected.
 */
export function detectLibc(): "gnu" | "musl" {
  const header = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return typeof header?.header?.glibcVersionRuntime === "string" ? "gnu" : "musl";
}

/**
 * Read a `SHA256SUMS` file, or refuse it whole.
 *
 * Every line must be one digest for one packaged helper name, each name at
 * most once, and the file must end with the newline `sha256sum` writes. One
 * line that is anything else makes the whole file unreadable rather than
 * partly trusted: a list somebody edited is not evidence about any binary.
 */
export function parseChecksums(text: string): ReadonlyMap<string, string> | undefined {
  if (text.length === 0 || !text.endsWith("\n")) {
    return undefined;
  }
  const recorded = new Map<string, string>();
  for (const line of text.slice(0, -1).split("\n")) {
    const match = CHECKSUM_LINE.exec(line);
    if (match === null) {
      return undefined;
    }
    const [, digest, name] = match as unknown as [string, string, string];
    if (recorded.has(name) || !(HELPER_TARGETS as readonly string[]).includes(name.slice("disktop-fs-".length))) {
      return undefined;
    }
    recorded.set(name, digest);
  }
  return recorded;
}

/**
 * Find the helper for this machine and prove it is the binary that was packaged.
 *
 * A packaged binary is accepted only when it is a regular executable file and
 * its SHA-256 matches the line `SHA256SUMS` records for it. A packaged binary
 * that fails any of that is refused outright; it never falls through to
 * another binary. There is no fallback that compiles, downloads, or runs an
 * unverified binary; if nothing matches, the caller gets a capability state.
 *
 * The check is about the installation at rest, damaged or altered after it
 * was packed. Whoever can write into the installation while Disktop runs can
 * also rewrite this file, so it does not try to be a boundary against them.
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
        explanation: `Disktop packages a helper for x86-64 and ARM64 Linux only; this process runs on ${process.arch}.`,
      },
    };
  }

  const directory = fileURLToPath(vendorDirectory);
  const packagedCheck = await verifyPackaged(posix.join(directory, helperBinaryName(target)), target, directory);
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

/** `undefined` only when no packaged binary exists for this target at all. */
async function verifyPackaged(path: string, target: string, vendorDirectory: string): Promise<HelperLookup | undefined> {
  const refuse = (explanation: string): HelperLookup => ({
    found: false,
    capability: { status: "unsupported-architecture", explanation: `${explanation} Reinstall Disktop to restore it.` },
  });

  let entry;
  try {
    entry = await lstat(path);
  } catch {
    return undefined;
  }
  if (!entry.isFile()) {
    return refuse(`The packaged helper for ${target} is not a regular file, so it is not run.`);
  }
  try {
    await access(path, constants.X_OK);
  } catch {
    return refuse(`The packaged helper for ${target} is not executable, so it is not run.`);
  }

  const recorded = await readChecksums(posix.join(vendorDirectory, CHECKSUM_FILE));
  if (recorded === "malformed") {
    return refuse(`${CHECKSUM_FILE} in this installation is not a well-formed checksum list, so the helper for ${target} is not run.`);
  }
  const expected = recorded?.get(helperBinaryName(target));
  if (expected === undefined) {
    return refuse(`The helper for ${target} has no recorded checksum in ${CHECKSUM_FILE}, so it is not run.`);
  }

  const actual = createHash("sha256").update(await readFile(path)).digest("hex");
  if (actual !== expected) {
    return refuse(`The helper for ${target} does not match its recorded checksum in ${CHECKSUM_FILE} and is not run; the installation was altered or damaged after it was packed.`);
  }

  return { found: true, location: { executablePath: path, target, integrity: "checksum-verified" } };
}

async function readChecksums(path: string): Promise<ReadonlyMap<string, string> | "malformed" | undefined> {
  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > CHECKSUM_FILE_MAX_BYTES) {
      return "malformed";
    }
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  return parseChecksums(text) ?? "malformed";
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
