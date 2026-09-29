import assert from "node:assert/strict";
import { lstat, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createLargeFixture, createStandardFixture } from "../fixtures/generate.mjs";

test("the standard tree reproduces the filesystem shapes the scanner must survive", async (t) => {
  const fixture = await createStandardFixture();
  t.after(() => fixture.cleanup());

  assert.ok(fixture.root.startsWith(tmpdir()), "fixtures only ever live in a temporary sandbox");

  const byName = new Map(fixture.manifest.map((entry) => [entry.name, entry]));
  for (const required of [
    "plain-file",
    "sparse-file",
    "hardlink-original",
    "hardlink-copy",
    "symlink-to-file",
    "broken-symlink",
    "symlink-loop",
    "empty-directory",
    "invalid-utf8-name",
    "newline-name",
    "control-character-name",
    "emoji-name",
    "long-name",
    "deep-leaf",
  ]) {
    assert.ok(byName.has(required), `missing fixture: ${required}`);
  }

  const sparse = await stat(byName.get("sparse-file").path);
  assert.equal(sparse.size, 1024 * 1024);
  assert.ok(sparse.blocks * 512 < sparse.size, "a sparse file allocates fewer bytes than it appears to hold");

  const original = await stat(byName.get("hardlink-original").path);
  const copy = await stat(byName.get("hardlink-copy").path);
  assert.equal(original.ino, copy.ino);
  assert.equal(original.nlink, 2);

  assert.equal((await lstat(byName.get("symlink-to-file").path)).isSymbolicLink(), true);
  await assert.rejects(stat(byName.get("broken-symlink").path), { code: "ENOENT" });
  assert.ok((await readlink(byName.get("symlink-loop").path)).length > 0);

  const odd = byName.get("invalid-utf8-name");
  assert.equal(Buffer.from(odd.path).includes(0xff), true, "the name keeps its raw bytes");
  assert.equal((await lstat(odd.path)).isFile(), true);

  assert.equal(Buffer.from(byName.get("long-name").path).length - fixture.root.length - 1, 255);
});

test("an unreadable directory is reported honestly rather than silently skipped", async (t) => {
  const fixture = await createStandardFixture();
  t.after(() => fixture.cleanup());

  const unreadable = fixture.manifest.find((entry) => entry.name === "unreadable-directory");
  assert.ok(unreadable);
  if (process.getuid?.() === 0) {
    assert.equal(unreadable.enforced, false, "root can read it anyway, and the fixture says so");
    return;
  }
  assert.equal(unreadable.enforced, true);
  const { readdir } = await import("node:fs/promises");
  await assert.rejects(readdir(unreadable.path), { code: "EACCES" });
});

test("the large tree scales to a chosen entry count without holding it in memory", async (t) => {
  const fixture = await createLargeFixture({ entries: 5000, fanOut: 50 });
  t.after(() => fixture.cleanup());
  assert.equal(fixture.entryCount, 5000);
  assert.equal((await stat(fixture.root)).isDirectory(), true);
});

test("cleanup refuses a root it did not create", async () => {
  const fixture = await createStandardFixture();
  await fixture.cleanup();
  await assert.rejects(fixture.cleanup(), /already removed|not a Disktop fixture/);
});

test("cleanup rejects a root that only looks like a sandbox", async (t) => {
  const fixture = await createStandardFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }).catch(() => undefined));

  for (const forged of [`${fixture.root}/../../etc`, `${fixture.root}/nested`, "/home/example"]) {
    const escaped = await createStandardFixture();
    const cleanup = escaped.cleanup;
    escaped.root = forged;
    await assert.rejects(cleanup(), /not a Disktop fixture/, forged);
    escaped.root = fixture.root;
  }
});

test("the tree is removable with rm -rf after cleanup restores the unreadable directory", async () => {
  const fixture = await createStandardFixture();
  await fixture.cleanup();
  const { access } = await import("node:fs/promises");
  await assert.rejects(access(fixture.root), { code: "ENOENT" });
});
