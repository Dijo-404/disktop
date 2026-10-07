/** Wrapper shutdown tests use a local Docker stub and never start a container. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";

const wrapper = new URL("../../tests/support/managers-disposable.mjs", import.meta.url);

async function fixture(t, cleanupFailure = false) {
  const directory = await mkdtemp(join(tmpdir(), "disktop-docker-stub-"));
  const log = join(directory, "calls.jsonl");
  const executable = join(directory, "docker");
  await writeFile(executable, `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
const arguments_ = process.argv.slice(2);
appendFileSync(process.env.DISKTOP_DOCKER_STUB_LOG, JSON.stringify(arguments_) + "\\n");
if (arguments_[0] === "cp") writeFileSync(arguments_.at(-1), "fixture runtime");
if (arguments_[0] === "run" && !process.env.DISKTOP_DOCKER_STUB_FAIL_CLEANUP) setInterval(() => {}, 1000);
if (arguments_[0] === "rm" && process.env.DISKTOP_DOCKER_STUB_FAIL_CLEANUP) {
  process.stderr.write("container cleanup denied\\n");
  process.exitCode = 1;
}
`);
  await chmod(executable, 0o755);
  const child = spawn(process.execPath, [wrapper.pathname, "apt"], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, DISKTOP_DOCKER_STUB_LOG: log,
      ...(cleanupFailure ? { DISKTOP_DOCKER_STUB_FAIL_CLEANUP: "1" } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk).slice(-8192); });
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await done;
    await rm(directory, { recursive: true, force: true });
  });
  async function calls() {
    try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  return { child, done, calls, output: () => output };
}

for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
  test(`the disposable gate removes both containers and its runtime on ${signal}`, { timeout: 10_000 }, async (t) => {
    const gate = await fixture(t);
    const deadline = Date.now() + 5000;
    while (!(await gate.calls()).some((call) => call[0] === "run")) {
      assert.ok(Date.now() < deadline, "the Docker fixture never reached its running state");
      await setTimeout(20);
    }
    gate.child.kill(signal);
    assert.equal(await gate.done, status, gate.output());
    const calls = await gate.calls();
    const runtime = calls.find((call) => call[0] === "create")[2];
    const running = calls.find((call) => call[0] === "run");
    const container = running[running.indexOf("--name") + 1];
    assert.deepEqual(calls.filter((call) => call[0] === "rm"), [["rm", "--force", container], ["rm", "--force", runtime]]);
    await assert.rejects(access(calls.find((call) => call[0] === "cp").at(-1)), { code: "ENOENT" });
  });
}

test("a disposable gate cleanup failure is reported and all cleanup is attempted", { timeout: 10_000 }, async (t) => {
  const gate = await fixture(t, true);
  assert.equal(await gate.done, 1);
  assert.match(gate.output(), /Disposable manager gate cleanup failed/);
  assert.match(gate.output(), /container cleanup denied/);
  const calls = await gate.calls();
  assert.equal(calls.filter((call) => call[0] === "rm").length, 2);
  await assert.rejects(access(calls.find((call) => call[0] === "cp").at(-1)), { code: "ENOENT" });
});
