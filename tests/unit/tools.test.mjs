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

test("a device argument cannot climb out of /dev", async () => {
  const { isAllowedQuery } = await import("../../dist/platform/linux/tools.js");
  for (const device of ["/dev/sda", "/dev/nvme0n1", "/dev/disk/by-id/nvme-Example_SSD_1TB_S1234", "/dev/mapper/luks-0a1b"]) {
    assert.equal(isAllowedQuery("smartctl", ["-H", "-A", "-j", device]), true, device);
  }
  for (const device of ["/dev/../etc/shadow", "/dev/sda/../../etc/shadow", "/dev/./sda", "/dev/sda/..", "/dev//sda"]) {
    assert.equal(isAllowedQuery("smartctl", ["-H", "-A", "-j", device]), false, device);
  }
});

test("a query that outlives its time limit is killed, even when it ignores SIGTERM", async () => {
  const { runFixedCommand } = await import("../../dist/platform/linux/process.js");
  const begun = Date.now();
  const outcome = await runFixedCommand("sh", ["-c", "trap '' TERM; sleep 20 & printf 'descendant=%s\\n' \"$!\"; wait"], {
    timeoutMilliseconds: 200,
    maxOutputBytes: 1024,
  });
  assert.ok(Date.now() - begun < 5_000, `the query held the caller for ${Date.now() - begun} ms`);
  assert.notEqual(outcome.capability.status, "available");
  assert.match(outcome.capability.explanation, /did not finish within/);
  const descendant = /descendant=([0-9]+)/.exec(outcome.stdout)?.[1];
  assert.ok(descendant, "the query actually started a descendant");
  const { readFile } = await import("node:fs/promises");
  const deadline = Date.now() + 1000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    const state = await readFile(`/proc/${descendant}/stat`, "utf8").catch(() => undefined);
    alive = state !== undefined && state.split(") ")[1]?.[0] !== "Z";
    if (alive) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(alive, false, "timing out a query stops its descendants too");
});

test("a query's output is bounded, and running past the bound is a failure rather than a short answer", async () => {
  const { runFixedCommand } = await import("../../dist/platform/linux/process.js");
  const outcome = await runFixedCommand("sh", ["-c", "while :; do printf 'xxxxxxxxxxxxxxxx'; done"], {
    timeoutMilliseconds: 5_000,
    maxOutputBytes: 64 * 1024,
  });
  assert.notEqual(outcome.capability.status, "available");
  assert.match(outcome.capability.explanation, /more than 65536 bytes/);
  assert.ok(outcome.stdout.length <= 64 * 1024);
});

test("a query reads nothing from Disktop's own stdin", async () => {
  const { runFixedCommand } = await import("../../dist/platform/linux/process.js");
  // `cat` with an open stdin would wait for input until the time limit.
  const begun = Date.now();
  const outcome = await runFixedCommand("cat", [], { timeoutMilliseconds: 3_000, maxOutputBytes: 1024 });
  assert.equal(outcome.capability.status, "available");
  assert.ok(Date.now() - begun < 2_000);
});

test("queries and manager commands select the same daemon and see nothing else", async () => {
  // Discovery and verification ask through the query runner; apply runs
  // through the manager runner. If only one of them passed DOCKER_HOST or the
  // home directory holding docker's current context, a reviewed plan would be
  // previewed against one daemon and applied to another.
  const { runFixedCommand, toolEnvironment } = await import("../../dist/platform/linux/process.js");
  const { createCommandRunner } = await import("../../dist/platform/linux/privilege.js");
  const environment = {
    HOME: "/home/example",
    XDG_RUNTIME_DIR: "/run/user/1000",
    DOCKER_HOST: "unix:///run/user/1000/docker.sock",
    DOCKER_CONTEXT: "rootless",
    CONTAINER_HOST: "unix:///run/user/1000/podman/podman.sock",
    AWS_SECRET_ACCESS_KEY: "do-not-pass",
    LD_PRELOAD: "/tmp/evil.so",
    PATH: "/home/example/bin:/usr/bin",
  };

  const query = await runFixedCommand("env", [], undefined, environment);
  const seen = Object.fromEntries(
    query.stdout.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

  let managerEnv;
  const runner = createCommandRunner({
    euid: 1000,
    environment,
    resolve: async (name) => (name === "docker" ? "/usr/bin/docker" : undefined),
    spawn: async (_program, _argv, options) => {
      managerEnv = options.env;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  await runner.run({ tool: "docker", arguments: ["image", "rm", "--", "x"] }, "user", {
    interactive: false,
    signal: new AbortController().signal,
  });

  assert.deepEqual(seen, toolEnvironment(environment));
  assert.deepEqual(managerEnv, toolEnvironment(environment));
  for (const name of ["HOME", "XDG_RUNTIME_DIR", "DOCKER_HOST", "DOCKER_CONTEXT", "CONTAINER_HOST"]) {
    assert.equal(seen[name], environment[name], name);
  }
  assert.equal(seen.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(seen.LD_PRELOAD, undefined);
  assert.equal(seen.PATH, "/usr/bin:/bin:/usr/sbin:/sbin", "PATH is never the caller's");
  assert.equal(seen.LC_ALL, "C", "parsed output is always in the C locale");
});

test("read-only queries propagate cancellation and release their abort listeners", async () => {
  const { getEventListeners } = await import("node:events");
  const { runFixedCommand } = await import("../../dist/platform/linux/process.js");
  const controller = new AbortController();
  const pending = runFixedCommand("sh", ["-c", "sleep 20 & wait"], {
    timeoutMilliseconds: 10000, maxOutputBytes: 1024,
  }, undefined, controller.signal);
  const timer = setTimeout(() => controller.abort(), 50);
  const began = Date.now();
  try {
    const result = await pending;
    assert.match(result.capability.explanation, /cancelled/);
    assert.ok(Date.now() - began < 2000, "cancellation does not wait for the query's normal deadline");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally { clearTimeout(timer); }
  const cancelled = await runFixedCommand("sh", ["-c", "printf should-not-run"], undefined, undefined, controller.signal);
  assert.equal(cancelled.stdout, "");
  assert.match(cancelled.capability.explanation, /before it started/);
});
