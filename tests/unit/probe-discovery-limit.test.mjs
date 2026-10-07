import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFootprintService } from "../../dist/application/footprint.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";
import { createManagerInventory } from "../../dist/platform/linux/managers/index.js";
import { createPackageCacheAdapters } from "../../dist/platform/linux/managers/package-cache.js";
import { createInstalledAppsProvider } from "../../dist/providers/apps/installed.js";
import { createManagerProvider } from "../../dist/providers/managers/index.js";
import { discoveryEnvironment } from "../support/discovery.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "disktop-discovery-limit-"));
  try {
    const directory = join(root, "large-directory");
    await mkdir(directory);
    for (let start = 0; start < 4095; start += 64) {
      await Promise.all(Array.from({ length: Math.min(64, 4095 - start) }, (_, offset) =>
        writeFile(join(directory, `${String(start + offset).padStart(5, "0")}.txt`), "")));
    }
    await writeFile(join(directory, "zzzz.AppImage"), "app image");
    await writeFile(join(directory, "zzzz_1_all.deb"), "cached package");
    return { root, directory };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

const noMeasurement = {
  async measure() { throw new Error("An incomplete directory listing must not ask for a footprint measurement"); },
};

test("an AppImage beyond the discovery directory bound cannot be reported as a complete empty result", async () => {
  const { root, directory } = await fixture();
  try {
    const provider = createInstalledAppsProvider({
      async list() {
        return [{ manager: "dpkg", capability: { status: "available", explanation: "Answered" }, packages: [], sizeMeaning: "Reported" }];
      },
    });
    const environment = discoveryEnvironment(root, { appImageRoots: [rawPathFromUtf8(directory)] });
    const service = createFootprintService([provider], environment, noMeasurement);
    const summary = await service.discover({ measureSizes: false }, new AbortController().signal);
    assert.equal(summary.complete, false);
    assert.equal(summary.providers[0].complete, false);
    assert.equal(summary.providers[0].ran, false);
    assert.deepEqual(summary.findings, []);
    assert.ok(summary.warnings.some((warning) => warning.code === "provider-failed" && warning.message.includes(directory) && /4096/.test(warning.message)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an overflowing apt cache is incomplete, offers no exact sampled count, and cannot produce a reviewed preview", async () => {
  const { root, directory } = await fixture();
  try {
    const environment = discoveryEnvironment(root);
    const adapters = createPackageCacheAdapters({
      tools: environment.tools, paths: environment.paths,
      installed: async (name) => name === "apt-get", roots: { apt: directory },
    });
    const inventory = createManagerInventory(adapters);
    const provider = createManagerProvider(inventory);
    const service = createFootprintService([provider], environment, noMeasurement);
    const summary = await service.discover({ measureSizes: false }, new AbortController().signal);
    assert.equal(summary.complete, false);
    assert.equal(summary.providers[0].complete, false);
    assert.deepEqual(summary.findings, [], "a sampled cache count must never become a manager finding");
    assert.ok(summary.warnings.some((warning) => warning.code === "manager-failed" && warning.message.includes(directory) && /4096/.test(warning.message)));
    await assert.rejects(inventory.preview("apt.clean", {}, new AbortController().signal), { code: "EOVERFLOW" });
    assert.deepEqual(environment.recorded.tools, [], "no cleanup command is invoked by discovery or preview");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
