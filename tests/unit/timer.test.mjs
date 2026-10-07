import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { TIMER_MARKER, quoteExecArgument, renderUnits } from "../../dist/domain/timer.js";
import { createSystemdUserTimer } from "../../dist/platform/linux/notifications/systemd-timer.js";

const roots = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** Split an ExecStart= line the way systemd does: quoted words with C escapes, specifiers and variables doubled. */
function execStart(service) {
  const line = service.split("\n").find((entry) => entry.startsWith("ExecStart="));
  const text = line.slice("ExecStart=".length);
  const words = [];
  let index = 0;
  while (index < text.length) {
    while (text[index] === " ") index += 1;
    if (index >= text.length) break;
    let word = "";
    if (text[index] === '"') {
      index += 1;
      while (text[index] !== '"') {
        if (text[index] === "\\") {
          index += 1;
        }
        word += text[index];
        index += 1;
      }
      index += 1;
    } else {
      while (index < text.length && text[index] !== " ") {
        word += text[index];
        index += 1;
      }
    }
    words.push(word.replaceAll("%%", "%").replaceAll("$$", "$"));
  }
  return words;
}

test("the timer runs the alert check and nothing else", () => {
  const { service, timer } = renderUnits({ node: "/usr/bin/node", script: "/opt/disktop/dist/bin/disktop.js" });
  assert.deepEqual(execStart(service), ["/usr/bin/node", "/opt/disktop/dist/bin/disktop.js", "alerts", "check", "--notify"]);
  assert.match(service, /^Type=oneshot$/m);
  assert.match(timer, /^OnCalendar=hourly$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
  for (const unit of [service, timer]) {
    assert.ok(unit.startsWith(TIMER_MARKER));
    assert.doesNotMatch(unit, /clean|apply|undo|empty-trash/);
  }
});

test("a path holding a space, a percent, a dollar, and a quote comes back as it went in", () => {
  const script = '/home/a b/%h/$HOME/"q"/disktop.js';
  const { service } = renderUnits({ node: "/usr/bin/node", script });
  assert.equal(execStart(service)[1], script);
});

test("a path with a newline or another control character is refused rather than quoted", () => {
  assert.throws(() => quoteExecArgument("/a\nExecStart=/bin/sh"), RangeError);
  assert.throws(() => quoteExecArgument("/a\u0007b"), RangeError);
});

async function home() {
  const root = await mkdtemp(join(tmpdir(), "disktop-timer-"));
  roots.push(root);
  return join(root, "systemd", "user");
}

function systemctl(answers = {}) {
  const calls = [];
  return {
    calls,
    run: async (commandArguments) => {
      calls.push(commandArguments.join(" "));
      return answers[commandArguments.join(" ")] ?? { exitCode: 0, stderr: "" };
    },
  };
}

const UNITS = renderUnits({ node: "/usr/bin/node", script: "/opt/disktop/dist/bin/disktop.js" });

test("install writes both units with the marker, reloads, and enables the timer", async () => {
  const directory = await home();
  const control = systemctl();
  const outcome = await createSystemdUserTimer({ unitDirectory: directory, systemctl: control.run }).install(UNITS);
  assert.equal(outcome.capability.status, "available");
  assert.equal(outcome.enabled, true);
  assert.deepEqual(outcome.units.map((unit) => unit.state), ["written", "written"]);
  assert.ok((await readFile(join(directory, "disktop-alerts.service"), "utf8")).startsWith(TIMER_MARKER));
  assert.equal(((await stat(join(directory, "disktop-alerts.timer"))).mode & 0o777).toString(8), "644");
  assert.deepEqual(control.calls, ["--user show-environment", "--user daemon-reload", "--user enable --now disktop-alerts.timer"]);
});

test("install refuses to overwrite a unit Disktop did not write, and leaves it as it was", async () => {
  const directory = await home();
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "disktop-alerts.service"), "[Service]\nExecStart=/somebody/else\n");
  const control = systemctl();
  const outcome = await createSystemdUserTimer({ unitDirectory: directory, systemctl: control.run }).install(UNITS);
  assert.equal(outcome.refused, true);
  assert.equal(await readFile(join(directory, "disktop-alerts.service"), "utf8"), "[Service]\nExecStart=/somebody/else\n");
  assert.equal(control.calls.includes("--user enable --now disktop-alerts.timer"), false);
});

test("uninstall removes Disktop's units and can run twice", async () => {
  const directory = await home();
  const timer = createSystemdUserTimer({ unitDirectory: directory, systemctl: systemctl().run });
  await timer.install(UNITS);
  const first = await timer.uninstall();
  assert.deepEqual(first.units.map((unit) => unit.state), ["removed", "removed"]);
  const second = await timer.uninstall();
  assert.deepEqual(second.units.map((unit) => unit.state), ["absent", "absent"]);
});

test("a failed daemon reload leaves installed units explicit and never enables the timer", async () => {
  const directory = await home();
  const control = systemctl({ "--user daemon-reload": { exitCode: 1, stderr: "Failed to connect to bus" } });
  const result = await createSystemdUserTimer({ unitDirectory: directory, systemctl: control.run }).install(UNITS);
  assert.equal(result.enabled, false);
  assert.match(result.failure.message, /daemon-reload.*Failed to connect to bus/);
  assert.equal(control.calls.some((call) => call.includes("enable")), false);
  assert.ok((await readFile(join(directory, "disktop-alerts.timer"), "utf8")).startsWith(TIMER_MARKER));
});

test("a failed disable preserves both units and reports that the timer may still run", async () => {
  const directory = await home();
  const control = systemctl({ "--user disable --now disktop-alerts.timer": { exitCode: 1, stderr: "Access denied" } });
  const timer = createSystemdUserTimer({ unitDirectory: directory, systemctl: control.run });
  await timer.install(UNITS);
  control.calls.length = 0;
  const result = await timer.uninstall();
  assert.equal(result.failure.code, "permission-denied");
  assert.match(result.failure.message, /units were kept/);
  for (const name of ["disktop-alerts.service", "disktop-alerts.timer"]) {
    assert.ok((await readFile(join(directory, name), "utf8")).startsWith(TIMER_MARKER));
  }
  assert.deepEqual(control.calls, ["--user show-environment", "--user disable --now disktop-alerts.timer"]);
});

test("uninstall refuses a timer Disktop did not write, and neither stops nor removes anything", async () => {
  const directory = await home();
  const control = systemctl();
  const timer = createSystemdUserTimer({ unitDirectory: directory, systemctl: control.run });
  await timer.install(UNITS);
  await writeFile(join(directory, "disktop-alerts.timer"), "[Timer]\nOnCalendar=daily\n");
  control.calls.length = 0;
  const outcome = await timer.uninstall();
  assert.equal(outcome.refused, true);
  assert.equal(control.calls.some((call) => call.includes("disable")), false, "a foreign timer is never stopped");
  assert.equal(await readFile(join(directory, "disktop-alerts.timer"), "utf8"), "[Timer]\nOnCalendar=daily\n");
  assert.ok((await readFile(join(directory, "disktop-alerts.service"), "utf8")).startsWith(TIMER_MARKER));
});

test("a unit path that cannot be read as a file is not treated as absent", async () => {
  const directory = await home();
  await mkdir(join(directory, "disktop-alerts.service"), { recursive: true });
  const outcome = await createSystemdUserTimer({ unitDirectory: directory, systemctl: systemctl().run }).install(UNITS);
  assert.equal(outcome.refused, true);
  assert.equal((await stat(join(directory, "disktop-alerts.service"))).isDirectory(), true);
});

test("with no systemd user instance nothing is written", async () => {
  const directory = await home();
  const control = systemctl({ "--user show-environment": { exitCode: 1, stderr: "Failed to connect to bus: No medium found" } });
  const outcome = await createSystemdUserTimer({ unitDirectory: directory, systemctl: control.run }).install(UNITS);
  assert.equal(outcome.capability.status, "missing-tool");
  await assert.rejects(stat(directory));
});

const { runCli } = await import("../../dist/cli/run.js");
const { fakeContext } = await import("../support/cli-context.mjs");
const { createTimerService } = await import("../../dist/application/timer.js");
const { compileBundle } = await import("../support/schemas.mjs");
const validators = compileBundle("schemas/cli/v1");

function timerContext(outcome, entry = { node: "/usr/bin/node", script: "/usr/lib/node_modules/disktop/dist/bin/disktop.js" }) {
  const context = fakeContext();
  const port = { async install() { return outcome; }, async uninstall() { return outcome; } };
  context.timer = createTimerService({ port, entry: () => entry });
  return context;
}

const WRITTEN = {
  capability: { status: "available", explanation: "A systemd user instance answered." },
  units: [
    { name: "disktop-alerts.service", path: { bytesBase64: Buffer.from("/h/.config/systemd/user/disktop-alerts.service").toString("base64"), display: "/h/.config/systemd/user/disktop-alerts.service", utf8: "/h/.config/systemd/user/disktop-alerts.service" }, state: "written" },
    { name: "disktop-alerts.timer", path: { bytesBase64: Buffer.from("/h/.config/systemd/user/disktop-alerts.timer").toString("base64"), display: "/h/.config/systemd/user/disktop-alerts.timer", utf8: "/h/.config/systemd/user/disktop-alerts.timer" }, state: "written" },
  ],
  enabled: true,
  refused: false,
};

test("timer install reports the units it wrote and that the timer is on", async () => {
  const context = timerContext(WRITTEN);
  const status = await runCli(["timer", "install", "--json"], context);
  const envelope = JSON.parse(context.captured.stdout);
  assert.ok(validators.get("timer")(envelope), JSON.stringify(validators.get("timer").errors));
  assert.equal(status, 0);
  assert.equal(envelope.data.action, "install");
  assert.equal(envelope.data.enabled, true);
});

test("a timer written but not enabled is an incomplete install", async () => {
  const context = timerContext({ ...WRITTEN, enabled: false });
  assert.equal(await runCli(["timer", "install", "--json"], context), 3);
});

test("timer command failures reach the CLI as actionable error envelopes", async () => {
  for (const action of ["install", "uninstall"]) {
    const context = timerContext({ ...WRITTEN, failure: { code: "permission-denied", message: "systemctl disable failed; the units were kept" } });
    const status = await runCli(["timer", action, "--json"], context);
    const envelope = JSON.parse(context.captured.stdout);
    assert.equal(status, 2);
    assert.ok(validators.get("timer")(envelope), JSON.stringify(validators.get("timer").errors));
    assert.equal(envelope.error.code, "permission-denied");
    assert.match(envelope.error.message, /units were kept/);
  }
});

test("a foreign unit at Disktop's path refuses the install", async () => {
  const context = timerContext({ ...WRITTEN, refused: true, enabled: false, units: [{ ...WRITTEN.units[0], state: "kept-foreign" }, { ...WRITTEN.units[1], state: "absent" }] });
  const status = await runCli(["timer", "install", "--json"], context);
  assert.equal(status, 2);
  assert.match(JSON.parse(context.captured.stdout).error.message, /did not write/);
});

test("no systemd user instance is an unsupported capability", async () => {
  const context = timerContext({ ...WRITTEN, capability: { status: "missing-tool", explanation: "No systemd user instance is reachable." }, units: WRITTEN.units.map((unit) => ({ ...unit, state: "absent" })), enabled: false });
  assert.equal(await runCli(["timer", "install", "--json"], context), 2);
  assert.equal(JSON.parse(context.captured.stdout).error.code, "unsupported");
});

test("an install from npx's cache says it will not outlive that cache", async () => {
  const context = timerContext(WRITTEN, { node: "/usr/bin/node", script: "/home/a/.npm/_npx/1234/node_modules/disktop/dist/bin/disktop.js" });
  await runCli(["timer", "install", "--json"], context);
  assert.ok(JSON.parse(context.captured.stdout).warnings.some((warning) => warning.code === "ephemeral-install"));
});

test("an action other than install or uninstall is an input error", async () => {
  const context = timerContext(WRITTEN);
  assert.equal(await runCli(["timer", "start", "--json"], context), 2);
});
