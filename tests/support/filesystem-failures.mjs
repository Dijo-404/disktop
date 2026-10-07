/** Runs only inside the parent's private mount namespace and temporary home. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const work = process.argv[2];
assert.ok(work?.startsWith("/"));
const rootOwner = (await stat("/")).uid;
if (rootOwner !== 0 && rootOwner !== process.getuid()) {
  process.stderr.write("this user namespace hides trusted root ownership required by the durable journal; use the isolated container fault gate\n");
  process.exit(77);
}
const root = fileURLToPath(new URL("../../", import.meta.url));
const sourceMount = join(work, "source-fs");
const destinationMount = join(work, "destination-fs");
const journalMount = join(work, "journal-fs");
await mkdir(sourceMount);
await mkdir(destinationMount);
await mkdir(journalMount);
const mounts = [];
function mount(path, size) {
  const result = spawnSync("mount", ["-t", "tmpfs", "-o", `size=${size},uid=${process.getuid()},gid=${process.getgid()}`, "tmpfs", path], { encoding: "utf8" });
  if (result.status !== 0 && /not permitted|permission denied|must be superuser/i.test(result.stderr)) {
    process.stderr.write("the namespace cannot mount its private tmpfs filesystems\n");
    process.exit(77);
  }
  assert.equal(result.status, 0, result.stderr);
  mounts.push(path);
}
function cli(home, args, stateHome = join(home, "state")) {
  const result = spawnSync(process.execPath, [join(root, "dist/bin/disktop.js"), ...args, "--json"], {
    encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: stateHome, XDG_CACHE_HOME: join(home, "cache"), NO_COLOR: "1" },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.stdout.trim(), "", result.stderr);
  return { status: result.status, data: JSON.parse(result.stdout), stderr: result.stderr };
}
try {
  mount(sourceMount, "16m");
  mount(destinationMount, "2m");
  const home = join(work, "home");
  const projects = join(home, "projects");
  const destination = join(destinationMount, "outputs");
  await mkdir(projects, { recursive: true });
  await mkdir(destination);
  const source = join(projects, "source.bin");
  const contents = randomBytes(1024 * 1024);
  await writeFile(source, contents);
  const plan = cli(home, ["clean", "plan", "--path", source, "--operation", "move", "--destination", destination, "--source", "trash"]);
  assert.equal(plan.status, 0, JSON.stringify(plan.data));
  await writeFile(join(destinationMount, "fill.bin"), randomBytes(1536 * 1024));
  const full = cli(home, ["clean", "apply", plan.data.data.plan.id, "--yes"]);
  assert.equal(full.status, 3, JSON.stringify(full.data));
  assert.equal(full.data.data.result.completed, "0");
  assert.match(JSON.stringify(full.data), /no-space|space|full/i);
  assert.deepEqual(await readFile(source), contents);
  assert.deepEqual(await readdir(destination), [], "a failed copy leaves no published or staged output");
  assert.equal(existsSync(join(home, "data", "Trash", "files", "source.bin")), false);

  const readOnlySource = join(sourceMount, "protected.bin");
  await writeFile(readOnlySource, contents);
  await mkdir(join(home, "config", "disktop"), { recursive: true });
  await writeFile(join(home, "config", "disktop", "config.toml"), `[cleanup]\nadditional_allowed_roots = [${JSON.stringify(sourceMount)}]\n`);
  const erase = cli(home, ["clean", "plan", "--path", readOnlySource, "--operation", "permanent"]);
  assert.equal(erase.status, 0, JSON.stringify(erase.data));
  const readOnly = spawnSync("mount", ["-o", "remount,ro", sourceMount], { encoding: "utf8" });
  assert.equal(readOnly.status, 0, readOnly.stderr);
  const refused = cli(home, ["clean", "apply", erase.data.data.plan.id, "--yes", "--permanent"]);
  assert.equal(refused.status, 3, JSON.stringify(refused.data));
  assert.equal(refused.data.data.result.completed, "0");
  assert.deepEqual(await readFile(readOnlySource), contents);

  // A full durable journal filesystem must prevent the first destructive syscall.
  mount(journalMount, "2m");
  const journalPlan = cli(home, ["clean", "plan", "--path", source, "--operation", "permanent"], journalMount);
  assert.equal(journalPlan.status, 0, JSON.stringify(journalPlan.data));
  const filler = await open(join(journalMount, "fill.bin"), "wx");
  try {
    const block = Buffer.alloc(4096, 0xa5);
    for (;;) {
      try {
        const { bytesWritten } = await filler.write(block);
        assert.ok(bytesWritten > 0);
      } catch (error) {
        assert.equal(error.code, "ENOSPC");
        break;
      }
    }
  } finally {
    await filler.close();
  }
  const noJournal = cli(home, ["clean", "apply", journalPlan.data.data.plan.id, "--yes", "--permanent"], journalMount);
  assert.ok([2, 3].includes(noJournal.status), JSON.stringify(noJournal.data));
  assert.match(JSON.stringify(noJournal.data), /journal|space|full|disk/i);
  assert.deepEqual(await readFile(source), contents, "nothing is removed when a journal intent cannot be written");

  // The existing consumer-facing move tests now run on two actual devices,
  // including refusal to overwrite an existing published destination.
  const unfilled = spawnSync("mount", ["-o", "remount,size=64m", destinationMount], { encoding: "utf8" });
  assert.equal(unfilled.status, 0, unfilled.stderr);
  const moves = spawnSync(process.execPath, ["--test", "--test-name-pattern=a move across filesystems|a move refuses to publish",
    "tests/integration/actions.test.mjs"], { cwd: root, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, DISKTOP_TEST_DESTINATION_FS: destination } });
  assert.equal(moves.error, undefined);
  assert.equal(moves.status, 0, moves.stdout + moves.stderr);
  assert.doesNotMatch(moves.stdout, /# SKIP|skipped 2|ℹ skipped [1-9]/);
  process.stdout.write(JSON.stringify({ diskFull: true, journalFull: true, readOnly: true, crossDevice: true }));
} finally {
  for (const path of mounts.reverse()) {
    const result = spawnSync("umount", [path], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
}
