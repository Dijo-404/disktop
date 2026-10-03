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

test("this host's journal and Flatpak installations are read without changing either", async (t) => {
  const { createJournaldAdapter } = await import("../../dist/platform/linux/managers/journald.js");
  const { createFlatpakAdapter } = await import("../../dist/platform/linux/managers/flatpak.js");
  const ports = await hostPorts();
  const journal = await createJournaldAdapter({ tools: ports.tools, keepBytes: 536_870_912n }).discover();
  if (journal.capability.status === "missing-tool") {
    t.skip("journalctl is not installed here");
  } else {
    assert.equal(journal.capability.status, "available");
    assert.equal(journal.proposals[0].bytesBasis, "manager-reported");
  }
  const flatpak = await createFlatpakAdapter({ tools: ports.tools, home: process.env.HOME ?? "/" }).discover();
  assert.ok(["available", "missing-tool"].includes(flatpak.capability.status));
});

test("this host's Docker is read, and no named volume is ever selectable", async (t) => {
  const { createContainerAdapter } = await import("../../dist/platform/linux/managers/containers.js");
  const { MANAGER_ACTIONS } = await import("../../dist/domain/managers.js");
  const discovery = await createContainerAdapter("docker", { tools: (await hostPorts()).tools }).discover();
  if (discovery.capability.status !== "available") {
    t.skip(`docker is not usable here: ${discovery.capability.explanation}`);
    return;
  }
  const named = new Set(
    spawnSync("docker", ["volume", "ls", "--filter", "dangling=true", "--format", "{{.Name}}\t{{.Labels}}"], { encoding: "utf8" })
      .stdout.split("\n")
      .filter((line) => line !== "" && !line.includes("com.docker.volume.anonymous="))
      .map((line) => line.split("\t")[0]),
  );
  for (const proposal of discovery.proposals) {
    const pattern = MANAGER_ACTIONS[proposal.action].itemPattern;
    for (const item of proposal.items) {
      assert.match(item.id, pattern);
      assert.equal(named.has(item.id), false, `${item.id} is a named volume`);
    }
  }
  const reported = discovery.proposals.find((proposal) => proposal.slug === "docker.named-volumes");
  if (named.size > 0) {
    assert.equal(reported.offered, false);
  }
});

test("this host's kernels are judged by its own package manager, and the running one is never proposed", async () => {
  const { createKernelAdapter } = await import("../../dist/platform/linux/managers/kernels.js");
  const { release } = await import("node:os");
  const ports = await hostPorts();
  const { readdirSync } = await import("node:fs");
  const kernelReleases = async () => {
    try {
      return new Set(readdirSync("/lib/modules"));
    } catch {
      return new Set();
    }
  };
  const discovery = await createKernelAdapter({ tools: ports.tools, runningRelease: release, installed: ports.installed, kernelReleases }).discover();
  for (const proposal of discovery.proposals) {
    for (const item of proposal.items) {
      assert.equal(item.id.endsWith(release()), false, `${item.id} belongs to the running kernel`);
    }
  }
  if (discovery.proposals.length === 0) {
    assert.ok(discovery.capability.explanation.length > 0);
  }
});

test("this host's tmpfiles policies are previewed by dry run and nothing is cleaned", async (t) => {
  const { createTmpfilesAdapter } = await import("../../dist/platform/linux/managers/tmpfiles.js");
  const ports = await hostPorts();
  const discovery = await createTmpfilesAdapter(ports).discover();
  if (discovery.capability.status === "missing-tool") {
    t.skip("systemd-tmpfiles is not installed here");
    return;
  }
  assert.equal(discovery.proposals.length, 3);
  for (const proposal of discovery.proposals) {
    assert.ok(["simulated", "none"].includes(proposal.preview));
    assert.deepEqual(proposal.items, []);
  }
});
