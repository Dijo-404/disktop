import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readOwnFile, writeFileAtomically } from "../../dist/storage/files.js";

const sandboxes = [];

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "disktop-files-"));
  sandboxes.push(root);
  return root;
}

after(async () => {
  for (const root of sandboxes) {
    await rm(root, { recursive: true, force: true });
  }
});

test("an atomic write publishes the whole file with its mode, and leaves nothing beside it", async () => {
  const root = await sandbox();
  const target = join(root, "config.json");
  await writeFile(target, "old");
  await writeFileAtomically(target, "new contents", 0o600);
  assert.equal(await readFile(target, "utf8"), "new contents");
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(root), ["config.json"]);
});

test("an atomic write that cannot publish removes its staging file and keeps the old one", async () => {
  const root = await sandbox();
  // A non-empty directory where the file should go makes the rename fail
  // after the staging file has been written.
  const target = join(root, "occupied");
  await mkdir(target);
  await writeFile(join(target, "inside"), "kept");
  await assert.rejects(() => writeFileAtomically(target, "never published", 0o600));
  assert.deepEqual(await readdir(root), ["occupied"], "no .partial file is left behind");
  assert.equal(await readFile(join(target, "inside"), "utf8"), "kept");
});

test("a pipe, a device, or an oversized file is refused before it is read", async () => {
  const root = await sandbox();
  const pipe = join(root, "pipe");
  assert.equal(spawnSync("mkfifo", [pipe]).status, 0);
  const zero = join(root, "zero");
  await symlink("/dev/zero", zero);
  const large = join(root, "large");
  await writeFile(large, "x".repeat(2048));

  const begun = Date.now();
  await assert.rejects(() => readOwnFile(pipe, 1024, { followSymlinks: true }), /not a regular file/);
  await assert.rejects(() => readOwnFile(zero, 1024, { followSymlinks: true }), /not a regular file/);
  await assert.rejects(() => readOwnFile(large, 1024, { followSymlinks: true }), /more than the 1024/);
  assert.ok(Date.now() - begun < 2_000, "nothing waited on a writer that never came");
});

test("a link is refused where the caller says links are not expected", async () => {
  const root = await sandbox();
  const real = join(root, "real");
  await writeFile(real, "{}");
  const link = join(root, "link");
  await symlink(real, link);
  assert.equal(await readOwnFile(link, 1024, { followSymlinks: true }), "{}");
  await assert.rejects(() => readOwnFile(link, 1024, { followSymlinks: false }));
});
