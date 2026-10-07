import assert from "node:assert/strict";
import { test } from "node:test";
import { createFootprintService } from "../../dist/application/footprint.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";
import { createManagerInventory } from "../../dist/platform/linux/managers/index.js";
import { createPackageCacheAdapters } from "../../dist/platform/linux/managers/package-cache.js";
import { createManagerProvider } from "../../dist/providers/managers/index.js";
import { discoveryEnvironment } from "../support/discovery.mjs";

const ROOT = "/var/cache/libdnf5";
const PER_DIRECTORY = 4000;
const LIMIT = 10_000;

function cache(entryCount, kind = "packages") {
  const repositories = Math.ceil(entryCount / PER_DIRECTORY);
  const recorded = { fileFacts: 0, directoryFacts: 0, packageLists: 0 };
  const paths = {
    async list(path) {
      if (path.display === ROOT) {
        return Array.from({ length: repositories }, (_, index) => rawPathFromUtf8(`${ROOT}/repository-${index}`));
      }
      const match = /^\/var\/cache\/libdnf5\/repository-(\d+)\/packages$/.exec(path.display);
      if (match === null) return [];
      recorded.packageLists += 1;
      const start = Number(match[1]) * PER_DIRECTORY;
      return Array.from({ length: Math.min(PER_DIRECTORY, entryCount - start) }, (_, offset) => {
        const name = kind === "ignored" ? `note-${start + offset}.txt`
          : kind === "duplicates" ? `package-${offset}-1-1.fc44.x86_64.rpm`
          : `package-${start + offset}-1-1.fc44.x86_64.rpm`;
        return rawPathFromUtf8(`${path.display}/${name}`);
      });
    },
    async facts(path) {
      const directory = path.display.endsWith("/packages");
      if (directory) recorded.directoryFacts += 1;
      else recorded.fileFacts += 1;
      return {
        kind: directory ? "directory" : "file", apparentBytes: 1n, allocatedBytes: 1n,
        ownerId: 0n, modifiedNanoseconds: 1n, device: 1n, inode: 1n, mountId: "1",
      };
    },
    async readText() { return undefined; },
  };
  const environment = discoveryEnvironment("/home/cache-test", { paths });
  const adapters = createPackageCacheAdapters({
    paths, tools: environment.tools, installed: async (tool) => tool === "dnf", roots: { dnf: [ROOT] },
  });
  const adapter = adapters.find((candidate) => candidate.id === "dnf");
  return { adapter, inventory: createManagerInventory([adapter]), environment, recorded };
}

test("DNF reports an exact complete count at the global cache bound across multiple repositories", async () => {
  const { adapter, recorded } = cache(LIMIT);
  const discovery = await adapter.discover(new AbortController().signal);
  assert.equal(discovery.capability.status, "available");
  assert.deepEqual(discovery.warnings, []);
  assert.equal(discovery.proposals.length, 1);
  const [proposal] = discovery.proposals;
  assert.equal(proposal.items.length, LIMIT);
  assert.equal(new Set(proposal.items.map((item) => item.id)).size, LIMIT);
  assert.deepEqual(proposal.count, { kind: "exact", value: BigInt(LIMIT) });
  assert.equal(proposal.estimatedBytes, BigInt(LIMIT));
  assert.equal(proposal.offered, true);
  assert.deepEqual(recorded, { fileFacts: LIMIT, directoryFacts: 3, packageLists: 3 });
});

test("a global DNF cache overflow is incomplete and refuses preview with bounded metadata work", async () => {
  for (const kind of ["packages", "duplicates", "ignored"]) {
    const { inventory, environment, recorded } = cache(12_000, kind);
    const service = createFootprintService([createManagerProvider(inventory)], environment, {
      async measure() { throw new Error("An overflowing cache must not request measurement"); },
    });
    const summary = await service.discover({ measureSizes: false }, new AbortController().signal);
    assert.equal(summary.complete, false, kind);
    assert.equal(summary.providers[0].complete, false, kind);
    assert.deepEqual(summary.findings, [], "overflow must never become an exact sampled count");
    assert.ok(summary.warnings.some((warning) => warning.code === "manager-failed"
      && warning.message.includes(`${ROOT}/repository-2/packages`)
      && /10000/.test(warning.message)
      && /disktop scan/.test(warning.message)), kind);
    const expected = { fileFacts: kind === "ignored" ? 0 : LIMIT, directoryFacts: 3, packageLists: 3 };
    assert.deepEqual(recorded, expected, "the overflow entry must not be statted and all retained work is bounded");
    await assert.rejects(inventory.preview("dnf.clean-packages", {}, new AbortController().signal), (error) => {
      assert.equal(error.code, "EOVERFLOW");
      assert.match(error.message, /dnf\.clean-packages.*10000/);
      assert.ok(error.message.includes(`${ROOT}/repository-2/packages`));
      return true;
    });
    assert.deepEqual(recorded, Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, value * 2])));
    assert.deepEqual(environment.recorded.tools, [], "discovery and refused preview invoke no cleanup command");
  }
});
