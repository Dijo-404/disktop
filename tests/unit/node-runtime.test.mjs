import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrapCli, isSupportedNodeVersion } from "../../dist/cli/bootstrap.js";
import { StartupRefused } from "../../dist/domain/errors.js";
import { fakeContext } from "../support/cli-context.mjs";
import { compileBundle } from "../support/schemas.mjs";

const validators = compileBundle("schemas/cli/v1");

function capture() {
  const captured = { stdout: "", stderr: "" };
  return {
    captured,
    output: {
      stdout: (message) => { captured.stdout += message; },
      stderr: (message) => { captured.stderr += message; },
    },
  };
}

test("only supported Node 24 and 26 versions pass the runtime gate", () => {
  for (const version of ["24.21.0", "24.21.1", "24.22.0", "26.10.0", "26.10.1", "26.11.0"]) {
    assert.equal(isSupportedNodeVersion(version), true, version);
  }
  for (const version of [
    "22.99.0", "24.20.99", "25.0.0", "26.9.99", "27.0.0", "v26.10.0",
    "26.10.0-rc.1", "26.10", "26.010.0", "not-a-version",
  ]) {
    assert.equal(isSupportedNodeVersion(version), false, version);
  }
});

test("an untested runtime is refused before anything reads a device", async () => {
  const context = fakeContext();
  let built = 0;
  const captured = { stdout: "", stderr: "" };
  const output = {
    stdout: (message) => { captured.stdout += message; },
    stderr: (message) => { captured.stderr += message; },
  };

  const status = await bootstrapCli(["--help"], "25.0.0", output, async () => {
    built += 1;
    return context;
  }, "1.2.3");

  assert.equal(status, 2);
  assert.equal(built, 0, "no service is built on an unsupported runtime");
  assert.equal(captured.stdout, "");
  assert.match(captured.stderr, /requires Node\.js 24\.21\.0.*26\.10\.0.*found 25\.0\.0/);
});

test("a supported runtime reaches the CLI", async () => {
  const context = fakeContext();
  const status = await bootstrapCli(["devices", "--json"], "26.10.0", context.output, async () => context, "1.2.3");
  assert.equal(status, 0);
  assert.equal(JSON.parse(context.captured.stdout).command, "devices");
});

test("help, version, and a malformed command line are answered without building anything", async () => {
  // Building services reads the configuration and, as root, verifies the
  // install; none of that is needed to print help, and a refusal there must
  // not stop somebody from reading how to run Disktop properly.
  const refusing = async () => {
    throw new StartupRefused({ code: "permission-denied", message: "Disktop runs as root only from a root-owned install." });
  };

  const version = capture();
  assert.equal(await bootstrapCli(["--version"], "26.10.0", version.output, refusing, "1.2.3"), 0);
  assert.equal(version.captured.stdout, "1.2.3\n");
  assert.equal(version.captured.stderr, "");

  const help = capture();
  assert.equal(await bootstrapCli(["scan", "--help"], "26.10.0", help.output, refusing, "1.2.3"), 0);
  assert.match(help.captured.stdout, /disktop scan/);

  const invalid = capture();
  assert.equal(await bootstrapCli(["devices", "--bogus"], "26.10.0", invalid.output, refusing, "1.2.3"), 2);
  assert.equal(invalid.captured.stdout, "", "a refused command line leaves stdout clean");
  assert.match(invalid.captured.stderr, /does not accept the option '--bogus'/);
});

test("a malformed command line with --json still answers in one error envelope", async () => {
  let built = 0;
  const { captured, output } = capture();
  const status = await bootstrapCli(["history", "--limit", "--json"], "26.10.0", output, async () => {
    built += 1;
    return fakeContext();
  }, "1.2.3");

  assert.equal(status, 2);
  assert.equal(built, 0);
  const envelope = JSON.parse(captured.stdout);
  const check = validators.get("error");
  assert.ok(check(envelope), JSON.stringify(check.errors));
  assert.equal(envelope.error.code, "invalid-input");
  assert.equal(captured.stderr, "", "the envelope is the whole answer");
});

test("an argument that commands a terminal is not echoed back to it", async () => {
  const { captured, output } = capture();
  const status = await bootstrapCli(["\u001b[2Jwipe\u009b2K"], "26.10.0", output, async () => fakeContext(), "1.2.3");
  assert.equal(status, 2);
  assert.match(captured.stderr, /Unknown Disktop command/);
  assert.doesNotMatch(captured.stderr, /[\u001b\u009b]/);
});

test("an unexpected failure is one sanitized line and exit 2, never a stack trace", async () => {
  const failing = () => {
    const context = fakeContext();
    context.dashboard.inventory = async () => {
      throw new Error("lsblk produced \u001b]0;owned\u0007 something unreadable");
    };
    return context;
  };

  const text = capture();
  assert.equal(await bootstrapCli(["devices"], "26.10.0", text.output, async () => failing(), "1.2.3"), 2);
  assert.equal(text.captured.stdout, "");
  assert.match(text.captured.stderr, /^Disktop could not complete that command: lsblk produced/);
  assert.doesNotMatch(text.captured.stderr, /\u001b|\u0007|\n\s+at /);
  assert.equal(text.captured.stderr.split("\n").filter(Boolean).length, 1);

  const json = capture();
  assert.equal(await bootstrapCli(["devices", "--json"], "26.10.0", json.output, async () => failing(), "1.2.3"), 2);
  const envelope = JSON.parse(json.captured.stdout);
  assert.ok(validators.get("error")(envelope));
  assert.equal(envelope.error.code, "internal-error");
  assert.doesNotMatch(envelope.error.message, /\u001b|\u0007/);
});
