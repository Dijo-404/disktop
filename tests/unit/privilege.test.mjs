import assert from "node:assert/strict";
import { test } from "node:test";
import { createCommandRunner, deniedByEscalation, escalationFor } from "../../dist/platform/linux/privilege.js";

const SUDO = "/usr/bin/sudo";
const PKEXEC = "/usr/bin/pkexec";

test("a root command from an ordinary user is wrapped in sudo, non-interactively without a terminal", () => {
  assert.deepEqual(escalationFor("root", { euid: 1000, interactive: false, sudo: SUDO, pkexec: PKEXEC }), {
    kind: "sudo",
    argv: [SUDO, "-n", "--"],
  });
  assert.deepEqual(escalationFor("root", { euid: 1000, interactive: true, sudo: SUDO }), {
    kind: "sudo",
    argv: [SUDO, "--"],
  });
});

test("without sudo, pkexec is used only when somebody is there to answer it", () => {
  assert.deepEqual(escalationFor("root", { euid: 1000, interactive: true, pkexec: PKEXEC }), { kind: "pkexec", argv: [PKEXEC] });
  const refused = escalationFor("root", { euid: 1000, interactive: false, pkexec: PKEXEC });
  assert.match(refused.refusal, /administrator rights/);
});

test("nothing is escalated for a user command or when already root", () => {
  assert.deepEqual(escalationFor("user", { euid: 1000, interactive: false, sudo: SUDO }), { kind: "none", argv: [] });
  assert.deepEqual(escalationFor("root", { euid: 0, interactive: false }), { kind: "none", argv: [] });
});

test("sudo's own refusal is told apart from the command's failure", () => {
  assert.equal(deniedByEscalation("sudo", 1, "sudo: a password is required\n"), true);
  assert.equal(deniedByEscalation("sudo", 1, "Sorry, try again.\nsudo: 3 incorrect password attempts\n"), true);
  assert.equal(deniedByEscalation("sudo", 1, "E: Could not open lock file /var/lib/apt/lists/lock\n"), false);
  assert.equal(deniedByEscalation("sudo", 0, ""), false);
  assert.equal(deniedByEscalation("pkexec", 126, ""), true);
  assert.equal(deniedByEscalation("pkexec", 127, ""), true);
  assert.equal(deniedByEscalation("none", 1, "sudo: something"), false);
});

function fakeRunner({ result = { exitCode: 0, stdout: "", stderr: "" }, euid = 1000, tools = ["apt-get", "sudo", "docker", "journalctl"] } = {}) {
  const spawned = [];
  const runner = createCommandRunner({
    euid,
    resolve: async (name) => (tools.includes(name) ? `/usr/bin/${name}` : undefined),
    spawn: async (program, argv, options) => {
      spawned.push({ program, argv: [...argv], interactive: options.interactive, env: options.env });
      return typeof result === "function" ? result(options) : result;
    },
  });
  return { runner, spawned };
}

const SIGNAL = new AbortController().signal;

test("a root command runs as sudo -n -- /absolute/tool args", async () => {
  const { runner, spawned } = fakeRunner();
  const run = await runner.run({ tool: "apt-get", arguments: ["clean"] }, "root", { interactive: false, signal: SIGNAL });
  assert.equal(run.status, "ran");
  assert.equal(run.exitCode, 0);
  assert.deepEqual(spawned, [
    { program: "/usr/bin/sudo", argv: ["-n", "--", "/usr/bin/apt-get", "clean"], interactive: false, env: spawned[0].env },
  ]);
  assert.equal(spawned[0].env.LC_ALL, "C");
  assert.equal(spawned[0].env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
});

test("a refused password is a denial, not a failure of the command", async () => {
  const { runner } = fakeRunner({ result: { exitCode: 1, stdout: "", stderr: "sudo: a password is required\n" } });
  const run = await runner.run({ tool: "apt-get", arguments: ["clean"] }, "root", { interactive: false, signal: SIGNAL });
  assert.equal(run.status, "denied");
  assert.match(run.explanation, /password is required/);
});

test("a tool that is not a manager tool is never spawned", async () => {
  const { runner, spawned } = fakeRunner();
  const run = await runner.run({ tool: "sh", arguments: ["-c", "true"] }, "user", { interactive: false, signal: SIGNAL });
  assert.equal(run.status, "missing-tool");
  assert.deepEqual(spawned, []);
});

test("a manager that is not installed is missing, and nothing is spawned", async () => {
  const { runner, spawned } = fakeRunner({ tools: ["sudo"] });
  const run = await runner.run({ tool: "apt-get", arguments: ["clean"] }, "root", { interactive: false, signal: SIGNAL });
  assert.equal(run.status, "missing-tool");
  assert.deepEqual(spawned, []);
});

test("a root command with no way to ask for rights is denied without running", async () => {
  const { runner, spawned } = fakeRunner({ tools: ["apt-get"] });
  const run = await runner.run({ tool: "apt-get", arguments: ["clean"] }, "root", { interactive: false, signal: SIGNAL });
  assert.equal(run.status, "denied");
  assert.deepEqual(spawned, []);
});

test("what a command printed comes back sanitized and bounded", async () => {
  const { runner } = fakeRunner({ result: { exitCode: 0, stdout: `${"x".repeat(10_000)}\u001b[2Jend`, stderr: "" } });
  const run = await runner.run({ tool: "docker", arguments: ["image", "rm", "--", "x"] }, "user", { interactive: false, signal: SIGNAL });
  assert.doesNotMatch(run.output, /\u001b/);
  assert.ok(Buffer.byteLength(run.output) <= 4096 + 64);
  assert.match(run.output, /end$/);
});

test("a command cancelled while it runs reads as cancelled", async () => {
  const controller = new AbortController();
  const { runner } = fakeRunner({
    result: () => {
      controller.abort();
      return { exitCode: null, stdout: "", stderr: "", signal: "SIGTERM" };
    },
  });
  const run = await runner.run({ tool: "docker", arguments: ["image", "rm", "--", "x"] }, "user", { interactive: false, signal: controller.signal });
  assert.equal(run.status, "cancelled");
});

test("as root, a root command runs directly", async () => {
  const { runner, spawned } = fakeRunner({ euid: 0 });
  await runner.run({ tool: "apt-get", arguments: ["clean"] }, "root", { interactive: false, signal: SIGNAL });
  assert.deepEqual([spawned[0].program, spawned[0].argv], ["/usr/bin/apt-get", ["clean"]]);
});

test("a command whose stop was asked for before it started is never run", async () => {
  const controller = new AbortController();
  controller.abort();
  const { runner, spawned } = fakeRunner();
  const run = await runner.run({ tool: "apt-get", arguments: ["clean"] }, "root", { interactive: false, signal: controller.signal });
  assert.equal(run.status, "cancelled");
  assert.match(run.explanation, /never run/i);
  assert.deepEqual(spawned, [], "nothing was spawned after Ctrl+C");
});

test("a running command is stopped by an abort, and killed if it ignores SIGTERM", async () => {
  const { spawnCommand } = await import("../../dist/platform/linux/privilege.js");
  const controller = new AbortController();
  const begun = Date.now();
  const pending = spawnCommand("/bin/sh", ["-c", "trap '' TERM; exec sleep 20"], {
    interactive: false,
    signal: controller.signal,
    timeoutMilliseconds: 60_000,
    env: { PATH: "/usr/bin:/bin" },
    killGraceMilliseconds: 200,
  });
  setTimeout(() => controller.abort(), 100);
  const result = await pending;
  assert.ok(Date.now() - begun < 5_000, `the command held the caller for ${Date.now() - begun} ms`);
  assert.equal(result.signal, "SIGKILL");
});

test("an abort that landed before the spawn still stops the command", async () => {
  const { spawnCommand } = await import("../../dist/platform/linux/privilege.js");
  const controller = new AbortController();
  controller.abort();
  const begun = Date.now();
  const result = await spawnCommand("/bin/sh", ["-c", "exec sleep 20"], {
    interactive: false,
    signal: controller.signal,
    timeoutMilliseconds: 60_000,
    env: { PATH: "/usr/bin:/bin" },
  });
  assert.ok(Date.now() - begun < 5_000);
  assert.notEqual(result.signal, null);
});

test("an escalated command is never sent SIGKILL, which would orphan what sudo started", async () => {
  const { spawnCommand } = await import("../../dist/platform/linux/privilege.js");
  const controller = new AbortController();
  // With no grace configured for an escalated command, SIGTERM is all it gets:
  // sudo relays it, and killing sudo itself would leave the root command
  // running with nobody to journal how it ended.
  const pending = spawnCommand("/bin/sh", ["-c", "trap 'exit 7' TERM; sleep 20 & wait"], {
    interactive: false,
    signal: controller.signal,
    timeoutMilliseconds: 60_000,
    env: { PATH: "/usr/bin:/bin" },
    escalated: true,
    killGraceMilliseconds: 100,
  });
  setTimeout(() => controller.abort(), 100);
  const result = await pending;
  assert.equal(result.exitCode, 7, "the command ended through its own SIGTERM handling");
});
