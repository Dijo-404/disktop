/** Run one real manager gate in a disposable container; never bind a host cache. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const images = { apt: "ubuntu:24.04", dnf: "fedora:latest", pacman: "archlinux:latest" };
const manager = process.argv[2];
assert.ok(Object.hasOwn(images, manager), "choose exactly apt, dnf, or pacman");
const repository = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const name = `disktop-manager-gate-${randomUUID()}`;
const runtimeContainer = `${name}-runtime`;
const temporary = mkdtempSync(join(tmpdir(), "disktop-manager-runtime-"));
let active;
let interrupted;
let cleaning = false;
function interrupt(signal) {
  if (cleaning || interrupted !== undefined) return;
  interrupted = signal;
  active?.kill("SIGTERM");
}
const onInterrupt = () => interrupt("SIGINT");
const onTerminate = () => interrupt("SIGTERM");
const onHangup = () => interrupt("SIGHUP");
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);
process.on("SIGHUP", onHangup);

async function docker(arguments_, { inherit = false, timeout = 120_000 } = {}) {
  if (interrupted !== undefined && !cleaning) throw new Error(`The manager gate was interrupted by ${interrupted}`);
  const child = spawn("docker", arguments_, { stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
  active = child;
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => { output = (output + chunk.toString()).slice(-8192); });
  }
  let expired = false;
  let forced;
  const timer = setTimeout(() => {
    expired = true;
    child.kill("SIGTERM");
    forced = setTimeout(() => child.kill("SIGKILL"), 5000);
  }, timeout);
  let signalKill;
  const ensureExit = () => {
    if (signalKill === undefined) signalKill = setTimeout(() => child.kill("SIGKILL"), 5000);
  };
  if (!cleaning) {
    process.once("SIGINT", ensureExit);
    process.once("SIGTERM", ensureExit);
    process.once("SIGHUP", ensureExit);
  }
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (expired) throw new Error(`docker ${arguments_[0]} timed out`);
    if (interrupted !== undefined && !cleaning) throw new Error(`The manager gate was interrupted by ${interrupted}`);
    return { code, output };
  } finally {
    active = undefined;
    clearTimeout(timer);
    clearTimeout(forced);
    clearTimeout(signalKill);
    process.removeListener("SIGINT", ensureExit);
    process.removeListener("SIGTERM", ensureExit);
    process.removeListener("SIGHUP", ensureExit);
  }
}

let failure;
try {
  // The host's distro Node may use libraries absent from another image. Extract
  // the supported official Node24 executable for a portable, common runtime.
  for (const arguments_ of [
    ["create", "--name", runtimeContainer, "node:24-bookworm"],
    ["cp", `${runtimeContainer}:/usr/local/bin/node`, join(temporary, "node")],
  ]) {
    const prepared = await docker(arguments_);
    assert.equal(prepared.code, 0, prepared.output);
  }
  const result = await docker([
    "run", "--rm", "--name", name,
    "--mount", `type=bind,source=${repository},target=/workspace/disktop,readonly`,
    "--mount", `type=bind,source=${join(temporary, "node")},target=/run/disktop-gate-node,readonly`,
    "--workdir", "/workspace/disktop", images[manager],
    "sh", "tests/support/managers-disposable-bootstrap.sh", manager,
  ], { inherit: true, timeout: 10 * 60_000 });
  assert.equal(result.code, 0, `the real ${manager} manager gate failed (${result.code})`);
} catch (error) {
  failure = error;
} finally {
  cleaning = true;
  const errors = [];
  // Explicit removal covers interrupted Docker clients and timeouts, as well
  // as ordinary --rm. A missing named container is the only harmless failure.
  for (const container of [name, runtimeContainer]) {
    try {
      const removed = await docker(["rm", "--force", container], { timeout: 15_000 });
      const alreadyRemoved = removed.code === 1 && removed.output.trim() === `Error response from daemon: No such container: ${container}`;
      assert.ok(removed.code === 0 || alreadyRemoved, removed.output);
    } catch (error) { errors.push(error); }
  }
  try { rmSync(temporary, { recursive: true, force: true }); }
  catch (error) { errors.push(error); }
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onTerminate);
  process.removeListener("SIGHUP", onHangup);
  if (errors.length > 0) failure = new AggregateError([...(failure === undefined ? [] : [failure]), ...errors], "Disposable manager gate cleanup failed");
}
if (failure !== undefined) {
  process.stderr.write(`${failure.stack ?? String(failure)}\n`);
  if (failure instanceof AggregateError) {
    for (const cause of failure.errors) process.stderr.write(`${cause.stack ?? String(cause)}\n`);
  }
  process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : interrupted === "SIGHUP" ? 129 : 1;
}
