/** The GitHub Packages mirror is the published npm artifact with one line renamed, and nothing else. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MIRROR_ARCHIVE,
  MIRROR_NAME,
  PUBLISHED_SHA256,
  compareMirror,
  mirrorManifest,
  packMirror,
  stagedPath,
  validateInstalledMirror,
} from "../../scripts/mirror-github-package.mjs";
import { readTarball } from "../../scripts/tarball.mjs";
import { workflowBlock } from "../support/workflows.mjs";

const MANIFEST = `${JSON.stringify({
  name: "disktop",
  version: "1.0.0",
  private: false,
  description: "A \"name\": \"disktop\", inside a value is not the name line",
  bin: { disktop: "./bin.js" },
  files: ["bin.js", "data.txt"],
  repository: { type: "git", url: "git+https://github.com/Dijo-404/disktop.git" },
}, null, 2)}\n`;

const entry = (name, data, mode = 0o644) => ({ name, type: "0", mode, size: Buffer.byteLength(data), data: Buffer.from(data) });
const published = () => [entry("package/package.json", MANIFEST), entry("package/bin.js", "#!/usr/bin/env node\n", 0o755), entry("package/data.txt", "bytes\n")];
const mirrored = () => published().map((item) => (item.name === "package/package.json" ? entry(item.name, mirrorManifest(MANIFEST)) : item));
const sha = (algorithm, bytes) => createHash(algorithm).update(bytes).digest("base64");

test("the mirror manifest changes the top-level name line and nothing else", () => {
  const text = mirrorManifest(MANIFEST);
  const before = MANIFEST.split("\n");
  const after = text.split("\n");
  assert.equal(after.length, before.length);
  assert.deepEqual(after.flatMap((line, index) => (line === before[index] ? [] : [index])), [1]);
  assert.equal(after[1], `  "name": "${MIRROR_NAME}",`);
  assert.deepEqual(JSON.parse(text), { ...JSON.parse(MANIFEST), name: MIRROR_NAME });
});

test("the mirror manifest refuses anything but the published 1.0.0 manifest", () => {
  const manifest = JSON.parse(MANIFEST);
  assert.throws(() => mirrorManifest(MANIFEST.replace('"name": "disktop"', '"name": "other"')), /published disktop package/);
  assert.throws(() => mirrorManifest(MANIFEST.replace('"version": "1.0.0"', '"version": "1.0.1"')), /only the published 1\.0\.0/);
  assert.throws(() => mirrorManifest(JSON.stringify(manifest)), /exactly one top-level name line/);
  assert.throws(() => mirrorManifest(MANIFEST.replace('  "name": "disktop",\n', '  "name": "disktop",\n  "name": "disktop",\n')), /exactly one top-level name line/);
  const nested = `${JSON.stringify({ ...manifest, nested: { name: "disktop", other: 1 } }, null, 2)}\n`;
  assert.deepEqual(JSON.parse(mirrorManifest(nested)).nested, { name: "disktop", other: 1 }, "a nested name is not the package name");
});

test("a mirror differing from the published tarball anywhere else is refused", () => {
  compareMirror(published(), mirrored());
  const changes = [
    [(items) => { items[2].data = Buffer.from("bytez\n"); }, /data\.txt differs/],
    [(items) => { items[1].mode = 0o644; }, /bin\.js changed mode/],
    [(items) => { items.push(entry("package/extra.js", "")); }, /exactly the published files/],
    [(items) => { items.pop(); }, /exactly the published files/],
    [(items) => { items[0] = entry("package/package.json", MANIFEST); }, /package\.json differs/],
    [(items) => { items[0] = entry("package/package.json", mirrorManifest(MANIFEST).replace("1.0.0", "1.0.1")); }, /package\.json differs/],
    [(items) => { items[2].type = "2"; }, /not a regular file/],
    [(items) => { items.push(items[2]); }, /repeats package\/data\.txt/],
  ];
  for (const [change, refusal] of changes) {
    const items = mirrored();
    change(items);
    assert.throws(() => compareMirror(published(), items), refusal);
  }
});

test("a tarball entry never chooses a path outside the staging directory", () => {
  assert.equal(stagedPath("/stage", "package/dist/bin/disktop.js"), "/stage/package/dist/bin/disktop.js");
  for (const name of ["package/../x", "../package/x", "/package/x", "other/x", "package", "package//x", "package/./x", "package/x/"]) {
    assert.throws(() => stagedPath("/stage", name), /unsafe tarball entry/, name);
  }
});

test("pack derives the mirror from a published tarball with npm and refuses any other source", async (context) => {
  const work = await mkdtemp(join(tmpdir(), "disktop-mirror-test-"));
  context.after(() => rm(work, { recursive: true, force: true }));
  await mkdir(join(work, "source"));
  await writeFile(join(work, "source", "package.json"), MANIFEST);
  await writeFile(join(work, "source", "bin.js"), "#!/usr/bin/env node\n");
  await chmod(join(work, "source", "bin.js"), 0o755);
  await writeFile(join(work, "source", "data.txt"), "bytes\n");
  const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", work], { cwd: join(work, "source"), encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const source = join(work, "disktop-1.0.0.tgz");
  const expectedSha256 = createHash("sha256").update(readFileSync(source)).digest("hex");

  await assert.rejects(packMirror(source, join(work, "refused")), /not the audited published tarball/);
  assert.notEqual(expectedSha256, PUBLISHED_SHA256);

  const result = await packMirror(source, join(work, "mirror"), { expectedSha256 });
  assert.equal(result.archive, join(work, "mirror", MIRROR_ARCHIVE));
  const bytes = await readFile(result.archive);
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(result.integrity, `sha512-${sha("sha512", bytes)}`);
  compareMirror(readTarball(source), readTarball(result.archive));
  assert.equal(JSON.parse(readTarball(result.archive).find((item) => item.name === "package/package.json").data).name, MIRROR_NAME);

  await assert.rejects(packMirror(source, join(work, "mirror"), { expectedSha256 }), /EEXIST/, "an existing destination is never reused");
});

test("a clean install must resolve the mirror from GitHub Packages with the archive's digest", () => {
  const bytes = Buffer.from("mirror archive bytes");
  const lock = (resolved, integrity) => ({ packages: { [`node_modules/${MIRROR_NAME}`]: { version: "1.0.0", resolved, integrity } } });
  const github = "https://npm.pkg.github.com/download/@dijo-404/disktop/1.0.0/0123456789abcdef";
  validateInstalledMirror(lock(github, `sha512-${sha("sha512", bytes)}`), bytes);
  validateInstalledMirror(lock(github, `sha512-${sha("sha512", bytes)} sha1-${sha("sha1", bytes)}`), bytes);
  const refusals = [
    [lock("https://registry.npmjs.org/disktop/-/disktop-1.0.0.tgz", `sha512-${sha("sha512", bytes)}`), /resolve from GitHub Packages/],
    [lock(github, `sha512-${sha("sha512", Buffer.from("other"))}`), /sha512 integrity differs/],
    [lock(github, `sha512-${sha("sha512", bytes)} sha1-${sha("sha1", Buffer.from("other"))}`), /sha1 integrity differs/],
    [lock(github, `md5-${createHash("md5").update(bytes).digest("base64")}`), /unrecognised integrity/],
    [lock(github, undefined), /has no integrity/],
    [{ packages: { "node_modules/disktop": { version: "1.0.0", resolved: github } } }, /must install @dijo-404\/disktop@1\.0\.0/],
  ];
  for (const [document, refusal] of refusals) assert.throws(() => validateInstalledMirror(document, bytes), refusal);
});

test("only the protected, dispatched job can publish, and only to GitHub Packages", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/mirror-github-packages.yml", import.meta.url), "utf8");
  const verify = await readFile(new URL("../../.github/workflows/verify-release.yml", import.meta.url), "utf8");
  assert.match(workflow, /^permissions:\n {2}contents: read$/m);
  assert.match(workflow, new RegExp(`^ {2}EXPECTED_SHA256: ${PUBLISHED_SHA256}$`, "m"));
  const commit = /^ {2}EXPECTED_COMMIT: ([0-9a-f]{40})$/m.exec(workflow)?.[1];
  assert.ok(commit !== undefined && verify.includes(`'${commit}'`), "the mirror checks the same tagged commit as release verification");
  assert.match(workflow, /pull_request:\n {4}paths:/);

  const prepare = workflowBlock(workflow, "  prepare:", 2);
  const publish = workflowBlock(workflow, "  publish:", 2);
  assert.doesNotMatch(workflow.replace(publish, ""), /\bsecrets\s*[.[]|NODE_AUTH_TOKEN|packages: write|id-token:|attestations:|npm publish\b|environment:/);
  assert.match(prepare, /verify-registry-release\.mjs download/);
  assert.match(prepare, /mirror-github-package\.mjs pack/);

  assert.match(publish, /^ {4}needs: prepare$/m);
  assert.match(publish, /^ {4}environment: npm-publish$/m);
  assert.match(publish, /github\.event_name == 'workflow_dispatch'/);
  assert.match(publish, /github\.ref_name == github\.event\.repository\.default_branch/);
  assert.match(publish, /inputs\.confirmation == 'MIRROR 1\.0\.0'/);
  assert.match(publish, /^ {6}packages: write$/m);
  assert.match(publish, /^ {10}registry-url: https:\/\/npm\.pkg\.github\.com$/m);
  assert.match(publish, /^ {10}scope: '@dijo-404'$/m);
  assert.doesNotMatch(publish, /registry\.npmjs\.org|--provenance|--registry/);
  assert.deepEqual([...publish.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z_0-9]*)/g)].map((match) => match[1]), ["GITHUB_TOKEN", "GITHUB_TOKEN"]);
  assert.deepEqual([...publish.matchAll(/npm publish\b.*$/gm)].map((match) => match[0]), ['npm publish "$ARCHIVE" --ignore-scripts']);
  const attest = publish.indexOf("uses: actions/attest@");
  const publication = publish.indexOf("npm publish ");
  const verification = publish.indexOf("mirror-github-package.mjs\" installed");
  assert.ok(publish.indexOf("sha256sum --check --strict") < attest && attest < publication && publication < verification, "check, attest, publish, then verify");
});
