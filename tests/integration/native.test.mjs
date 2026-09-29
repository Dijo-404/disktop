import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { handshakeRequest, parseHandshakeResponse } from "../../dist/native/protocol.js";

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
  assert.deepEqual(result.supportedOperations, ["hello", "probe"]);
  assert.equal(typeof result.kernelCapabilities.openat2.available, "boolean");
});

test("native helper rejects a planned destructive operation without changing a file", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "disktop-native-test-"));
  const target = join(sandbox, "keep-me.txt");
  try {
    await writeFile(target, "data stays here\n");
    const [response] = await exchange([{
      protocolVersion: 1,
      requestId: "trash-1",
      operation: "trash",
      arguments: { path: target },
    }]);
    assert.equal(response.event, "error");
    assert.equal(response.error.code, "unsupported-operation");
    assert.equal(await readFile(target, "utf8"), "data stays here\n");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
