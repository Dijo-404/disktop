import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { NativeHelperClient } from "../../dist/native/client.js";
import { CHECKSUM_FILE, helperBinaryName, helperTarget, locateHelper } from "../../dist/native/locator.js";

async function sandbox() {
  return mkdtemp(join(tmpdir(), "disktop-locator-"));
}

function vendorUrl(directory) {
  return pathToFileURL(`${directory}/`);
}

test("the handshake reports the helper's own version and kernel probe", async () => {
  const start = await NativeHelperClient.start();
  assert.equal(start.started, true, `helper did not start: ${JSON.stringify(start.capability ?? {})}`);
  try {
    assert.deepEqual(start.hello.supportedOperations, ["hello", "probe", "cancel", "scan", "query-index", "hash-candidates", "inspect", "trash", "erase", "empty-trash", "restore", "dedup-hardlink", "copy-move", "compress", "manager-begin", "manager-append", "manager-finish", "journal-reconcile"]);
    assert.equal(typeof start.hello.kernelCapabilities.openat2.available, "boolean");
    assert.equal(start.hello.platform, "linux");
    // A locally built helper reports no checksum rather than inventing one. A
    // release binary that scripts/build-release.mjs put in vendor/bin is found
    // first, exactly as in an installed package, and carries the one it was
    // built with.
    if (start.location.integrity === "development-build") {
      assert.equal(start.hello.buildChecksum, null);
    } else {
      assert.equal(start.location.integrity, "checksum-verified");
      assert.match(start.hello.buildChecksum, /^[0-9a-f]{64}$/);
    }
  } finally {
    await start.client.close();
  }
});

test("responses are matched to their own request, even out of order", async () => {
  const start = await NativeHelperClient.start();
  assert.equal(start.started, true);
  try {
    const [probe, refused] = await Promise.all([
      start.client.request("probe", {}),
      start.client.request("system-prune", { path: "L3RtcA==" }),
    ]);
    assert.equal(probe.event, "complete");
    assert.match(probe.requestId, /^probe-/);
    assert.equal(refused.event, "error");
    assert.match(refused.requestId, /^system-prune-/);
    assert.equal(refused.error.code, "unknown-operation");
  } finally {
    await start.client.close();
  }
});

test("a request after close fails instead of hanging forever", async () => {
  const start = await NativeHelperClient.start();
  assert.equal(start.started, true);
  await start.client.close();
  await assert.rejects(() => start.client.request("probe", {}), /helper/i);
});

test("closing the client ends the child process", async () => {
  const start = await NativeHelperClient.start();
  assert.equal(start.started, true);
  await start.client.close();
  // A second close is harmless, which is what lets a signal handler call it.
  await start.client.close();
});

test("an architecture with no packaged helper is an explicit capability, not a crash", async () => {
  assert.equal(helperTarget("mips64"), undefined);
  // An absent target means this machine has no supported one; it is never read
  // as a request to detect one.
  const missing = await locateHelper(helperTarget("mips64"), vendorUrl(await sandbox()));
  assert.equal(missing.found, false);
  assert.equal(missing.capability.status, "unsupported-architecture");

  // The development build still satisfies a target this machine can run.
  const lookup = await locateHelper(helperTarget(), vendorUrl(await sandbox()));
  assert.equal(lookup.found, true);
  assert.equal(lookup.location.integrity, "development-build");
});

/** The line `sha256sum` writes for one file: digest, two spaces, the name. */
function checksumLine(digest, target) {
  return `${digest}  ${helperBinaryName(target)}\n`;
}

test("a packaged helper runs only when SHA256SUMS records its checksum", async () => {
  const directory = await sandbox();
  const target = helperTarget() ?? "linux-x64-gnu";
  const binary = join(directory, helperBinaryName(target));
  const contents = await readFile("native/disktop-fs/target/debug/disktop-fs");
  const digest = createHash("sha256").update(contents).digest("hex");

  await writeFile(binary, contents);
  await chmod(binary, 0o755);

  // No checksum file: refused rather than trusted, and never handed to the
  // development build instead.
  const unrecorded = await locateHelper(target, vendorUrl(directory));
  assert.equal(unrecorded.found, false);
  assert.match(unrecorded.capability.explanation, /no recorded checksum in SHA256SUMS/);

  // A checksum file that records another target only: refused.
  const other = target === "linux-x64-gnu" ? "linux-arm64-gnu" : "linux-x64-gnu";
  await writeFile(join(directory, CHECKSUM_FILE), checksumLine(digest, other));
  const elsewhere = await locateHelper(target, vendorUrl(directory));
  assert.equal(elsewhere.found, false);
  assert.match(elsewhere.capability.explanation, /no recorded checksum/);

  // A recorded checksum that does not match: refused.
  await writeFile(join(directory, CHECKSUM_FILE), checksumLine("0".repeat(64), target));
  const mismatched = await locateHelper(target, vendorUrl(directory));
  assert.equal(mismatched.found, false);
  assert.equal(mismatched.capability.status, "unsupported-architecture");
  assert.match(mismatched.capability.explanation, /does not match its recorded checksum/);

  // The right digest on a line the strict reader cannot read is no evidence.
  await writeFile(join(directory, CHECKSUM_FILE), `${digest} ${helperBinaryName(target)}\n`);
  const malformed = await locateHelper(target, vendorUrl(directory));
  assert.equal(malformed.found, false);
  assert.match(malformed.capability.explanation, /not a well-formed checksum list/);

  // The old JSON form is not read at all.
  await writeFile(join(directory, CHECKSUM_FILE), JSON.stringify({ [helperBinaryName(target)]: digest }));
  assert.equal((await locateHelper(target, vendorUrl(directory))).found, false);

  // The real checksum, as sha256sum writes it: accepted and marked verified.
  await writeFile(join(directory, CHECKSUM_FILE), checksumLine(digest, target));
  const verified = await locateHelper(target, vendorUrl(directory));
  assert.equal(verified.found, true);
  assert.equal(verified.location.integrity, "checksum-verified");
  assert.equal(verified.location.executablePath, binary);

  // One byte changed after packing: refused, with no fallback.
  await writeFile(binary, Buffer.concat([contents, Buffer.from([0])]));
  const tampered = await locateHelper(target, vendorUrl(directory));
  assert.equal(tampered.found, false);
  assert.match(tampered.capability.explanation, /does not match its recorded checksum/);
});

test("a packaged helper that is not executable is refused, not replaced by another binary", async () => {
  const directory = await sandbox();
  const target = helperTarget() ?? "linux-x64-gnu";
  const binary = join(directory, helperBinaryName(target));
  await writeFile(binary, await readFile("native/disktop-fs/target/debug/disktop-fs"));
  await chmod(binary, 0o644);

  const digest = createHash("sha256").update(await readFile(binary)).digest("hex");
  await writeFile(join(directory, CHECKSUM_FILE), checksumLine(digest, target));

  const lookup = await locateHelper(target, vendorUrl(directory));
  // An unpacker that dropped the mode leaves an install that says so, rather
  // than one that quietly runs the development build or nothing at all.
  assert.equal(lookup.found, false);
  assert.match(lookup.capability.explanation, /not executable/);
});
