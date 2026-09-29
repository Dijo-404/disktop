import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrapCli, isSupportedNodeVersion } from "../../dist/cli/bootstrap.js";
import { fakeContext } from "../support/cli-context.mjs";

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
  });

  assert.equal(status, 2);
  assert.equal(built, 0, "no service is built on an unsupported runtime");
  assert.equal(captured.stdout, "");
  assert.match(captured.stderr, /requires Node\.js 24\.21\.0.*26\.10\.0.*found 25\.0\.0/);
});

test("a supported runtime reaches the CLI", async () => {
  const context = fakeContext();
  const status = await bootstrapCli(["--version"], "26.10.0", context.output, async () => context);
  assert.equal(status, 0);
  assert.equal(context.captured.stdout, "1.2.3\n");
});
