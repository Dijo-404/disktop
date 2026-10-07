import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainerAdapter } from "../../dist/platform/linux/managers/containers.js";
import { createFlatpakAdapter } from "../../dist/platform/linux/managers/flatpak.js";
import { createJournaldAdapter } from "../../dist/platform/linux/managers/journald.js";
import { createKernelAdapter } from "../../dist/platform/linux/managers/kernels.js";
import { createPackageCacheAdapters } from "../../dist/platform/linux/managers/package-cache.js";
import { createSnapAdapter } from "../../dist/platform/linux/managers/snap.js";
import { createTmpfilesAdapter } from "../../dist/platform/linux/managers/tmpfiles.js";
import { createManagerInventory } from "../../dist/platform/linux/managers/index.js";
import { createPackageInventory } from "../../dist/platform/linux/packages/index.js";

const AVAILABLE = { status: "available", explanation: "Answered" };
const emptyPaths = { async facts() {}, async list() { return []; }, async readText() {} };

test("every manager discovery query receives its task signal and a refresh reads live state", async () => {
  const calls = [];
  const tools = {
    async run(name, args, signal) {
      calls.push({ name, args, signal });
      return { capability: AVAILABLE, stdout: name === "journalctl" ? "Archived and active journals take up 1.0G in the file system.\n" : "", stderr: "", exitCode: 0 };
    },
  };
  const installed = async () => true;
  const adapters = [
    createJournaldAdapter({ tools, keepBytes: 1n }),
    createSnapAdapter({ tools, paths: emptyPaths }),
    createFlatpakAdapter({ tools, home: "/home/example" }),
    createContainerAdapter("docker", { tools }),
    createTmpfilesAdapter({ tools, installed }),
    createKernelAdapter({ tools, installed, runningRelease: () => "current", kernelReleases: async () => new Set() }),
    ...createPackageCacheAdapters({ tools, paths: emptyPaths, installed }),
  ];
  const inventory = createManagerInventory(adapters);
  const first = new AbortController().signal;
  await inventory.discover(first);
  const before = calls.length;
  assert.ok(before >= 10, "all of the query-based manager families were exercised");
  assert.ok(calls.every((call) => call.signal === first));
  await inventory.discover(first);
  assert.equal(calls.length, before, "one task shares its existing reading");
  const next = new AbortController().signal;
  await inventory.discover(next);
  assert.equal(calls.length, 2 * before, "a fresh task refreshes every manager instead of retaining stale findings");
  assert.ok(calls.slice(before).every((call) => call.signal === next));
});

test("manager discovery cancellation stops remaining queries and previews carry their signal", async () => {
  const controller = new AbortController();
  let calls = 0;
  const tools = {
    async run(_name, _args, signal) {
      calls += 1;
      assert.equal(signal, controller.signal);
      controller.abort();
      return { capability: AVAILABLE, stdout: "", stderr: "", exitCode: 0 };
    },
  };
  const adapter = createContainerAdapter("docker", { tools });
  await assert.rejects(adapter.preview("docker.remove-dangling-images", {}, controller.signal), { name: "AbortError" });
  assert.equal(calls, 1, "a cancelled query cannot go on to list containers, volumes and cache");
  await assert.rejects(adapter.discover(controller.signal), { name: "AbortError" });
  assert.equal(calls, 1, "an already-cancelled discovery starts no tool");
});

test("package inventories share a task reading, refresh on a new task, and stop at cancellation", async () => {
  const calls = [];
  const tools = {
    async run(name, _args, signal) {
      calls.push({ name, signal });
      return { capability: AVAILABLE, stdout: "", stderr: "", exitCode: 0 };
    },
  };
  const packages = createPackageInventory(tools);
  const first = new AbortController().signal;
  await packages.list(first);
  await packages.list(first);
  assert.equal(calls.length, 7);
  assert.ok(calls.every((call) => call.signal === first));
  const next = new AbortController().signal;
  await packages.list(next);
  assert.equal(calls.length, 14);
  assert.ok(calls.slice(7).every((call) => call.signal === next));
  const controller = new AbortController();
  let stoppedCalls = 0;
  const cancelled = createPackageInventory({
    async run(_name, _args, signal) {
      assert.equal(signal, controller.signal);
      stoppedCalls += 1;
      controller.abort();
      return { capability: AVAILABLE, stdout: "", stderr: "", exitCode: 0 };
    },
  });
  await assert.rejects(cancelled.list(controller.signal), { name: "AbortError" });
  assert.equal(stoppedCalls, 1);
  await assert.rejects(cancelled.list(controller.signal), { name: "AbortError" });
  assert.equal(stoppedCalls, 1);
});
