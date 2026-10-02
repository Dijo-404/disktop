/**
 * Read-only checks against this host's real managers. Nothing here changes
 * anything: a root command is only ever sent where sudo will refuse it, and
 * every other call is a query.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createCommandRunner } from "../../dist/platform/linux/privilege.js";

function sudoNeedsAPassword() {
  const probe = spawnSync("/usr/bin/sudo", ["-n", "true"], { encoding: "utf8" });
  return probe.error === undefined && probe.status !== 0 && /password is required/.test(probe.stderr);
}

test("a root command with no terminal to ask for a password is denied, and nothing runs", async (t) => {
  if (!sudoNeedsAPassword()) {
    t.skip("sudo is absent here or runs without a password, so a refusal cannot be observed");
    return;
  }
  const runner = createCommandRunner();
  const run = await runner.run({ tool: "journalctl", arguments: ["--disk-usage"] }, "root", {
    interactive: false,
    signal: new AbortController().signal,
  });
  assert.equal(run.status, "denied");
  assert.match(run.explanation, /password/);
});
