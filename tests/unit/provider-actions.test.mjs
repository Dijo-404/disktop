import assert from "node:assert/strict";
import { test } from "node:test";
import { createCacheFixture, createDeveloperFixture, createStorageFixture } from "../fixtures/generate.mjs";
import { after } from "node:test";
import { createBuiltInProviders } from "../../dist/providers/index.js";
import { pathBytes, rawPathFromUtf8 } from "../../dist/domain/paths.js";
import { isWithin } from "../../dist/domain/paths.js";
import { PROTECTED_ROOTS } from "../../dist/domain/protected-paths.js";
import { discover, discoveryEnvironment } from "../support/discovery.mjs";

const cleanups = [];
after(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

let cached;

/**
 * Every finding every built-in detector produced against three fixture homes.
 *
 * Caches, developer environments, and game and VM storage between them exercise
 * the detectors that actually offer actions. One home with nothing in it would
 * make these invariants pass by having nothing to check.
 */
async function allFindings() {
  if (cached !== undefined) {
    return cached;
  }
  const findings = [];
  for (const build of [createCacheFixture, createDeveloperFixture, createStorageFixture]) {
    findings.push(...(await findingsFrom(build)));
  }
  void findings;
  // A rule nothing exercises is not a rule.
  assert.ok(findings.length >= 20, `only ${findings.length} findings to check`);
  assert.ok(
    findings.some(({ finding }) => finding.availableActionIds.includes("trash")),
    "no finding offered a generic action, so the scope rules proved nothing",
  );
  assert.ok(
    findings.some(({ finding }) => finding.active),
    "no finding was active, so the in-use rule proved nothing",
  );
  cached = findings;
  return findings;
}

async function findingsFrom(build) {
  const fixture = await build();
  cleanups.push(fixture.cleanup);
  const home = fixture.home ?? fixture.root;
  const environment = discoveryEnvironment(home, {
    index: {
      async directoriesNamed() {
        return { paths: [], searched: true, truncated: false };
      },
      async ownerTotals() {
        return { owners: [], truncated: false, searched: true, complete: true };
      },
    },
  });
  const providers = createBuiltInProviders({
    packages: { async list() { return []; } },
  });

  const findings = [];
  for (const provider of providers) {
    const result = await discover(provider, environment);
    findings.push(...result.findings.map((finding) => ({ finding, home })));
  }
  return findings;
}

/** The actions that act on paths rather than through a package manager. */
function genericActions(finding) {
  return finding.availableActionIds.filter((action) => action !== "manager");
}

test("a generic action is only ever offered on a path inside the home it was given", async () => {
  for (const { finding, home } of await allFindings()) {
    const generic = genericActions(finding);
    if (generic.length === 0) {
      continue;
    }
    const homeBytes = pathBytes(rawPathFromUtf8(home));
    for (const path of finding.paths) {
      assert.equal(
        isWithin(homeBytes, pathBytes(path)),
        true,
        `${finding.id} offers ${generic.join("/")} on ${path.display}, which is outside ${home}`,
      );
      assert.notEqual(
        path.bytesBase64,
        rawPathFromUtf8(home).bytesBase64,
        `${finding.id} offers ${generic.join("/")} on the home directory itself`,
      );
    }
  }
});

test("no detector offers a generic action on a protected system root or below one", async () => {
  for (const { finding } of await allFindings()) {
    const generic = genericActions(finding);
    if (generic.length === 0) {
      continue;
    }
    for (const path of finding.paths) {
      const bytes = pathBytes(path);
      for (const root of PROTECTED_ROOTS) {
        const hit =
          root === "/"
            ? path.display === "/"
            : isWithin(pathBytes(rawPathFromUtf8(root)), bytes);
        assert.equal(
          hit,
          false,
          `${finding.id} offers ${generic.join("/")} on ${path.display}, which is under ${root}`,
        );
      }
    }
  }
});

test("a finding whose data is in use offers no generic action", async () => {
  for (const { finding } of await allFindings()) {
    if (!finding.active) {
      continue;
    }
    assert.deepEqual(
      genericActions(finding),
      [],
      `${finding.id} is active and still offers ${finding.availableActionIds.join("/")}`,
    );
  }
});

test("a finding that names a manager's own state offers only the manager action", async () => {
  for (const { finding } of await allFindings()) {
    if (finding.paths.length > 0) {
      continue;
    }
    assert.equal(
      finding.availableActionIds.every((action) => action === "manager"),
      true,
      `${finding.id} names no path and still offers ${finding.availableActionIds.join("/")}`,
    );
  }
});

test("every action a detector offers is one the domain knows", async () => {
  const known = ["trash", "permanent", "move", "compress", "dedup-hardlink", "manager"];
  for (const { finding } of await allFindings()) {
    for (const action of finding.availableActionIds) {
      assert.ok(known.includes(action), `${finding.id} offers an unknown action '${action}'`);
    }
  }
});
