import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { NativeHelperClient } from "../../dist/native/client.js";
import { helperTarget, locateHelper } from "../../dist/native/locator.js";

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
    assert.deepEqual(start.hello.supportedOperations, ["hello", "probe", "cancel", "scan", "query-index", "trash", "journal-reconcile"]);
    assert.equal(typeof start.hello.kernelCapabilities.openat2.available, "boolean");
    assert.equal(start.hello.platform, "linux");
    // A locally built helper reports no checksum rather than inventing one.
    assert.equal(start.location.integrity, "development-build");
    assert.equal(start.hello.buildChecksum, null);
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
      start.client.request("erase", { path: "L3RtcA==" }),
    ]);
    assert.equal(probe.event, "complete");
    assert.match(probe.requestId, /^probe-/);
    assert.equal(refused.event, "error");
    assert.match(refused.requestId, /^erase-/);
    assert.equal(refused.error.code, "unsupported-operation");
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

test("a packaged helper runs only when its recorded checksum matches", async () => {
  const directory = await sandbox();
  const target = helperTarget() ?? "linux-x64-glibc";
  const binary = join(directory, `disktop-fs-${target}`);
  const contents = await readFile("native/disktop-fs/target/debug/disktop-fs");

  await writeFile(binary, contents);
  await chmod(binary, 0o755);

  // No recorded checksum: refused rather than trusted.
  const unrecorded = await locateHelper(target, vendorUrl(directory));
  assert.equal(unrecorded.found, false);
  assert.match(unrecorded.capability.explanation, /no recorded checksum/);

  // A recorded checksum that does not match: refused.
  await writeFile(join(directory, "checksums.json"), JSON.stringify({ [`disktop-fs-${target}`]: "0".repeat(64) }));
  const mismatched = await locateHelper(target, vendorUrl(directory));
  assert.equal(mismatched.found, false);
  assert.match(mismatched.capability.explanation, /does not match its recorded checksum/);

  // The real checksum: accepted and marked verified.
  const digest = createHash("sha256").update(contents).digest("hex");
  await writeFile(join(directory, "checksums.json"), JSON.stringify({ [`disktop-fs-${target}`]: digest }));
  const verified = await locateHelper(target, vendorUrl(directory));
  assert.equal(verified.found, true);
  assert.equal(verified.location.integrity, "checksum-verified");
  assert.equal(verified.location.executablePath, binary);
});

test("a helper that is not executable is not run", async () => {
  const directory = await sandbox();
  const target = helperTarget() ?? "linux-x64-glibc";
  const binary = join(directory, `disktop-fs-${target}`);
  await writeFile(binary, await readFile("native/disktop-fs/target/debug/disktop-fs"));
  await chmod(binary, 0o644);

  const digest = createHash("sha256").update(await readFile(binary)).digest("hex");
  await writeFile(join(directory, "checksums.json"), JSON.stringify({ [`disktop-fs-${target}`]: digest }));

  const lookup = await locateHelper(target, vendorUrl(directory));
  // It falls through to the development build rather than running a non-executable file.
  assert.notEqual(lookup.found === true && lookup.location.executablePath, binary);
});
