import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "../../dist/cli/parser.js";

function invoke(args) {
  let stdout = "";
  let stderr = "";
  const status = runCli(args, "0.0.0", {
    stdout: (message) => { stdout += message; },
    stderr: (message) => { stderr += message; },
  });
  return { status, stdout, stderr };
}

test("help and version are the only successful scaffold commands", () => {
  const help = invoke(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /development scaffold/);
  assert.match(help.stdout, /Planned commands/);
  assert.equal(help.stderr, "");

  const version = invoke(["--version"]);
  assert.deepEqual(version, { status: 0, stdout: "0.0.0\n", stderr: "" });
});

test("feature commands and default TUI refuse to claim success", () => {
  for (const args of [[], ["--json"], ["devices", "--json"], ["clean", "--yes"]]) {
    const result = invoke(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /not implemented/);
  }
});

test("unknown commands return a usage failure", () => {
  const result = invoke(["wipe-everything"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown Disktop command/);
});
