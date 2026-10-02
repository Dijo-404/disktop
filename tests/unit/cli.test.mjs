import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS, parseArguments, renderHelp } from "../../dist/cli/parser.js";
import { runCli } from "../../dist/cli/run.js";
import { fakeContext, FIXTURE_VIEW } from "../support/cli-context.mjs";

test("help is generated from the command table, so nothing can drift out of it", () => {
  const help = renderHelp();
  for (const command of COMMANDS) {
    if (command.path.length === 0) {
      continue;
    }
    assert.match(help, new RegExp(command.path.join(" ")), `${command.path.join(" ")} is missing from help`);
  }
  assert.match(help, /\[planned\]/, "an unbuilt command must be marked");
  assert.match(help, /are not implemented/, "the marker must be explained");
  assert.match(help, /Exit status: 0 complete, 1 alert threshold reached/);
});

test("help fits an 80 column terminal, for every command", () => {
  for (const command of [undefined, ...COMMANDS]) {
    for (const line of renderHelp(command).split("\n")) {
      assert.ok(line.length <= 80, `help line exceeds 80 columns: ${JSON.stringify(line)}`);
    }
  }
});

test("the longest matching command path wins", () => {
  const result = parseArguments(["alerts", "check", "--threshold", "80"]);
  assert.equal(result.kind, "command");
  assert.deepEqual(result.parsed.command.path, ["alerts", "check"]);
  assert.equal(result.parsed.values.get("threshold"), "80");
});

test("an option value is never mistaken for a command name", () => {
  // `si` is the value of --units, not a command.
  for (const args of [["--units", "si", "devices"], ["devices", "--units", "si"], ["--units=si", "devices"]]) {
    const result = parseArguments(args);
    assert.equal(result.kind, "command", `${args.join(" ")}: ${result.message ?? ""}`);
    assert.deepEqual(result.parsed.command.path, ["devices"], args.join(" "));
    assert.equal(result.parsed.values.get("units"), "si", args.join(" "));
  }

  const root = parseArguments(["--units", "si"]);
  assert.equal(root.kind, "command");
  assert.deepEqual(root.parsed.command.path, []);

  const threshold = parseArguments(["--threshold", "80", "alerts", "check"]);
  assert.equal(threshold.kind, "command");
  assert.deepEqual(threshold.parsed.command.path, ["alerts", "check"]);
  assert.equal(threshold.parsed.values.get("threshold"), "80");
});

test("unknown commands, unknown options, and bad choices are refused before any work", () => {
  assert.equal(parseArguments(["wipe-everything"]).kind, "error");
  assert.equal(parseArguments(["devices", "--force"]).kind, "error");
  assert.equal(parseArguments(["devices", "--units", "furlongs"]).kind, "error");
  assert.equal(parseArguments(["devices", "--json=yes"]).kind, "error");
  assert.equal(parseArguments(["--units"]).kind, "error");
});

test("version and help short-circuit every command", async () => {
  const context = fakeContext();
  assert.equal(await runCli(["--version"], context), 0);
  assert.equal(context.captured.stdout, "1.2.3\n");

  const help = fakeContext();
  assert.equal(await runCli(["devices", "--help"], help), 0);
  assert.match(help.captured.stdout, /disktop devices/);
});

test("the dashboard prints JSON and stays at exit 0 when nothing is wrong", async () => {
  const context = fakeContext();
  assert.equal(await runCli(["--json"], context), 0);
  const envelope = JSON.parse(context.captured.stdout);
  assert.equal(envelope.command, "dashboard");
  assert.equal(envelope.status, "complete");
  assert.equal(envelope.data.filesystems.length, FIXTURE_VIEW.filesystems.length);
  assert.equal(context.captured.stderr, "");
});

test("a redirected stdout gets the dashboard instead of a terminal it cannot draw on", async () => {
  const context = fakeContext({ interactive: false });
  assert.equal(await runCli([], context), 0);
  assert.equal(context.launched, 0);
  assert.match(context.captured.stdout, /Mount/);
});

test("a terminal gets the TUI, and a command-line unit choice reaches it", async () => {
  const context = fakeContext({ interactive: true });
  assert.equal(await runCli([], context), 0);
  assert.equal(context.launched, 1);
  assert.equal(context.captured.stdout, "");
  assert.equal(context.launchedWithUnits, "iec");

  const si = fakeContext({ interactive: true });
  assert.equal(await runCli(["--units", "si"], si), 0);
  assert.equal(si.launchedWithUnits, "si");
});

test("alerts check exits 1 only when a threshold is actually reached", async () => {
  const quiet = fakeContext();
  assert.equal(await runCli(["alerts", "check", "--threshold", "99"], quiet), 0);
  assert.match(quiet.captured.stdout, /No filesystem has reached 99%/);

  const loud = fakeContext();
  assert.equal(await runCli(["alerts", "check", "--threshold", "10", "--json"], loud), 1);
  const envelope = JSON.parse(loud.captured.stdout);
  assert.equal(envelope.command, "alerts check");
  assert.equal(envelope.exitCode, 1);
  assert.ok(envelope.data.alerts.length > 0);
});

test("a threshold outside 0 to 100 is an input error, not a clamped guess", async () => {
  const context = fakeContext();
  assert.equal(await runCli(["alerts", "check", "--threshold", "900"], context), 2);
  assert.equal(context.captured.stdout, "");
  assert.match(context.captured.stderr, /whole percentage from 0 to 100/);
});

test("an incomplete inventory reports 3 and says what it missed", async () => {
  const context = fakeContext({
    view: {
      ...FIXTURE_VIEW,
      complete: false,
      warnings: [{ code: "statfs-unreadable", message: "One mount could not be measured." }],
    },
  });
  assert.equal(await runCli(["--json"], context), 3);
  const envelope = JSON.parse(context.captured.stdout);
  assert.equal(envelope.status, "incomplete");
  assert.equal(envelope.warnings.length, 1);
});

test("a declared but unbuilt command refuses in the same envelope shape", async () => {
  const context = fakeContext();
  assert.equal(await runCli(["report", "--json"], context), 2);
  const envelope = JSON.parse(context.captured.stdout);
  assert.equal(envelope.status, "error");
  assert.equal(envelope.error.code, "not-implemented");

  const text = fakeContext();
  assert.equal(await runCli(["timer", "install"], text), 2);
  assert.equal(text.captured.stdout, "");
  assert.match(text.captured.stderr, /not implemented yet/);
});

test("--units changes presentation without changing a byte value", async () => {
  const iec = fakeContext();
  await runCli(["devices", "--units", "iec"], iec);
  const si = fakeContext();
  await runCli(["devices", "--units", "si"], si);
  assert.match(iec.captured.stdout, /GiB/);
  assert.match(si.captured.stdout, /GB/);

  const json = fakeContext();
  await runCli(["devices", "--units", "si", "--json"], json);
  assert.equal(JSON.parse(json.captured.stdout).data.filesystems[0].totalBytes, "1000000000000");
});

test("text Disktop did not write cannot command the terminal on its way out", async () => {
  const { warningLines, findingLines } = await import("../../dist/cli/text.js");

  const hostile = "report\u001b[2J\u001b[3J\u001b[H\u0007 and ‮evil";
  const lines = [
    ...warningLines([{ code: "incomplete-search", message: `${hostile} could not be read` }]),
    ...findingLines(
      {
        findings: [{
          id: "rules:x",
          providerId: "rules",
          providerVersion: 1,
          category: "temporary",
          title: `Cleanup rule: ${hostile}`,
          evidence: [`It covers '${hostile}'.`],
          paths: [],
          size: { basis: "unknown", explanation: "nothing measured it" },
          confidence: "observed",
          capability: { status: "available", explanation: "read" },
          availableActionIds: [],
          active: false,
        }],
        providers: [],
        warnings: [],
        complete: true,
        categoryTotals: [],
        measured: false,
        capability: { status: "available", explanation: "read" },
      },
      "iec",
    ),
  ];

  for (const line of lines) {
    assert.doesNotMatch(
      line,
      /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/,
      `a line reached the terminal with a control or bidi character: ${JSON.stringify(line)}`,
    );
  }
});

test("a detector's capability explanation is printed without its escape sequences", async () => {
  const { providerLines } = await import("../../dist/cli/text.js");
  const [line] = providerLines([
    {
      providerId: "diagnostic.smart",
      version: 1,
      ran: false,
      complete: true,
      findings: 0,
      capability: { status: "missing-tool", explanation: "smartctl failed: \u001b[31mred\u009b2K" },
    },
  ]);
  assert.doesNotMatch(line, /[\u001b\u009b]/);
});
