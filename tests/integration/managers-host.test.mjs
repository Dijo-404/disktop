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

async function hostPorts() {
  const { createToolPort } = await import("../../dist/platform/linux/tools.js");
  const { createPathProbe } = await import("../../dist/platform/linux/probe.js");
  const { resolveTrustedExecutable } = await import("../../dist/platform/linux/process.js");
  return {
    tools: createToolPort(),
    paths: createPathProbe(),
    installed: async (tool) => (await resolveTrustedExecutable(tool)) !== undefined,
  };
}

test("pacman's cache on this host is read, and every offered item is a name Disktop would hand it", async (t) => {
  const { createPackageCacheAdapters } = await import("../../dist/platform/linux/managers/package-cache.js");
  const { MANAGER_ACTIONS } = await import("../../dist/domain/managers.js");
  const pacman = createPackageCacheAdapters(await hostPorts()).find((adapter) => adapter.id === "pacman");
  const discovery = await pacman.discover();
  if (discovery.capability.status === "missing-tool") {
    t.skip("pacman is not installed here");
    return;
  }
  assert.equal(discovery.capability.status, "available");
  const pattern = MANAGER_ACTIONS["pacman.clean-uninstalled"].itemPattern;
  for (const proposal of discovery.proposals) {
    for (const item of proposal.items) {
      assert.match(item.id, pattern);
    }
  }
});
