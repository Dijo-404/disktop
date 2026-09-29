import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("help renders and exits cleanly in an 80 by 24 PTY", (context) => {
  const availability = spawnSync("script", ["--version"], { encoding: "utf8" });
  if (availability.error?.code === "ENOENT") {
    context.skip("util-linux script is not installed");
    return;
  }
  assert.equal(availability.status, 0);
  const result = spawnSync(
    "script",
    ["-q", "-e", "-c", "stty rows 24 cols 80; node dist/bin/disktop.js --help", "/dev/null"],
    { encoding: "utf8", env: { ...process.env, NO_COLOR: "1", TERM: "dumb" } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /development scaffold/);
  assert.doesNotMatch(result.stdout, /\u001b\[[0-9;]*[A-Za-z]/);
});
