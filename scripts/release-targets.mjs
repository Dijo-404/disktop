/**
 * The four helper binaries a release packages, and how each is built.
 *
 * `name` is the suffix `src/native/locator.ts` selects at run time, so the file
 * in `vendor/bin/` is `disktop-fs-<name>`. `tests/unit/release-contract.test.mjs`
 * fails if this list, the locator, or either workflow names a different set.
 *
 * The glibc builds link against glibc 2.28 symbols at most. That is the floor
 * Node 24's own Linux binaries require, so no machine that can run Disktop's
 * JavaScript is refused by its helper. The musl builds are static and run on
 * any Linux kernel of their architecture.
 */
export const GLIBC_FLOOR = "2.28";

export const CHECKSUM_FILE = "SHA256SUMS";

export const RELEASE_TARGETS = Object.freeze([
  { name: "linux-x64-gnu", arch: "x64", libc: "gnu", rustTarget: "x86_64-unknown-linux-gnu", elfMachine: 62, interpreter: "/lib64/ld-linux-x86-64.so.2" },
  { name: "linux-x64-musl", arch: "x64", libc: "musl", rustTarget: "x86_64-unknown-linux-musl", elfMachine: 62, interpreter: null },
  { name: "linux-arm64-gnu", arch: "arm64", libc: "gnu", rustTarget: "aarch64-unknown-linux-gnu", elfMachine: 183, interpreter: "/lib/ld-linux-aarch64.so.1" },
  { name: "linux-arm64-musl", arch: "arm64", libc: "musl", rustTarget: "aarch64-unknown-linux-musl", elfMachine: 183, interpreter: null },
]);

export function binaryName(target) {
  return `disktop-fs-${target.name}`;
}

/** What `cargo zigbuild` is asked for: a gnu target carries the glibc floor as a suffix. */
export function zigTarget(target) {
  return target.libc === "gnu" ? `${target.rustTarget}.${GLIBC_FLOOR}` : target.rustTarget;
}

/**
 * The target this machine runs, chosen the same way the locator chooses one.
 * `glibcVersionRuntime` is present only when Node itself runs on glibc.
 */
export function hostTarget() {
  const header = process.report?.getReport()?.header;
  const libc = typeof header?.glibcVersionRuntime === "string" ? "gnu" : "musl";
  return RELEASE_TARGETS.find((target) => target.arch === process.arch && target.libc === libc);
}
