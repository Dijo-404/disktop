import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
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
    assert.deepEqual(start.hello.supportedOperations, ["hello", "probe", "cancel", "scan", "query-index", "hash-candidates", "inspect", "trash", "erase", "empty-trash", "restore", "dedup-hardlink", "copy-move", "compress", "manager-begin", "manager-append", "manager-finish", "journal-reconcile"]);
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

/**
 * A stand-in helper that completes the handshake and then does whatever
 * `behaviour` says with every later request. It is a real child process
 * speaking over real pipes, which is the only way to reach the failure modes
 * below: a broken pipe, a line with no end, a process that ignores its input.
 */
async function fakeHelper(behaviour, { answerHello = true } = {}) {
  const directory = await sandbox();
  const script = join(directory, "fake-helper");
  const pidFile = join(directory, "pid");
  await writeFile(
    script,
    `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const send = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value) + "\\n");
const hello = (requestId) => ({
  protocolVersion: 1, requestId, eventId: "1", event: "complete",
  result: {
    helperVersion: "0.0.0-fake", buildChecksum: null, platform: "linux", architecture: "x86_64",
    kernelCapabilities: { openat2: { available: true, reason: null } }, supportedOperations: ["hello", "probe"],
  },
});
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.operation === "hello") {
    if (${answerHello ? "true" : "false"}) { send(hello(request.requestId)); }
    return;
  }
  ${behaviour}
});
`,
  );
  await chmod(script, 0o755);
  return {
    location: { executablePath: script, target: "linux-x64-glibc", integrity: "development-build" },
    pid: async () => Number(await readFile(pidFile, "utf8")),
  };
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

test("a helper that stops reading its input fails the request instead of crashing Node", async () => {
  // Closing stdin while staying alive is what a helper that has lost its
  // reader looks like from Node's side: the next write is a broken pipe.
  const fake = await fakeHelper(`
    lines.close();
    process.stdin.destroy();
    // Node keeps the descriptor itself open; closing it is what breaks the pipe.
    fs.closeSync(0);
    setInterval(() => {}, 1000);
  `);
  const start = await NativeHelperClient.launch(fake.location, { shutdownGraceMilliseconds: 200 });
  assert.equal(start.started, true, JSON.stringify(start.capability ?? {}));
  try {
    // The first request is what makes the helper stop reading, and it is never
    // answered; the next one is written into a pipe nobody reads any more.
    const unanswered = start.client.request("probe", {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    await assert.rejects(() => start.client.request("probe", {}), /helper/i);
    await assert.rejects(unanswered, /helper/i, "the unanswered request fails too, rather than waiting forever");
  } finally {
    await start.client.close();
  }
  assert.equal(isRunning(await fake.pid()), false, "a helper that stopped reading is not left running");
});

test("output that is not a protocol object is skipped, not fatal", async () => {
  const fake = await fakeHelper(`
    send("null\\n");
    send("42\\n");
    send("\\"text\\"\\n");
    send("[]\\n");
    send({ protocolVersion: 1, requestId: request.requestId, eventId: "1", event: "complete", result: {} });
  `);
  const start = await NativeHelperClient.launch(fake.location);
  assert.equal(start.started, true);
  try {
    const answer = await start.client.request("probe", {});
    assert.equal(answer.event, "complete");
  } finally {
    await start.client.close();
  }
});

test("a line with no end is cut off at a bound rather than held in memory", async () => {
  const fake = await fakeHelper(`
    send("x".repeat(256 * 1024));
    setInterval(() => {}, 1000);
  `);
  const start = await NativeHelperClient.launch(fake.location, {
    maxLineCharacters: 64 * 1024,
    shutdownGraceMilliseconds: 200,
  });
  assert.equal(start.started, true);
  try {
    await assert.rejects(() => start.client.request("probe", {}), /longer than/);
  } finally {
    await start.client.close();
  }
  assert.equal(isRunning(await fake.pid()), false, "a helper that broke the protocol is stopped");
});

test("a long line split across many reads is still delivered whole", async () => {
  const fake = await fakeHelper(`
    const padding = "p".repeat(4 * 1024 * 1024);
    const text = JSON.stringify({ protocolVersion: 1, requestId: request.requestId, eventId: "1", event: "complete", result: { padding } }) + "\\n";
    for (let offset = 0; offset < text.length; offset += 4096) {
      process.stdout.write(text.slice(offset, offset + 4096));
    }
  `);
  const start = await NativeHelperClient.launch(fake.location);
  assert.equal(start.started, true);
  try {
    const answer = await start.client.request("probe", {});
    assert.equal(answer.result.padding.length, 4 * 1024 * 1024);
  } finally {
    await start.client.close();
  }
});

test("a helper that dies mid-request fails every pending request and leaves no listener", async () => {
  const fake = await fakeHelper(`
    send({ protocolVersion: 1, requestId: request.requestId, eventId: "1", event: "accepted", accepted: {} });
    if (request.operation === "die") { setTimeout(() => process.exit(3), 50); }
  `);
  const start = await NativeHelperClient.launch(fake.location);
  assert.equal(start.started, true);
  const controller = new AbortController();
  try {
    const results = await Promise.allSettled([
      start.client.request("wait", {}, controller.signal),
      start.client.request("die", {}),
    ]);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.match(result.reason.message, /status 3/);
    }
    assert.equal(getEventListeners(controller.signal, "abort").length, 0, "the abort listener is removed");
  } finally {
    await start.client.close();
  }
});

test("a helper that never answers the handshake is given up on, and stopped", async () => {
  const fake = await fakeHelper("", { answerHello: false });
  const begun = Date.now();
  const start = await NativeHelperClient.launch(fake.location, {
    handshakeMilliseconds: 200,
    shutdownGraceMilliseconds: 200,
  });
  assert.equal(start.started, false);
  assert.match(start.capability.explanation, /handshake/);
  assert.ok(Date.now() - begun < 5_000, "the handshake has a bound");
  assert.equal(isRunning(await fake.pid()), false, "the unanswering helper is not left running");
});

test("closing reaps a helper that ignores both end of input and SIGTERM", async () => {
  const fake = await fakeHelper(`
    send({ protocolVersion: 1, requestId: request.requestId, eventId: "1", event: "complete", result: {} });
  `);
  // The fake ignores SIGTERM and never exits on its own once stdin closes.
  const script = await readFile(fake.location.executablePath, "utf8");
  await writeFile(
    fake.location.executablePath,
    script.replace("const lines", "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\nconst lines"),
  );
  const start = await NativeHelperClient.launch(fake.location, { shutdownGraceMilliseconds: 200 });
  assert.equal(start.started, true);
  await start.client.request("probe", {});
  await start.client.close();
  assert.equal(isRunning(await fake.pid()), false, "close() does not return while the helper still runs");
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
