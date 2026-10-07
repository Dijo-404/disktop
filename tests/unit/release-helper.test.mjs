import assert from "node:assert/strict";
import { test } from "node:test";
import { helperHello } from "../../scripts/helper-hello.mjs";

const answer = { protocolVersion: 1, requestId: "release-hello", event: "complete", result: { helperVersion: "1.0.0" } };
const fake = (code, options) => helperHello(process.execPath, ["--input-type=module", "-e", code], { timeoutMilliseconds: 2000, ...options });

test("release hello closes input and waits for a clean helper exit", async () => {
  const result = await fake(`process.stdin.once('data', () => process.stdout.write(${JSON.stringify(JSON.stringify(answer) + "\n")})); process.stdin.resume();`);
  assert.deepEqual(result, answer.result);
});

test("release hello refuses unlimited output and reaps the process", async () => {
  await assert.rejects(fake("process.stdin.resume(); setInterval(() => process.stdout.write('x'.repeat(65536)), 1);"), /output limit/);
});

test("release hello refuses an invalid result instead of accepting null", async () => {
  await assert.rejects(fake(`process.stdin.once('data', () => process.stdout.write(${JSON.stringify(JSON.stringify({ ...answer, result: null }) + "\n")})); process.stdin.resume();`), /refused hello/);
});

test("release hello reports malformed JSON values without throwing in a stream listener", async () => {
  for (const value of ["null", "42", "[]", "not-json"]) {
    await assert.rejects(fake(`process.stdin.once('data', () => process.stdout.write(${JSON.stringify(value + "\n")})); process.stdin.resume();`), /not a protocol message/);
  }
});

test("release hello requires the helper to exit after its answer", async () => {
  await assert.rejects(fake(`process.stdin.once('data', () => process.stdout.write(${JSON.stringify(JSON.stringify(answer) + "\n")})); setInterval(() => {}, 1000);`, { timeoutMilliseconds: 150 }), /did not finish hello/);
});

test("release hello handles early process and input closure", async () => {
  await assert.rejects(fake("process.stdin.destroy(); process.exit(1);"), /EPIPE|without answering hello/);
});
