/**
 * The GitHub Packages mirror of the published npm release. Never builds.
 *
 * GitHub's npm registry accepts only packages scoped to their owner, so
 * `disktop@1.0.0` is mirrored there as `@dijo-404/disktop@1.0.0`: the exact
 * tarball npm serves, with the `name` line of its package.json changed and
 * nothing else. `pack` makes that tarball from the published one and proves
 * every other entry is byte-for-byte unchanged; `installed` checks that a clean
 * install resolved the mirror from GitHub Packages with that tarball's digest.
 * Publishing is `.github/workflows/mirror-github-packages.yml`'s protected job.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readTarball } from "./tarball.mjs";

export const SOURCE_NAME = "disktop";
export const MIRROR_NAME = "@dijo-404/disktop";
export const VERSION = "1.0.0";
export const MIRROR_ARCHIVE = "dijo-404-disktop-1.0.0.tgz";
/** The audited `disktop-1.0.0.tgz` npm serves; see docs/release-readiness.md. */
export const PUBLISHED_SHA256 = "a2deddd76c137e349370fb839b887baff14b3ec27c649f1ce809616bf8b39acd";
const MIRROR_ORIGIN = "https://npm.pkg.github.com";
const MANIFEST = "package/package.json";
const NAME_LINE = /^ {2}"name": "disktop",$/gm;

const digest = (algorithm, bytes, encoding) => createHash(algorithm).update(bytes).digest(encoding);

/** The published package.json text with only its name line changed. */
export function mirrorManifest(text) {
  const manifest = JSON.parse(text);
  assert.equal(manifest.name, SOURCE_NAME, "the source must be the published disktop package");
  assert.equal(manifest.version, VERSION, "only the published 1.0.0 is mirrored");
  assert.equal(text.match(NAME_LINE)?.length, 1, "the manifest must have exactly one top-level name line");
  const mirrored = text.replace(NAME_LINE, `  "name": "${MIRROR_NAME}",`);
  assert.deepEqual(JSON.parse(mirrored), { ...manifest, name: MIRROR_NAME });
  return mirrored;
}

function byName(entries, label) {
  const map = new Map();
  for (const entry of entries) {
    assert.equal(entry.type, "0", `${label} ${entry.name} is not a regular file`);
    assert.ok(!map.has(entry.name), `${label} repeats ${entry.name}`);
    map.set(entry.name, entry);
  }
  return map;
}

/** Refuses a mirror whose entries differ from the published ones anywhere but the name line. */
export function compareMirror(published, mirror) {
  const source = byName(published, "the published tarball");
  const copy = byName(mirror, "the mirror");
  assert.ok(source.has(MANIFEST), "the published tarball has no package.json");
  assert.deepEqual([...copy.keys()].sort(), [...source.keys()].sort(), "the mirror must hold exactly the published files");
  for (const [name, entry] of source) {
    const other = copy.get(name);
    assert.equal(other.mode, entry.mode, `${name} changed mode`);
    const expected = name === MANIFEST ? Buffer.from(mirrorManifest(entry.data.toString("utf8"))) : entry.data;
    assert.ok(other.data.equals(expected), `${name} differs from the published artifact`);
  }
}

/** Every path stays under the staging directory; a published name never chooses where to write. */
export function stagedPath(stage, name) {
  const segments = name.split("/");
  assert.ok(
    segments.length > 1 && segments[0] === "package" && segments.every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    `unsafe tarball entry ${JSON.stringify(name)}`,
  );
  return join(stage, ...segments);
}

/** Writes `destination/dijo-404-disktop-1.0.0.tgz`; `destination` must not exist yet. */
export async function packMirror(source, destination, { expectedSha256 = PUBLISHED_SHA256, npm = "npm" } = {}) {
  assert.equal(digest("sha256", await readFile(source), "hex"), expectedSha256, "the source is not the audited published tarball");
  const published = readTarball(source);
  const stage = await mkdtemp(join(tmpdir(), "disktop-mirror-"));
  try {
    for (const entry of byName(published, "the published tarball").values()) {
      const path = stagedPath(stage, entry.name);
      await mkdir(dirname(path), { recursive: true });
      const data = entry.name === MANIFEST ? mirrorManifest(entry.data.toString("utf8")) : entry.data;
      await writeFile(path, data, { flag: "wx" });
      await chmod(path, entry.mode);
    }
    await mkdir(destination);
    const packed = spawnSync(npm, ["pack", "--ignore-scripts", "--pack-destination", destination], {
      cwd: join(stage, "package"),
      encoding: "utf8",
      shell: false,
    });
    assert.equal(packed.error, undefined, packed.error?.message);
    assert.equal(packed.status, 0, packed.stderr);
    assert.deepEqual(await readdir(destination), [MIRROR_ARCHIVE], "npm pack must write exactly the mirror archive");
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  const archive = join(destination, MIRROR_ARCHIVE);
  compareMirror(published, readTarball(archive));
  const bytes = await readFile(archive);
  return { archive, sha256: digest("sha256", bytes, "hex"), integrity: `sha512-${digest("sha512", bytes, "base64")}` };
}

/** Checks a clean install's lockfile: the mirror, from GitHub Packages, with the archive's digest. */
export function validateInstalledMirror(lock, archiveBytes) {
  const installed = lock.packages?.[`node_modules/${MIRROR_NAME}`];
  assert.equal(installed?.version, VERSION, `the consumer must install ${MIRROR_NAME}@${VERSION}`);
  assert.equal(new URL(installed.resolved).origin, MIRROR_ORIGIN, "the mirror must resolve from GitHub Packages");
  const hashes = (installed.integrity ?? "").split(/\s+/).filter(Boolean);
  assert.ok(hashes.length > 0, "the installed mirror has no integrity");
  for (const hash of hashes) {
    const [, algorithm, value] = /^(sha512|sha256|sha1)-([A-Za-z0-9+/]+={0,2})$/.exec(hash) ?? [];
    assert.ok(algorithm !== undefined, `unrecognised integrity ${hash}`);
    assert.equal(value, digest(algorithm, archiveBytes, "base64"), `${algorithm} integrity differs from the mirror archive`);
  }
}

async function main() {
  const [mode, first, second] = process.argv.slice(2);
  if (mode === "pack") {
    const { archive, sha256, integrity } = await packMirror(first, second);
    process.stdout.write(`archive=${archive}\nsha256=${sha256}\nintegrity=${integrity}\n`);
  } else if (mode === "installed") {
    const lock = JSON.parse(await readFile(join(second, "package-lock.json"), "utf8"));
    validateInstalledMirror(lock, await readFile(first));
    process.stdout.write(`Installed ${MIRROR_NAME}@${VERSION} from GitHub Packages matches ${first}\n`);
  } else {
    throw new Error("usage: mirror-github-package.mjs pack <disktop-1.0.0.tgz> <new-directory> | installed <mirror.tgz> <consumer-directory>");
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
