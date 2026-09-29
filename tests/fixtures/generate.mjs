/**
 * Builds throwaway trees that reproduce the filesystem shapes Disktop must
 * survive: sparse files, hardlinks, symlink loops, unreadable directories, and
 * names that are not valid UTF-8. Every fixture lives under a `mkdtemp`
 * directory in the system temporary directory, and `cleanup` refuses to remove
 * anything else, so no test can point this at real data.
 */
import { chmod, link, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PREFIX = "disktop-fixture-";
const SPARSE_BYTES = 1024 * 1024;

const removed = new WeakSet();

/**
 * A sandbox is a direct child of the system temporary directory whose name
 * starts with the fixture prefix. The path is resolved first, so a root
 * carrying `..` cannot borrow a valid prefix to reach real data.
 */
function assertSandbox(root) {
  const resolved = resolve(root);
  if (dirname(resolved) !== resolve(tmpdir()) || !basenameOf(resolved).startsWith(PREFIX)) {
    throw new Error(`${root} is not a Disktop fixture sandbox`);
  }
  return resolved;
}

function basenameOf(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

function sandboxCleanup(fixture) {
  return async () => {
    if (removed.has(fixture)) {
      throw new Error(`Fixture ${fixture.root} was already removed`);
    }
    const resolved = assertSandbox(fixture.root);
    removed.add(fixture);
    await rm(resolved, { recursive: true, force: true });
  };
}

async function sandbox() {
  return mkdtemp(join(tmpdir(), PREFIX));
}

/** A path whose final component is raw bytes, so invalid UTF-8 survives. */
function bytePath(root, nameBytes) {
  return Buffer.concat([Buffer.from(`${root}/`), Buffer.from(nameBytes)]);
}

export async function createStandardFixture() {
  const root = await sandbox();
  try {
    return await buildStandardFixture(root);
  } catch (error) {
    await restoreAndRemove(root);
    throw error;
  }
}

/** Make the tree removable again before deleting it: 0o000 defeats rm -rf. */
export async function restoreAndRemove(root) {
  await chmod(join(assertSandbox(root), "unreadable-directory"), 0o700).catch(() => undefined);
  await rm(assertSandbox(root), { recursive: true, force: true });
}

async function buildStandardFixture(root) {
  const manifest = [];
  const record = (name, path, extra = {}) => {
    manifest.push({ name, path, ...extra });
    return path;
  };

  const plain = join(root, "plain.txt");
  await writeFile(plain, "x".repeat(1024));
  record("plain-file", plain, { apparentBytes: 1024 });

  const sparse = join(root, "sparse.bin");
  const handle = await open(sparse, "w");
  await handle.truncate(SPARSE_BYTES);
  await handle.close();
  record("sparse-file", sparse, { apparentBytes: SPARSE_BYTES });

  const original = join(root, "hardlink-original.bin");
  await writeFile(original, "shared bytes");
  const copy = join(root, "hardlink-copy.bin");
  await link(original, copy);
  record("hardlink-original", original, { linkCount: 2 });
  record("hardlink-copy", copy, { linkCount: 2 });

  await symlink(plain, join(root, "symlink-to-file"));
  record("symlink-to-file", join(root, "symlink-to-file"));
  await symlink(join(root, "does-not-exist"), join(root, "broken-symlink"));
  record("broken-symlink", join(root, "broken-symlink"));
  await symlink(join(root, "symlink-loop"), join(root, "symlink-loop"));
  record("symlink-loop", join(root, "symlink-loop"));

  await mkdir(join(root, "empty-directory"));
  record("empty-directory", join(root, "empty-directory"));

  const oddNames = [
    ["invalid-utf8-name", Buffer.from([0x62, 0x61, 0x64, 0x2d, 0xff, 0xfe, 0x2e, 0x62, 0x69, 0x6e])],
    ["newline-name", Buffer.from("first\nsecond.txt")],
    ["control-character-name", Buffer.from("escape\u001b[2Kname.txt")],
    ["emoji-name", Buffer.from("report \u{1F4C4}.txt")],
    ["long-name", Buffer.from("l".repeat(255))],
  ];
  for (const [name, nameBytes] of oddNames) {
    const path = bytePath(root, nameBytes);
    await writeFile(path, name);
    record(name, path);
  }

  let deep = root;
  for (let depth = 0; depth < 12; depth += 1) {
    deep = join(deep, `level-${depth}`);
    await mkdir(deep);
  }
  const leaf = join(deep, "leaf.txt");
  await writeFile(leaf, "bottom");
  record("deep-leaf", leaf, { depth: 12 });

  const unreadable = join(root, "unreadable-directory");
  await mkdir(unreadable);
  await writeFile(join(unreadable, "hidden.txt"), "unreachable");
  await chmod(unreadable, 0o000);
  record("unreadable-directory", unreadable, { enforced: process.getuid?.() !== 0 });

  const changing = join(root, "changing.txt");
  await writeFile(changing, "before");
  record("changing-file", changing);

  const fixture = { root, manifest };
  const remove = sandboxCleanup(fixture);
  fixture.cleanup = async () => {
    await chmod(join(assertSandbox(fixture.root), "unreadable-directory"), 0o700).catch(() => undefined);
    await remove();
  };
  return fixture;
}

/** A wide, shallow tree for the memory and scan-time budget. */
export async function createLargeFixture({ entries, fanOut = 256 }) {
  if (!Number.isInteger(entries) || entries < 1) {
    throw new RangeError("entries must be a positive integer");
  }
  const root = await sandbox();
  let created = 0;
  for (let bucket = 0; created < entries; bucket += 1) {
    const directory = join(root, `bucket-${bucket}`);
    await mkdir(directory);
    const batch = Math.min(fanOut, entries - created);
    for (let index = 0; index < batch; index += 1) {
      await writeFile(join(directory, `file-${index}.bin`), "");
      created += 1;
    }
  }
  const fixture = { root, entryCount: created };
  fixture.cleanup = sandboxCleanup(fixture);
  return fixture;
}
