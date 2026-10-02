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

  const outcome = await tools.run("flatpak", ["list", "--columns=application,size,origin"]);

  assert.deepEqual(calls, [["flatpak", ["list", "--columns=application,size,origin"]]]);
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

  const outcome = await tools.run("lsof", ["+L1", "-F", "pcnsk"]);

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

function recordingPort() {
  const calls = [];
  const tools = createToolPort(async (name, commandArguments) => {
    calls.push([name, [...commandArguments]]);
    return { capability: { status: "available", explanation: "ran" }, stdout: "", stderr: "", exitCode: 0 };
  });
  return { calls, tools };
}

test("an allowlisted tool asked to change something is refused without being run", async () => {
  const { calls, tools } = recordingPort();
  for (const [name, commandArguments] of [
    ["journalctl", ["--disk-usage", "--vacuum-size=1"]],
    ["journalctl", ["--vacuum-time=1s"]],
    ["flatpak", ["uninstall", "--unused", "-y"]],
    ["pacman", ["-Rns", "linux"]],
    ["snap", ["remove", "core20"]],
    ["smartctl", ["-s", "off", "/dev/sda"]],
  ]) {
    const outcome = await tools.run(name, commandArguments);
    assert.equal(outcome.capability.status, "missing-tool", `${name} ${commandArguments.join(" ")}`);
    assert.match(outcome.capability.explanation, /not a query Disktop runs/);
  }
  assert.deepEqual(calls, [], "nothing was spawned");
});

test("every query the detectors make today is still allowed", async () => {
  const { calls, tools } = recordingPort();
  const queries = [
    ["btrfs", ["subvolume", "list", "/"]],
    ["zfs", ["list", "-H", "-p", "-t", "snapshot", "-o", "name,used"]],
    ["journalctl", ["--disk-usage"]],
    ["lsof", ["-v"]],
    ["lsof", ["+L1", "-F", "pcnsk"]],
    ["smartctl", ["--scan", "-j"]],
    ["smartctl", ["-H", "-A", "-j", "/dev/nvme0n1"]],
    ["dpkg-query", ["-W", "-f=${Package}\t${Installed-Size}\t${Status}\n"]],
    ["rpm", ["-qa", "--qf", "%{NAME}\t%{SIZE}\n"]],
    ["pacman", ["-Qi"]],
    ["snap", ["list"]],
    ["flatpak", ["list", "--columns=application,size,origin"]],
    ["npm", ["ls", "-g", "--depth=0", "--json"]],
    ["pip", ["list", "--format=json"]],
  ];
  for (const [name, commandArguments] of queries) {
    await tools.run(name, commandArguments);
  }
  assert.equal(calls.length, queries.length);
});

test("a device argument that is not a device path is refused", async () => {
  const { calls, tools } = recordingPort();
  const outcome = await tools.run("smartctl", ["-H", "-A", "-j", "--smart=off"]);
  assert.equal(outcome.capability.status, "missing-tool");
  assert.deepEqual(calls, []);
});

test("a simulated purge takes only kernel package names, and at least one", async () => {
  const { isAllowedQuery } = await import("../../dist/platform/linux/tools.js");
  assert.equal(isAllowedQuery("apt-get", ["-s", "purge", "linux-image-6.8.0-40-generic"]), true);
  assert.equal(isAllowedQuery("apt-get", ["-s", "purge"]), false);
  assert.equal(isAllowedQuery("apt-get", ["-s", "purge", "linux-image-6.8.0-40-generic", "-y"]), false);
  assert.equal(isAllowedQuery("apt-get", ["purge", "linux-image-6.8.0-40-generic"]), false);
  assert.equal(isAllowedQuery("rpm", ["-e", "--test", "--", "kernel-core-6.10.6-200.fc40.x86_64"]), true);
  assert.equal(isAllowedQuery("rpm", ["-e", "--", "kernel-core-6.10.6-200.fc40.x86_64"]), false);
});
