import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createBrowserCacheProvider, createElectronCacheProvider } from "../../dist/providers/caches/index.js";
import { createCacheFixture } from "../fixtures/generate.mjs";
import { discover, discoveryEnvironment, displays } from "../support/discovery.mjs";

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

async function browsers() {
  return discover(createBrowserCacheProvider(), environmentFor());
}

async function electron() {
  return discover(createElectronCacheProvider(), environmentFor());
}

function findByPath(findings, path) {
  return findings.find((finding) => finding.paths.some((candidate) => candidate.display === path));
}

test("a browser profile and its cache are separate findings", async () => {
  const result = await browsers();
  const paths = displays(result.findings);

  assert.ok(paths.includes(fixture.browsers.chromeProfile), JSON.stringify(paths));
  assert.ok(paths.includes(fixture.browsers.chromeCache), JSON.stringify(paths));
  assert.notEqual(
    findByPath(result.findings, fixture.browsers.chromeProfile).id,
    findByPath(result.findings, fixture.browsers.chromeCache).id,
  );
});

test("a profile is in use, offers no action, and says what losing it costs", async () => {
  const result = await browsers();

  for (const path of [fixture.browsers.chromeProfile, fixture.browsers.firefoxProfile]) {
    const profile = findByPath(result.findings, path);
    assert.equal(profile.active, true, `${path} was offered as cache`);
    assert.deepEqual(profile.availableActionIds, [], `${path} offered an action`);
    assert.ok(
      profile.evidence.some((line) => /login|history|bookmark|password/i.test(line)),
      `${path}: ${JSON.stringify(profile.evidence)}`,
    );
  }
});

test("a browser cache directory offers a reviewed Trash action", async () => {
  const result = await browsers();

  for (const path of [fixture.browsers.chromeCache, fixture.browsers.firefoxCache]) {
    const cache = findByPath(result.findings, path);
    assert.equal(cache.active, false, `${path} was treated as profile data`);
    assert.deepEqual(cache.availableActionIds, ["trash"]);
  }
});

test("a cache inside a profile directory is its own finding, not the profile", async () => {
  const result = await browsers();
  const inside = `${fixture.browsers.chromeProfile}/Cache`;

  const found = findByPath(result.findings, inside);
  assert.ok(found !== undefined, `${inside} missing from ${JSON.stringify(displays(result.findings))}`);
  assert.equal(found.active, false);
});

test("an application directory with no cache inside it yields nothing", async () => {
  const result = await electron();

  assert.ok(
    !displays(result.findings).some((path) => path.startsWith(fixture.electron.quiet)),
    "a configuration directory is not an Electron cache",
  );
});

test("an Electron application's caches are found and named after the application", async () => {
  const result = await electron();
  const paths = displays(result.findings);

  assert.ok(paths.includes(`${fixture.electron.slack}/Cache`), JSON.stringify(paths));
  assert.ok(paths.includes(`${fixture.electron.slack}/GPUCache`), JSON.stringify(paths));
  const found = findByPath(result.findings, `${fixture.electron.slack}/Cache`);
  assert.match(found.title, /Slack/);
});

test("an application whose name is not valid UTF-8 still produces a usable finding", async () => {
  const result = await electron();

  const odd = result.findings.find((finding) => finding.paths[0].utf8 === undefined);
  assert.ok(odd !== undefined, `no odd-byte application in ${JSON.stringify(displays(result.findings))}`);
  assert.match(odd.paths[0].display, /^[^\u0000-\u001F\u007F-\u009F]*$/, "display text is sanitized");
  assert.match(odd.id, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/, `${odd.id} is not a valid identifier`);
  assert.equal(
    Buffer.from(odd.paths[0].bytesBase64, "base64").toString("latin1"),
    `${fixture.electron.oddApp}/Cache`,
    "the bytes round-trip",
  );
});

test("browser and Electron findings leave their sizes for the footprint port", async () => {
  for (const result of [await browsers(), await electron()]) {
    for (const finding of result.findings) {
      assert.equal(finding.size.basis, "unknown", `${finding.id} measured its own size`);
    }
  }
});

test("a home with no browser is an absent feature, not an empty one", async () => {
  const result = await discover(createBrowserCacheProvider(), discoveryEnvironment("/home/nobody-at-all"));

  assert.equal(result.capability.status, "missing-tool");
  assert.deepEqual(result.findings, []);
});
