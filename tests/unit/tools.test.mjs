import assert from "node:assert/strict";
import { test } from "node:test";
import { ALLOWED_TOOLS, createToolPort } from "../../dist/platform/linux/tools.js";

test("a tool that is not on the allowlist is refused without being run", async () => {
  let ran = 0;
  const tools = createToolPort(async () => {
    ran += 1;
    return { capability: { status: "available", explanation: "ran" }, stdout: "", stderr: "", exitCode: 0 };
  });

  const outcome = await tools.run("curl", ["https://example.invalid"]);

  assert.equal(ran, 0, "nothing was spawned");
  assert.equal(outcome.capability.status, "missing-tool");
  assert.match(outcome.capability.explanation, /curl/);
  assert.match(outcome.capability.explanation, /not a tool Disktop runs/);
  assert.equal(outcome.stdout, "");
  assert.equal(outcome.exitCode, null);
});

test("an allowlisted tool is run with the exact argument vector it was given", async () => {
  const calls = [];
  const tools = createToolPort(async (name, commandArguments) => {
    calls.push([name, [...commandArguments]]);
    return { capability: { status: "available", explanation: "ran" }, stdout: "ok\n", stderr: "", exitCode: 0 };
  });

  const outcome = await tools.run("flatpak", ["list", "--columns=application,size"]);

  assert.deepEqual(calls, [["flatpak", ["list", "--columns=application,size"]]]);
  assert.equal(outcome.stdout, "ok\n");
});

test("the allowlist holds every tool the Phase 3 detectors ask for", () => {
  for (const name of [
    "lsof",
    "smartctl",
    "journalctl",
    "btrfs",
    "zfs",
    "dpkg-query",
    "rpm",
    "pacman",
    "snap",
    "flatpak",
    "npm",
    "pip",
    "pip3",
    "conda",
    "swapon",
  ]) {
    assert.ok(ALLOWED_TOOLS.includes(name), `${name} is missing from the allowlist`);
  }
});

test("every allowlisted name is one the trusted-path resolver would accept", () => {
  for (const name of ALLOWED_TOOLS) {
    assert.match(name, /^[a-z][a-z0-9_-]*$/, `${name} cannot be resolved as a plain executable name`);
  }
});

test("a tool that fails keeps its capability and its output", async () => {
  const tools = createToolPort(async () => ({
    capability: { status: "permission-denied", explanation: "/usr/bin/lsof could not be run by this user." },
    stdout: "",
    stderr: "lsof: permission denied\n",
    exitCode: 1,
  }));

  const outcome = await tools.run("lsof", ["+L1"]);

  assert.equal(outcome.capability.status, "permission-denied");
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.stderr, /permission denied/);
});

test("a tool's stderr cannot command the terminal through a capability explanation", async () => {
  const { runFixedCommand } = await import("../../dist/platform/linux/process.js");
  const outcome = await runFixedCommand("sh", ["-c", "printf '\\033[2Jgone\\n' >&2; exit 3"]);
  assert.notEqual(outcome.capability.status, "available");
  assert.doesNotMatch(outcome.capability.explanation, /\u001b/);
  assert.match(outcome.capability.explanation, /gone/);
});
