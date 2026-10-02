import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { handshakeRequest, parseHandshakeResponse } from "../../dist/native/protocol.js";
import { compileBundle } from "../support/schemas.mjs";

const nativeSchemas = compileBundle("schemas/native/v1");

const binary = resolve("native/disktop-fs/target/debug/disktop-fs");

function exchange(requests) {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Native helper exited ${code}: ${stderr}`));
        return;
      }
      resolveOutput(stdout.trim().split("\n").map((line) => JSON.parse(line)));
    });
    child.stdin.end(requests.map((request) => `${JSON.stringify(request)}\n`).join(""));
  });
}

test("native hello reports only the implemented operations", async () => {
  const [response] = await exchange([handshakeRequest("hello-1")]);
  const result = parseHandshakeResponse(JSON.stringify(response), "hello-1");
  assert.deepEqual(result.supportedOperations, ["hello", "probe", "cancel", "scan", "query-index", "hash-candidates", "inspect", "trash", "erase", "empty-trash", "restore", "dedup-hardlink", "copy-move", "compress", "journal-reconcile"]);
  // Trash is implemented; the operations whose phase has not arrived are not
  // listed, so a client cannot discover one by name and assume it works.
  for (const implemented of ["trash", "erase", "empty-trash", "restore", "dedup-hardlink", "copy-move", "compress"]) {
    assert.equal(result.supportedOperations.includes(implemented), true);
  }
  for (const mutation of ["manager-begin", "manager-append", "manager-finish"]) {
    assert.equal(result.supportedOperations.includes(mutation), false);
  }
  assert.equal(typeof result.kernelCapabilities.openat2.available, "boolean");
});

test("native helper rejects an operation this build does not implement, without changing a file", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "disktop-native-test-"));
  const target = join(sandbox, "keep-me.txt");
  try {
    await writeFile(target, "data stays here\n");
    const [response] = await exchange([{
      protocolVersion: 1,
      requestId: "manager-1",
      operation: "manager-begin",
      arguments: { path: target },
    }]);
    assert.equal(response.event, "error");
    assert.equal(response.error.code, "unsupported-operation");
    assert.equal(await readFile(target, "utf8"), "data stays here\n");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("every line the helper writes validates against the v1 event schema", async () => {
  const event = nativeSchemas.get("event");
  const helloResult = nativeSchemas.get("hello-result");
  const responses = await exchange([
    handshakeRequest("hello-1"),
    { protocolVersion: 1, requestId: "cancel-1", operation: "cancel", arguments: { cancelRequestId: "hello-1" } },
    { protocolVersion: 2, requestId: "old-client", operation: "hello", arguments: {} },
  ]);

  assert.equal(responses.length, 3);
  for (const response of responses) {
    assert.ok(event(response), `${JSON.stringify(response)}: ${JSON.stringify(event.errors)}`);
  }
  assert.ok(helloResult(responses[0]), JSON.stringify(helloResult.errors));
  // Cancelling a request that already finished is refused by name rather than
  // answered as though something was stopped.
  assert.equal(responses[1].error.code, "unknown-request");
  assert.equal(responses[2].error.code, "unsupported-protocol-version");
});
