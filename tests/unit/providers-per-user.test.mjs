import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPerUserProvider } from "../../dist/providers/diagnostics/index.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";
import { restoreAndRemove } from "../fixtures/generate.mjs";
import { discover, discoveryEnvironment } from "../support/discovery.mjs";

const OWNERS = [
  { ownerId: 1000n, entries: 418_223n, allocatedBytes: 214_748_364_800n, apparentBytes: 214_203_768_832n },
  { ownerId: 0n, entries: 90_114n, allocatedBytes: 12_884_901_888n, apparentBytes: 12_871_168_000n },
];

function index(reading) {
  return {
    async directoriesNamed() {
      return { paths: [], searched: false };
    },
    async ownerTotals() {
      return reading;
    },
  };
}

let root;
let passwd;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "disktop-fixture-"));
  passwd = join(root, "passwd");
  await writeFile(passwd, "root:x:0:0::/root:/bin/bash\nexample:x:1000:1000::/home/example:/bin/zsh\n");
});

after(async () => {
  await restoreAndRemove(root);
});

function providerFor() {
  return createPerUserProvider({ passwdFile: rawPathFromUtf8(passwd) });
}

test("each owner becomes a finding named from /etc/passwd", async () => {
  const result = await discover(
    providerFor(),
    discoveryEnvironment(root, { index: index({ owners: OWNERS, searched: true, complete: true }) }),
  );

  assert.deepEqual(
    result.findings.map((finding) => finding.title),
    ["example owns 418223 files in the last scan", "root owns 90114 files in the last scan"],
  );
  assert.equal(result.findings[0].size.bytes, 214_748_364_800n);
  assert.equal(result.findings[0].size.basis, "measured-allocated");
});

test("an unreadable passwd file falls back to the numeric id and says so", async () => {
  const result = await discover(
    createPerUserProvider({ passwdFile: rawPathFromUtf8(join(root, "absent-passwd")) }),
    discoveryEnvironment(root, { index: index({ owners: OWNERS, searched: true, complete: true }) }),
  );

  assert.match(result.findings[0].title, /^User 1000 owns/);
  assert.ok(result.warnings.some((warning) => warning.code === "passwd-unreadable"), JSON.stringify(result.warnings));
});

test("totals from a partial scan are a floor, and the finding says which", async () => {
  const result = await discover(
    providerFor(),
    discoveryEnvironment(root, { index: index({ owners: OWNERS, searched: true, complete: false }) }),
  );

  assert.equal(result.complete, false);
  assert.equal(result.findings[0].confidence, "uncertain");
  assert.match(result.findings[0].size.explanation, /larger/);
  assert.ok(
    result.findings[0].evidence.some((line) => /floor and not a total/.test(line)),
    JSON.stringify(result.findings[0].evidence),
  );
});

test("no stored scan means nobody was counted, not that nobody owns anything", async () => {
  const result = await discover(
    providerFor(),
    discoveryEnvironment(root, { index: index({ owners: [], searched: false, complete: false }) }),
  );

  assert.deepEqual(result.findings, []);
  assert.equal(result.complete, false);
  assert.ok(result.warnings.some((warning) => warning.code === "no-stored-scan"));
});

test("per-user usage offers no action at all", async () => {
  const result = await discover(
    providerFor(),
    discoveryEnvironment(root, { index: index({ owners: OWNERS, searched: true, complete: true }) }),
  );

  for (const finding of result.findings) {
    assert.deepEqual(finding.availableActionIds, []);
    assert.equal(finding.category, "per-user-usage");
  }
});
