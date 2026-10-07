import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { NativeHelperClient } from "../../dist/native/client.js";
import { createNativeScanner } from "../../dist/platform/linux/scan/index.js";
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

test("cancelling a blocked index query kills and reaps only its dedicated read-only helper", async () => {
  const marker = join(await sandbox(), "query-started");
  const fake = await fakeHelper(`
    if (request.operation === "query-index") {
      fs.writeFileSync(${JSON.stringify(marker)}, "started");
      lines.close();
      process.stdin.pause();
      setInterval(() => {}, 1000);
    }
  `);
  const scanner = createNativeScanner({
    indexDirectory: "/tmp/disktop-query-test",
    start: () => NativeHelperClient.launch(fake.location, { shutdownGraceMilliseconds: 100 }),
  });
  const controller = new AbortController();
  const begun = Date.now();
  const request = scanner.query({ scanId: "scan-1", filter: {}, sort: "allocated", order: "descending", limit: 1 }, controller.signal);
  const rejected = assert.rejects(request, { name: "AbortError" });
  try {
    const deadline = Date.now() + 2000;
    for (;;) {
      try { await readFile(marker); break; }
      catch (error) {
        if (error.code !== "ENOENT" || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  } finally {
    controller.abort();
    await rejected;
  }
  assert.ok(Date.now() - begun < 2000, "query cancellation must be bounded despite an ignored protocol cancel");
  assert.equal(isRunning(await fake.pid()), false, "the query helper is reaped before cancellation completes");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

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

test("the helper is in its own process group, and still ends when Disktop is killed outright", async () => {
  // A child Node process starts the real helper on a long scan, says the
  // helper's pid, and is then SIGKILLed: nothing of it runs to close anything.
  const script = `
    import { NativeHelperClient } from "./dist/native/client.js";
    import { readFileSync, readdirSync } from "node:fs";
    const start = await NativeHelperClient.start();
    if (!start.started) { console.log("NOSTART " + start.capability.explanation); process.exit(1); }
    const children = readdirSync("/proc/self/task").flatMap((task) => readFileSync("/proc/self/task/" + task + "/children", "utf8").trim().split(/\\s+/)).filter(Boolean);
    const indexDirectory = Buffer.from(process.argv[1]).toString("base64");
    void start.client.request("scan", { roots: [Buffer.from("/usr").toString("base64")], crossFilesystems: false, excludes: [], accounting: "allocated", indexDirectory }).catch(() => {});
    console.log("PIDS " + children.join(","));
    setInterval(() => {}, 1000);
  `;
  const directory = await sandbox();
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, join(directory, "index")], { cwd: process.cwd() });
  const pids = await new Promise((resolve, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
      const match = /PIDS ([\d,]+)/.exec(output);
      if (match) resolve(match[1].split(",").map(Number));
      if (output.includes("NOSTART")) reject(new Error(output));
    });
    child.on("error", reject);
  });
  const helper = pids[0];
  const groupOf = (pid) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[2]);
  assert.notEqual(groupOf(helper), groupOf(child.pid), "the helper is not in the client's process group");
  assert.equal(groupOf(helper), helper, "it leads its own");

  child.kill("SIGKILL");
  const deadline = Date.now() + 15_000;
  while (isRunning(helper) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(isRunning(helper), false, "the helper saw its stdin close and ended");
});

test("an already cancelled request never reaches the helper", async () => {
  const fake = await fakeHelper(`
    send({ protocolVersion: 1, requestId: request.requestId, eventId: "2", event: "complete", result: { operation: request.operation } });
  `);
  const start = await NativeHelperClient.launch(fake.location);
  assert.equal(start.started, true);
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(() => start.client.request("trash", {}, controller.signal), /abort/i);
    const answer = await start.client.request("probe", {});
    assert.equal(answer.requestId, "probe-2", "no request id was assigned to the cancelled action");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    await start.client.close();
  }
});

test("a paused event consumer retains only the latest progress reading", async () => {
  const fake = await fakeHelper(`
    if (request.operation === "burst") {
      send({ protocolVersion: 1, requestId: request.requestId, eventId: "2", event: "accepted", accepted: {} });
      for (let index = 0; index < 5000; index += 1) {
        send({ protocolVersion: 1, requestId: request.requestId, eventId: String(index + 3), event: "progress", progress: { index, padding: "p".repeat(1024) } });
      }
    }
    send({ protocolVersion: 1, requestId: request.requestId, eventId: "6000", event: "complete", result: {} });
  `);
  const start = await NativeHelperClient.launch(fake.location);
  assert.equal(start.started, true);
  try {
    const stream = start.client.stream("burst", {});
    const first = await stream.next();
    assert.equal(first.value.event, "accepted");
    // The probe's response follows every burst event on the same stdout pipe,
    // so this waits until all progress arrived while the consumer was paused.
    await start.client.request("probe", {});
    const remaining = [];
    for await (const event of stream) remaining.push(event);
    assert.deepEqual(remaining.map((event) => event.event), ["progress", "complete"]);
    assert.equal(remaining[0].progress.index, 4999);
  } finally {
    await start.client.close();
  }
});

test("returning from an action stream cancels and waits for the journalled outcome", async () => {
  const fake = await fakeHelper(`
    if (request.operation === "cancel") {
      setTimeout(() => send({ protocolVersion: 1, requestId: request.arguments.cancelRequestId, eventId: "3", event: "complete", result: { journalled: true } }), 50);
    } else {
      send({ protocolVersion: 1, requestId: request.requestId, eventId: "2", event: "accepted", accepted: {} });
    }
  `);
  const start = await NativeHelperClient.launch(fake.location);
  assert.equal(start.started, true);
  try {
    const controller = new AbortController();
    const stream = start.client.stream("trash", {}, controller.signal);
    assert.equal((await stream.next()).value.event, "accepted");
    const began = Date.now();
    await stream.return();
    assert.ok(Date.now() - began >= 40, "return waits for the terminal outcome instead of abandoning the action");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    await start.client.close();
  }
});

test("an invalid event for an active request fails explicitly instead of hanging", async () => {
  const fake = await fakeHelper(`
    send({ protocolVersion: 99, requestId: request.requestId, eventId: "2", event: "complete", result: {} });
  `);
  const start = await NativeHelperClient.launch(fake.location);
  assert.equal(start.started, true);
  try {
    await assert.rejects(() => start.client.request("probe", {}), /invalid protocol event/);
  } finally {
    await start.client.close();
  }
});

test("pipe backpressure preserves every durable item outcome", async () => {
  const fake = await fakeHelper(`
    send({ protocolVersion: 1, requestId: request.requestId, eventId: "2", event: "accepted", accepted: {} });
    for (let index = 0; index < 2000; index += 1) {
      send({ protocolVersion: 1, requestId: request.requestId, eventId: String(index + 3), event: "item-result", itemResult: { path: String(index), outcome: "completed" } });
    }
    send({ protocolVersion: 1, requestId: request.requestId, eventId: "3000", event: "complete", result: {} });
  `);
  const start = await NativeHelperClient.launch(fake.location);
  assert.equal(start.started, true);
  try {
    let items = 0;
    for await (const event of start.client.stream("trash", {})) {
      if (event.event === "item-result") {
        assert.equal(event.itemResult.path, String(items));
        items += 1;
      }
    }
    assert.equal(items, 2000);
  } finally {
    await start.client.close();
  }
});

test("leaving an event stream drains a backpressured action without hanging", async () => {
  const fake = await fakeHelper(`
    if (request.operation === "cancel") return;
    send({ protocolVersion: 1, requestId: request.requestId, eventId: "2", event: "accepted", accepted: {} });
    for (let index = 0; index < 2000; index += 1) {
      send({ protocolVersion: 1, requestId: request.requestId, eventId: String(index + 3), event: "item-result", itemResult: { path: String(index), outcome: "completed" } });
    }
    send({ protocolVersion: 1, requestId: request.requestId, eventId: "3000", event: "complete", result: {} });
  `);
  const start = await NativeHelperClient.launch(fake.location);
  assert.equal(start.started, true);
  try {
    const stream = start.client.stream("trash", {});
    assert.equal((await stream.next()).value.event, "accepted");
    await stream.return();
  } finally {
    await start.client.close();
  }
});
