import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrapCli, isSupportedNodeVersion } from "../../dist/cli/bootstrap.js";

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

test("CLI bootstrap refuses unsupported runtimes before handling help", () => {
  let stdout = "";
  let stderr = "";
  const output = {
    stdout: (message) => { stdout += message; },
    stderr: (message) => { stderr += message; },
  };

  assert.equal(bootstrapCli(["--help"], "0.0.0", "25.0.0", output), 2);
  assert.equal(stdout, "");
  assert.match(stderr, /requires Node\.js 24\.21\.0.*26\.10\.0.*found 25\.0\.0/);

  stderr = "";
  assert.equal(bootstrapCli(["--version"], "0.0.0", "26.10.0", output), 0);
  assert.equal(stdout, "0.0.0\n");
  assert.equal(stderr, "");
});
