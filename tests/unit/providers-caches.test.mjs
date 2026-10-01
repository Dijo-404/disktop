import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createAiCacheProvider, createIdeCacheProvider, createLanguageCacheProvider } from "../../dist/providers/caches/index.js";
import { createCacheFixture } from "../fixtures/generate.mjs";
import { byId, discover, discoveryEnvironment, displays } from "../support/discovery.mjs";

let fixture;

before(async () => {
  fixture = await createCacheFixture();
});

after(async () => {
  await fixture.cleanup();
});

function environmentFor() {
  return discoveryEnvironment(fixture.home);
}

async function allFindings() {
  const results = await Promise.all(
    [createLanguageCacheProvider(), createAiCacheProvider(), createIdeCacheProvider()].map((provider) =>
      discover(provider, environmentFor()),
    ),
  );
  return results.flatMap((result) => result.findings);
}

test("a cache root that exists becomes exactly one finding", async () => {
  const paths = displays(await allFindings());

  for (const [name, path] of Object.entries(fixture.roots)) {
    assert.equal(paths.filter((candidate) => candidate === path).length, 1, `${name} was not reported exactly once`);
  }
});

test("a root that is not there produces no finding and no warning", async () => {
  const result = await discover(createLanguageCacheProvider(), environmentFor());

  const paths = displays(result.findings);
  assert.ok(!paths.some((path) => path.includes(".m2")), "no Maven repository exists in the fixture");
  assert.deepEqual(result.warnings, []);
  assert.equal(result.complete, true);
});

test("a model store is marked in use and a package cache is not", async () => {
  const found = byId(await allFindings());

  const huggingface = [...found.values()].find((finding) => finding.paths[0].display === fixture.roots.huggingface);
  const android = [...found.values()].find((finding) => finding.paths[0].display === fixture.roots.androidSdk);
  const npm = [...found.values()].find((finding) => finding.paths[0].display === fixture.roots.npm);

  assert.equal(huggingface.active, true, "downloaded model weights are not disposable cache");
  assert.equal(android.active, true, "an SDK is not disposable cache");
  assert.equal(npm.active, false);
  assert.deepEqual(npm.availableActionIds, ["trash"]);
});

test("every cache finding says what getting the data back would cost", async () => {
  for (const finding of await allFindings()) {
    assert.ok(
      finding.regenerationCost !== undefined && finding.regenerationCost.length > 0,
      `${finding.id} does not say what regenerating it costs`,
    );
  }
});

test("no two cache findings share an id, and each id is a valid identifier", async () => {
  const findings = await allFindings();
  const ids = findings.map((finding) => finding.id);

  assert.equal(new Set(ids).size, ids.length, `duplicate id in ${JSON.stringify(ids)}`);
  for (const id of ids) {
    assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
  }
});

test("a cache finding leaves its size for the footprint port", async () => {
  for (const finding of await allFindings()) {
    assert.equal(finding.size.basis, "unknown");
    assert.equal(finding.size.bytes, undefined);
  }
});

test("a home with none of these roots reports an absent feature, not an empty one", async () => {
  for (const provider of [createLanguageCacheProvider(), createAiCacheProvider(), createIdeCacheProvider()]) {
    const result = await discover(provider, discoveryEnvironment("/home/nobody-at-all"));
    assert.equal(result.capability.status, "missing-tool", provider.id);
    assert.deepEqual(result.findings, []);
  }
});

test("the ids of the fixed cache roots do not move when a home directory does", async () => {
  const here = await discover(createLanguageCacheProvider(), environmentFor());
  const elsewhere = await discover(
    createLanguageCacheProvider(),
    discoveryEnvironment(fixture.home, { variables: {} }),
  );

  assert.deepEqual(
    here.findings.map((finding) => finding.id),
    elsewhere.findings.map((finding) => finding.id),
  );
  assert.ok(here.findings.some((finding) => finding.id === "cache.language:npm"), JSON.stringify(here.findings.map((f) => f.id)));
});
