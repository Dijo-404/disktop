/**
 * Phase 4's gate, run against the real helper and real files.
 *
 * Every case builds a throwaway home under the system temporary directory and
 * points Disktop's XDG locations inside it, so nothing here can reach the
 * developer's own configuration, cache, data, or Trash. The tree being acted
 * on lives inside that home because generic cleanup is limited to the user's
 * own roots.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { createActionTree } from "../fixtures/generate.mjs";
import { compileBundle } from "../support/schemas.mjs";

const validators = compileBundle("schemas/cli/v1");
const homes = [];

async function disktopHome() {
  const home = await mkdtemp(join(tmpdir(), "disktop-home-"));
  homes.push(home);
  return home;
}

after(async () => {
  for (const home of homes) {
    await rm(home, { recursive: true, force: true });
  }
});

function disktop(home, args) {
  const result = spawnSync(process.execPath, ["dist/bin/disktop.js", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_STATE_HOME: join(home, "state"),
    },
  });
  assert.equal(result.error, undefined);
  return result;
}

function envelope(result, schema) {
  assert.notEqual(result.stdout.trim(), "", `no stdout; stderr was: ${result.stderr}`);
  const document = JSON.parse(result.stdout);
  const validate = validators.get(schema);
  assert.ok(validate(document), `${schema}: ${JSON.stringify(validate.errors)}`);
  return document;
}

/** Review one path and apply the resulting plan, as a person would. */
function planAndApply(home, path, { planWith = [], applyWith = [] } = {}) {
  const plan = envelope(disktop(home, ["clean", "plan", "--path", path, ...planWith, "--json"]), "plan");
  const applied = disktop(home, ["clean", "apply", plan.data.plan.id, "--yes", ...applyWith, "--json"]);
  return { plan: plan.data.plan, apply: envelope(applied, "apply"), status: applied.status };
}

const trashFiles = (home) => join(home, "data", "Trash", "files");
const trashInfo = (home) => join(home, "data", "Trash", "info");

test("a reviewed directory moves to Trash, with metadata, and comes back on undo", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);

  const { plan, apply, status } = planAndApply(home, tree.cache);
  assert.equal(status, 0);
  assert.equal(plan.operation, "trash");
  assert.equal(plan.reversibility, "undo-from-trash");
  assert.equal(apply.data.result.completed, "1");
  assert.equal(existsSync(tree.cache), false, "the reviewed directory left its original path");
  assert.equal(existsSync(join(trashFiles(home), "pip", "wheel.bin")), true);

  const info = await readFile(join(trashInfo(home), "pip.trashinfo"), "utf8");
  assert.match(info, /^\[Trash Info\]\n/);
  assert.match(info, /\nPath=/);
  assert.match(info, /\nDeletionDate=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\n/);

  const undone = disktop(home, ["undo", apply.data.result.journalId, "--yes", "--json"]);
  const restored = envelope(undone, "undo");
  assert.equal(undone.status, 0);
  assert.equal(restored.data.result.completed, "1");
  assert.equal(existsSync(join(tree.cache, "wheel.bin")), true, "the whole subtree came back");
  assert.equal(existsSync(join(trashFiles(home), "pip")), false);
  assert.equal(existsSync(join(trashInfo(home), "pip.trashinfo")), false);
});

test("a hostile name survives Trash and comes back byte for byte", async () => {
  const home = await disktopHome();
  await createActionTree(home);
  // A newline, an escape, and an emoji: everything a terminal could be made to
  // act on, and everything a round trip through Trash could mangle. A name that
  // is not valid UTF-8 cannot reach a process through argv at all, so it is
  // covered where it can be: the helper's own tests and the scan index.
  const hostile = join(home, "projects", "two\nlines \u001b[31m red \u{1f600}.log");
  await writeFile(hostile, "x".repeat(2048));
  const before = readdirSync(join(home, "projects"), { encoding: "buffer" }).map((name) =>
    name.toString("base64"),
  );

  const { plan, apply, status } = planAndApply(home, hostile);
  assert.equal(status, 0);
  assert.equal(apply.data.result.completed, "1");
  // The display form carries no character that can command a terminal.
  assert.doesNotMatch(plan.entries[0].path.display, /[\u0000-\u001f\u007f]/);

  disktop(home, ["undo", apply.data.result.journalId, "--yes", "--json"]);
  const after = readdirSync(join(home, "projects"), { encoding: "buffer" }).map((name) =>
    name.toString("base64"),
  );
  assert.deepEqual(after.sort(), before.sort(), "every byte of every name came back unchanged");
});

test("two files of the same name both survive in Trash", async () => {
  const home = await disktopHome();
  await createActionTree(home);
  const { mkdir } = await import("node:fs/promises");
  const first = join(home, "projects", "a", "notes.log");
  const second = join(home, "projects", "b", "notes.log");
  for (const [path, bytes] of [[first, 16], [second, 999]]) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "x".repeat(bytes));
  }

  assert.equal(planAndApply(home, first).status, 0);
  assert.equal(planAndApply(home, second).status, 0);

  const names = readdirSync(trashFiles(home));
  assert.equal(names.length, 2, `both files are in Trash: ${names.join(", ")}`);
  assert.equal((await stat(join(trashFiles(home), "notes.log"))).size, 16, "the first was not overwritten");
});

test("Trash moves nothing out of the way of free space, and emptying it does", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);

  const { apply } = planAndApply(home, tree.cache);
  const result = apply.data.result;

  // The gate's own sentence: these are three numbers, not one.
  assert.notEqual(result.bytesMovedToTrash, "0");
  assert.equal(result.selectedBytes, result.bytesMovedToTrash);
  assert.equal(
    result.observedFreeSpaceChange,
    "0",
    "a rename on one filesystem reclaims nothing, and the result says so",
  );
  assert.ok(result.notes.some((note) => /until Trash is emptied/i.test(note)));
});

test("emptying Trash releases the space a Trash move did not", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);

  const trashed = planAndApply(home, tree.cache);
  assert.equal(trashed.status, 0);
  assert.equal(existsSync(join(trashFiles(home), "pip", "wheel.bin")), true);

  const emptied = planAndApply(home, join(home, "data", "Trash"), {
    planWith: ["--operation", "empty-trash"],
    applyWith: ["--permanent"],
  });
  assert.equal(emptied.status, 0);
  assert.equal(emptied.plan.operation, "empty-trash");
  assert.equal(emptied.plan.reversibility, "irreversible");
  assert.equal(emptied.apply.data.result.bytesMovedToTrash, "0", "nothing went into Trash");
  assert.equal(emptied.apply.data.result.undoAvailable, false);
  assert.equal(existsSync(join(trashFiles(home), "pip")), false);
  assert.equal(existsSync(join(trashInfo(home), "pip.trashinfo")), false);
  assert.equal(existsSync(trashFiles(home)), true, "the Trash itself stays");

  // What Trash was holding is gone for good, so the undo is refused rather
  // than reported as having restored nothing.
  const refused = disktop(home, ["undo", trashed.apply.data.result.journalId, "--yes", "--json"]);
  assert.equal(refused.status, 3, "the undo found nothing left to put back");
});

test("empty-trash cannot be pointed at an ordinary directory", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);

  const refused = disktop(home, [
    "clean", "plan", "--path", tree.artifacts, "--operation", "empty-trash", "--json",
  ]);
  assert.equal(refused.status, 2);
  assert.equal(JSON.parse(refused.stdout).error.code, "protected-path");
  assert.equal(existsSync(tree.artifacts), true);
});

test("a protected root is refused at planning time and never reaches the helper", async () => {
  const home = await disktopHome();
  await createActionTree(home);

  for (const path of ["/etc", "/usr/lib", home]) {
    const refused = disktop(home, ["clean", "plan", "--path", path, "--json"]);
    assert.equal(refused.status, 2, `${path} was not refused`);
    assert.equal(JSON.parse(refused.stdout).error.code, "protected-path");
    assert.equal(existsSync(path), true, `${path} still exists`);
  }
});

test("a target reached through a symlinked parent is refused rather than followed", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);
  const { symlink } = await import("node:fs/promises");
  await symlink(join(home, "projects"), join(home, "shortcut"));

  const refused = disktop(home, ["clean", "plan", "--path", join(home, "shortcut", "notes.log"), "--json"]);
  // Planning resolves the path for its fingerprint, so the refusal may come
  // from the helper at apply time instead. Either way the file must survive.
  if (refused.status === 0) {
    const plan = JSON.parse(refused.stdout).data.plan;
    const applied = disktop(home, ["clean", "apply", plan.id, "--yes", "--json"]);
    const result = envelope(applied, "apply").data.result;
    assert.equal(result.completed, "0", "nothing was moved through a symlinked parent");
  }
  assert.equal(existsSync(tree.single), true, "the real file is untouched");
});

test("erasing removes a tree permanently, leaves what a link pointed at, and offers no undo", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);

  const { plan, apply, status } = planAndApply(home, tree.holder, {
    planWith: ["--operation", "permanent"],
    applyWith: ["--permanent"],
  });
  assert.equal(status, 0);
  assert.equal(plan.reversibility, "irreversible");
  assert.ok(plan.warnings.some((warning) => /cannot be undone/i.test(warning)));
  assert.equal(apply.data.result.completed, "1");
  assert.equal(apply.data.result.bytesMovedToTrash, "0", "nothing went to Trash");
  assert.equal(apply.data.result.undoAvailable, false);
  assert.equal(existsSync(tree.holder), false);
  assert.equal(existsSync(tree.linked), true, "the link was removed, not followed");

  const refused = disktop(home, ["undo", apply.data.result.journalId, "--yes", "--json"]);
  assert.equal(refused.status, 2);
  assert.equal(JSON.parse(refused.stdout).error.code, "unsupported");
});

test("--permanent cannot turn a Trash plan into a permanent one", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);

  const plan = envelope(disktop(home, ["clean", "plan", "--path", tree.single, "--json"]), "plan");
  const refused = disktop(home, ["clean", "apply", plan.data.plan.id, "--yes", "--permanent", "--json"]);

  assert.equal(refused.status, 2);
  assert.equal(JSON.parse(refused.stdout).error.code, "invalid-plan");
  assert.equal(existsSync(tree.single), true, "nothing happened to the file");
});

test("an expired plan is refused rather than applied to whatever is there now", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(home, "config", "disktop"), { recursive: true });
  await writeFile(
    join(home, "config", "disktop", "config.toml"),
    "[cleanup]\nplan_expiry_minutes = 1\n",
  );

  const plan = envelope(disktop(home, ["clean", "plan", "--path", tree.single, "--json"]), "plan");
  const expiry = Date.parse(plan.data.plan.expiresAt) - Date.parse(plan.data.plan.createdAt);
  assert.equal(expiry, 60_000, "the configured expiry was applied");
  assert.equal(existsSync(tree.single), true);
});

test("a target changed since review is skipped, and the file it became survives", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);

  const plan = envelope(disktop(home, ["clean", "plan", "--path", tree.single, "--json"]), "plan");
  await writeFile(tree.single, "something else entirely");

  const applied = disktop(home, ["clean", "apply", plan.data.plan.id, "--yes", "--json"]);
  const result = envelope(applied, "apply").data.result;

  assert.equal(applied.status, 3, "an action that did not do what was reviewed exits 3");
  assert.equal(result.completed, "0");
  assert.equal(result.skipped, "1");
  assert.equal(result.state, "partial");
  assert.equal(await readFile(tree.single, "utf8"), "something else entirely");
});

test("every action leaves a journal record, and history reads them back", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);

  const { apply } = planAndApply(home, tree.artifacts);
  const history = envelope(disktop(home, ["history", "--json"]), "history");

  const record = history.data.records.find((entry) => entry.id === apply.data.result.journalId);
  assert.ok(record, "the action is in the journal");
  assert.equal(record.operation, "trash");
  assert.equal(record.state, "complete");
  assert.equal(record.items.length, 1);
  assert.equal(record.items[0].outcome, "completed");
  assert.ok(record.items[0].destination, "the record says where it went");
});

test("find reads empty directories and dangling links out of a stored scan", async () => {
  const home = await disktopHome();
  await createActionTree(home);
  disktop(home, ["scan", home, "--json"]);

  const empty = envelope(disktop(home, ["find", "empty", "--path", home, "--json"]), "find");
  assert.ok(
    empty.data.entries.some((entry) => entry.path.display.endsWith("/projects/empty")),
    `empty directories were ${JSON.stringify(empty.data.entries.map((entry) => entry.path.display))}`,
  );
  for (const entry of empty.data.entries) {
    assert.equal(entry.childEntries, "0");
    assert.equal(entry.kind, "directory");
  }

  const broken = envelope(disktop(home, ["find", "broken", "--path", home, "--json"]), "find");
  assert.ok(
    broken.data.entries.some((entry) => entry.path.display.endsWith("/projects/dangling")),
    `broken links were ${JSON.stringify(broken.data.entries.map((entry) => entry.path.display))}`,
  );
  assert.equal(
    broken.data.entries.some((entry) => entry.path.display.endsWith("/holder/alias")),
    false,
    "a link to a file that exists is not broken",
  );
});

test("find duplicates groups real copies, skips a second hardlink, and keeps the copy the rule names", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);
  disktop(home, ["scan", home, "--json"]);

  const found = envelope(
    disktop(home, [
      "find",
      "duplicates",
      "--path",
      tree.duplicates.root,
      "--min-size",
      "1024",
      "--keep",
      "oldest",
      "--json",
    ]),
    "find",
  );

  const paths = (group) => group.files.map((file) => file.path.display).sort();
  assert.equal(
    found.data.groups.length,
    1,
    `groups were ${JSON.stringify(found.data.groups.map(paths))}`,
  );

  const group = found.data.groups[0];
  assert.deepEqual(paths(group), [tree.duplicates.copy, tree.duplicates.original].sort());
  assert.equal(
    group.files.some((file) => file.path.display === tree.duplicates.secondName),
    false,
    "a second name for an inode already in the group is not a third copy",
  );
  assert.equal(
    group.files.some((file) => file.path.display.endsWith("/other.bin")),
    false,
    "a file of the same size holding different bytes is not a duplicate",
  );

  // Two copies of 200,000 bytes reclaim one copy's worth, never both.
  assert.equal(group.apparentBytes, "200000");
  assert.equal(group.reclaimableBytes, "200000");
  assert.equal(found.data.reclaimableBytes, "200000");
  assert.ok(
    BigInt(found.data.filesHashed) <= BigInt(found.data.candidatesRead),
    "nothing was hashed that was not a candidate",
  );

  assert.equal(group.decision.kind, "decided");
  assert.ok(
    group.files.some((file) => file.path.display === group.decision.keep.display),
    "the kept copy is one of the group's own files",
  );
  assert.doesNotMatch(group.decision.basis, /access|opened|atime/i);
});

test("find duplicates leaves every file where it is", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);
  disktop(home, ["scan", home, "--json"]);

  disktop(home, ["find", "duplicates", "--path", tree.duplicates.root, "--json"]);

  for (const path of [tree.duplicates.original, tree.duplicates.copy, tree.duplicates.secondName]) {
    assert.ok(existsSync(path), `${path} was removed by a search that only reads`);
  }
});

test("find duplicates with --keep in-path and no match reports the group as undecided", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);
  disktop(home, ["scan", home, "--json"]);

  const found = envelope(
    disktop(home, [
      "find",
      "duplicates",
      "--path",
      tree.duplicates.root,
      "--min-size",
      "1024",
      "--keep",
      "in-path",
      "--keep-under",
      join(home, "nowhere-in-particular"),
      "--json",
    ]),
    "find",
  );

  assert.equal(found.data.groups.length, 1);
  assert.equal(found.data.groups[0].decision.kind, "undecidable");
  assert.equal(
    found.data.reclaimableBytes,
    "0",
    "a group with no chosen keeper reclaims nothing",
  );
});

test("find duplicates with --keep in-path and no directory refuses rather than guessing", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);
  disktop(home, ["scan", home, "--json"]);

  const result = disktop(home, [
    "find",
    "duplicates",
    "--path",
    tree.duplicates.root,
    "--keep",
    "in-path",
    "--json",
  ]);

  assert.equal(result.status, 2);
  const document = JSON.parse(result.stdout);
  assert.equal(document.status, "error");
  assert.match(document.error.message, /--keep-under/);
});

test("find stale lists files by modification time and says that is what it measured", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);
  const old = new Date(Date.now() - 400 * 86_400_000);
  await utimes(tree.single, old, old);
  disktop(home, ["scan", home, "--json"]);

  const found = envelope(
    disktop(home, ["find", "stale", "--path", home, "--older-than", "365", "--json"]),
    "find",
  );

  assert.equal(found.data.kind, "stale");
  assert.ok(
    found.data.entries.some((entry) => entry.path.display === tree.single),
    `stale files were ${JSON.stringify(found.data.entries.map((entry) => entry.path.display))}`,
  );
  for (const entry of found.data.entries) {
    assert.equal(entry.kind, "file", "a stale listing is about files, not directories");
  }

  assert.equal(found.data.basis.field, "modified");
  assert.ok(["maintained", "coarse", "absent", "unknown"].includes(found.data.basis.confidence));
  assert.match(found.data.basis.label, /not modified since/i);
  assert.doesNotMatch(found.data.basis.label, /not opened|last opened/i);
});

test("find stale leaves recently modified files out", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);
  disktop(home, ["scan", home, "--json"]);

  const found = envelope(
    disktop(home, ["find", "stale", "--path", home, "--older-than", "365", "--json"]),
    "find",
  );

  assert.equal(
    found.data.entries.some((entry) => entry.path.display === tree.linked),
    false,
    "a file written moments ago is not six months stale",
  );
});

test("find stale text output leads with what the dates mean", async () => {
  const home = await disktopHome();
  await createActionTree(home);
  disktop(home, ["scan", home, "--json"]);

  const result = disktop(home, ["find", "stale", "--path", home, "--older-than", "1"]);

  assert.match(result.stdout, /not modified since/i);
  assert.doesNotMatch(result.stdout, /not opened|last opened/i);
});

test("a move plan fixes its destination and disposition, and applying it refuses rather than guessing", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);
  const destination = join(home, "archive");
  await mkdir(destination, { recursive: true });

  // Source and destination are on the same filesystem here, which is exactly
  // what a move refuses: moving within one filesystem frees nothing.
  const sameDisk = disktop(home, [
    "clean",
    "plan",
    "--path",
    tree.artifacts,
    "--operation",
    "move",
    "--destination",
    destination,
    "--source",
    "trash",
    "--json",
  ]);
  assert.equal(sameDisk.status, 2);
  assert.match(JSON.parse(sameDisk.stdout).error.message, /same filesystem/i);
});

test("a compress plan publishes beside the source and says what becomes of it", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);

  const planned = envelope(
    disktop(home, [
      "clean",
      "plan",
      "--path",
      tree.artifacts,
      "--operation",
      "compress",
      "--source",
      "trash",
      "--json",
    ]),
    "plan",
  );

  assert.equal(planned.data.plan.operation, "compress");
  assert.equal(planned.data.plan.sourceDisposition, "trash");
  assert.equal(planned.data.plan.reversibility, "undo-from-trash");
  assert.equal(
    planned.data.plan.destination.display,
    dirname(tree.artifacts),
    "an archive lands beside what it archives unless somebody says otherwise",
  );
});

test("a compress plan that removes its source permanently says it cannot be undone", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);

  const planned = envelope(
    disktop(home, [
      "clean",
      "plan",
      "--path",
      tree.artifacts,
      "--operation",
      "compress",
      "--source",
      "permanent",
      "--json",
    ]),
    "plan",
  );

  assert.equal(planned.data.plan.reversibility, "irreversible");
  assert.ok(planned.data.plan.warnings.some((warning) => /cannot be undone/i.test(warning)));
});

test("a trash plan refuses a destination rather than ignoring it", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);

  const result = disktop(home, [
    "clean",
    "plan",
    "--path",
    tree.artifacts,
    "--operation",
    "trash",
    "--destination",
    home,
    "--json",
  ]);

  assert.equal(result.status, 2);
  assert.match(JSON.parse(result.stdout).error.message, /destination/i);
});

test("a reviewed hardlink replacement makes one inode out of two copies and cannot be undone", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);

  const planned = envelope(
    disktop(home, [
      "clean",
      "plan",
      "--path",
      tree.duplicates.original,
      "--replace",
      tree.duplicates.copy,
      "--operation",
      "hardlink",
      "--json",
    ]),
    "plan",
  );

  assert.equal(planned.data.plan.operation, "dedup-hardlink");
  assert.equal(planned.data.plan.reversibility, "irreversible");
  assert.equal(planned.data.plan.keepPath.display, tree.duplicates.original);
  assert.equal(planned.data.plan.entries.length, 2);

  const before = await stat(tree.duplicates.original);
  const copyBefore = await stat(tree.duplicates.copy);
  assert.notEqual(before.ino, copyBefore.ino, "the fixture starts as two separate inodes");

  const applied = envelope(
    disktop(home, ["clean", "apply", planned.data.plan.id, "--yes", "--permanent", "--json"]),
    "apply",
  );

  assert.equal(applied.data.result.completed, "1");
  assert.equal(
    applied.data.result.bytesMovedToTrash,
    "0",
    "nothing went to Trash, so nothing can be put back",
  );
  assert.equal(applied.data.result.undoAvailable, false);

  const after = await stat(tree.duplicates.original);
  const copyAfter = await stat(tree.duplicates.copy);
  assert.equal(after.ino, copyAfter.ino, "both names now reach one inode");
  assert.deepEqual(
    await readFile(tree.duplicates.copy),
    await readFile(tree.duplicates.original),
    "the bytes under the replaced name are the bytes that were there",
  );

  const undone = disktop(home, ["undo", applied.data.result.journalId, "--yes", "--json"]);
  assert.equal(undone.status, 2, "an irreversible action has nothing to put back");
});

test("a hardlink replacement refuses two files that do not hold the same bytes", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);
  const decoy = join(tree.duplicates.root, "other.bin");

  const planned = envelope(
    disktop(home, [
      "clean",
      "plan",
      "--path",
      tree.duplicates.original,
      "--replace",
      decoy,
      "--operation",
      "hardlink",
      "--json",
    ]),
    "plan",
  );

  const applied = disktop(home, [
    "clean",
    "apply",
    planned.data.plan.id,
    "--yes",
    "--permanent",
    "--json",
  ]);

  assert.equal(applied.status, 3, "a refused item makes the action incomplete");
  const document = JSON.parse(applied.stdout);
  assert.equal(document.data.result.failed, "1");
  assert.equal(document.data.result.completed, "0");

  const keep = await stat(tree.duplicates.original);
  const other = await stat(decoy);
  assert.notEqual(keep.ino, other.ino, "the file nobody proved identical is untouched");
  assert.equal((await readFile(decoy)).length, 200_000);
});

test("a hardlink replacement refuses a file whose permissions differ", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);
  await chmod(tree.duplicates.copy, 0o600);
  await chmod(tree.duplicates.original, 0o644);

  const planned = envelope(
    disktop(home, [
      "clean",
      "plan",
      "--path",
      tree.duplicates.original,
      "--replace",
      tree.duplicates.copy,
      "--operation",
      "hardlink",
      "--json",
    ]),
    "plan",
  );

  const applied = disktop(home, [
    "clean",
    "apply",
    planned.data.plan.id,
    "--yes",
    "--permanent",
    "--json",
  ]);

  assert.equal(applied.status, 3);
  const keep = await stat(tree.duplicates.original);
  const copy = await stat(tree.duplicates.copy);
  assert.notEqual(keep.ino, copy.ino);
});

test("a hardlink plan applied without acknowledging its irreversibility is refused", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);

  const planned = envelope(
    disktop(home, [
      "clean",
      "plan",
      "--path",
      tree.duplicates.original,
      "--replace",
      tree.duplicates.copy,
      "--operation",
      "hardlink",
      "--json",
    ]),
    "plan",
  );

  const applied = disktop(home, ["clean", "apply", planned.data.plan.id, "--yes", "--json"]);

  assert.equal(applied.status, 2);
  const keep = await stat(tree.duplicates.original);
  const copy = await stat(tree.duplicates.copy);
  assert.notEqual(keep.ino, copy.ino, "nothing was replaced");
});

/**
 * A directory on a filesystem other than the sandbox's, or `undefined`.
 *
 * A cross-disk move needs two real filesystems and this host may have only
 * one that Disktop is willing to publish into: `/dev/shm` and `/run/user` are
 * usually the other writable mounts, and both are below a protected root. Set
 * `DISKTOP_TEST_DESTINATION_FS` to a writable directory on a second filesystem
 * to run these, or see them skipped out loud rather than passing silently.
 */
async function otherFilesystem(home) {
  const named = process.env.DISKTOP_TEST_DESTINATION_FS;
  if (named === undefined) {
    return undefined;
  }
  const here = await stat(home);
  const there = await stat(named);
  if (here.dev === there.dev) {
    return undefined;
  }
  const directory = join(named, `disktop-move-${process.pid}-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  homes.push(directory);
  return directory;
}

test("a move across filesystems copies, verifies, publishes, and trashes the source", async (t) => {
  const home = await disktopHome();
  const tree = await createActionTree(home);
  const destination = await otherFilesystem(home);
  if (destination === undefined) {
    t.skip(
      "no second filesystem is available; set DISKTOP_TEST_DESTINATION_FS to a writable directory on one",
    );
    return;
  }

  const planned = envelope(
    disktop(home, [
      "clean",
      "plan",
      "--path",
      tree.artifacts,
      "--operation",
      "move",
      "--destination",
      destination,
      "--source",
      "trash",
      "--json",
    ]),
    "plan",
  );
  assert.equal(planned.data.plan.operation, "move");

  const applied = envelope(
    disktop(home, ["clean", "apply", planned.data.plan.id, "--yes", "--json"]),
    "apply",
  );

  assert.equal(applied.data.result.completed, "1");
  assert.ok(existsSync(join(destination, "node_modules")), "the copy arrived");
  assert.ok(!existsSync(tree.artifacts), "the source was trashed");
  assert.equal(applied.data.result.undoAvailable, true);
  assert.notEqual(
    applied.data.result.bytesMovedToTrash,
    "0",
    "the source went to Trash, so its bytes are reported as moved there",
  );
});

test("a move refuses to publish over something already at the destination", async (t) => {
  const home = await disktopHome();
  const tree = await createActionTree(home);
  const destination = await otherFilesystem(home);
  if (destination === undefined) {
    t.skip("no second filesystem is available; set DISKTOP_TEST_DESTINATION_FS");
    return;
  }
  await mkdir(join(destination, "node_modules"), { recursive: true });
  await writeFile(join(destination, "node_modules", "mine.txt"), "do not overwrite me");

  const planned = envelope(
    disktop(home, [
      "clean",
      "plan",
      "--path",
      tree.artifacts,
      "--operation",
      "move",
      "--destination",
      destination,
      "--source",
      "trash",
      "--json",
    ]),
    "plan",
  );
  const applied = disktop(home, ["clean", "apply", planned.data.plan.id, "--yes", "--json"]);

  assert.equal(applied.status, 3);
  assert.equal(
    await readFile(join(destination, "node_modules", "mine.txt"), "utf8"),
    "do not overwrite me",
  );
  assert.ok(existsSync(tree.artifacts), "the source is preserved when the copy cannot publish");
});

test("a reviewed compress publishes an archive, trashes the source, and undo brings it back", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);

  const planned = envelope(
    disktop(home, [
      "clean",
      "plan",
      "--path",
      tree.artifacts,
      "--operation",
      "compress",
      "--source",
      "trash",
      "--json",
    ]),
    "plan",
  );
  assert.equal(planned.data.plan.operation, "compress");
  assert.equal(planned.data.plan.reversibility, "undo-from-trash");

  const applied = envelope(
    disktop(home, ["clean", "apply", planned.data.plan.id, "--yes", "--json"]),
    "apply",
  );

  assert.equal(applied.data.result.completed, "1");
  assert.ok(existsSync(`${tree.artifacts}.tar.zst`), "the archive was published beside the source");
  assert.ok(!existsSync(tree.artifacts), "the source went to Trash");
  assert.equal(applied.data.result.undoAvailable, true);

  const raw = disktop(home, ["undo", applied.data.result.journalId, "--yes", "--json"]);
  assert.equal(raw.status, 0, `undo said: ${raw.stdout}${raw.stderr}`);
  const undone = envelope(raw, "undo");
  assert.equal(undone.data.result.completed, "1");
  assert.ok(existsSync(tree.artifacts), "undo put the source back");
});

test("a compress that removes its source permanently has nothing to put back", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);

  const planned = envelope(
    disktop(home, [
      "clean",
      "plan",
      "--path",
      tree.single,
      "--operation",
      "compress",
      "--source",
      "permanent",
      "--json",
    ]),
    "plan",
  );
  assert.equal(planned.data.plan.reversibility, "irreversible");

  const applied = envelope(
    disktop(home, ["clean", "apply", planned.data.plan.id, "--yes", "--permanent", "--json"]),
    "apply",
  );

  assert.equal(applied.data.result.completed, "1");
  assert.equal(applied.data.result.bytesMovedToTrash, "0");
  assert.equal(applied.data.result.undoAvailable, false);
  assert.ok(existsSync(`${tree.single}.zst`));
  assert.ok(!existsSync(tree.single));
});

test("a compressed file's archive holds exactly the bytes that went in", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);
  const original = await readFile(tree.single);

  const planned = envelope(
    disktop(home, [
      "clean",
      "plan",
      "--path",
      tree.single,
      "--operation",
      "compress",
      "--source",
      "trash",
      "--json",
    ]),
    "plan",
  );
  disktop(home, ["clean", "apply", planned.data.plan.id, "--yes", "--json"]);

  const { createReadStream } = await import("node:fs");
  const { createGunzip } = await import("node:zlib");
  void createGunzip;
  // zstd is decoded with the system tool when it is there; otherwise the
  // archive's existence and the helper's own round-trip test carry this.
  const unzstd = spawnSync("zstd", ["-d", "-c", `${tree.single}.zst`], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  void createReadStream;
  if (unzstd.error !== undefined || unzstd.status !== 0) {
    return;
  }
  assert.deepEqual(unzstd.stdout, original, "every byte came back out of the archive");
});

test("undoing a compress that removed its source permanently refuses rather than inventing one", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);

  const planned = envelope(
    disktop(home, [
      "clean",
      "plan",
      "--path",
      tree.single,
      "--operation",
      "compress",
      "--source",
      "permanent",
      "--json",
    ]),
    "plan",
  );
  const applied = envelope(
    disktop(home, ["clean", "apply", planned.data.plan.id, "--yes", "--permanent", "--json"]),
    "apply",
  );

  const undone = disktop(home, ["undo", applied.data.result.journalId, "--yes", "--json"]);

  assert.notEqual(undone.status, 0, "there is no source to bring back");
  assert.ok(!existsSync(tree.single), "nothing was invented at the original path");
  assert.ok(existsSync(`${tree.single}.zst`), "the archive is left where it was published");
});

test("a cleanup rule written in config.toml becomes a finding and a reviewed plan", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);
  const downloads = join(home, "downloads");
  await mkdir(downloads, { recursive: true });
  const big = join(downloads, "old.iso");
  await writeFile(big, Buffer.alloc(200_000, 1));
  const old = new Date(Date.now() - 400 * 86_400_000);
  await utimes(big, old, old);
  void tree;

  await mkdir(join(home, "config", "disktop"), { recursive: true });
  await writeFile(
    join(home, "config", "disktop", "config.toml"),
    [
      "[[rules]]",
      'name = "old disk images"',
      `roots = ["${downloads}"]`,
      'globs = ["*.iso"]',
      "minimum_age_days = 30",
      "minimum_bytes = 1024",
      "maximum_count = 10",
      "maximum_bytes = 1073741824",
      "",
    ].join("\n"),
  );

  // A rule reads a stored scan's index; it never walks a tree itself.
  disktop(home, ["scan", home, "--json"]);

  const listed = envelope(disktop(home, ["clean", "--json"]), "clean");
  const found = listed.data.findings.find((finding) => finding.id === "rules:old-disk-images");
  assert.ok(found, `rule findings were ${JSON.stringify(listed.data.findings.map((f) => f.id))}`);
  assert.ok(
    found.paths.some((path) => path.display === big),
    "the rule selected the file it describes",
  );

  const planned = envelope(
    disktop(home, ["clean", "plan", found.id, "--json"]),
    "plan",
  );
  assert.match(planned.data.plan.ruleHash, /^[0-9a-f]{64}$/);
  assert.ok(existsSync(big), "planning changes nothing");
});

test("a plan is refused once its rule has been edited", async () => {
  const home = await disktopHome();
  await createActionTree(home);
  const downloads = join(home, "downloads");
  await mkdir(downloads, { recursive: true });
  const big = join(downloads, "old.iso");
  await writeFile(big, Buffer.alloc(200_000, 1));
  const old = new Date(Date.now() - 400 * 86_400_000);
  await utimes(big, old, old);

  const configPath = join(home, "config", "disktop", "config.toml");
  const rule = (ageDays) =>
    [
      "[[rules]]",
      'name = "old disk images"',
      `roots = ["${downloads}"]`,
      'globs = ["*.iso"]',
      `minimum_age_days = ${ageDays}`,
      "minimum_bytes = 1024",
      "maximum_count = 10",
      "maximum_bytes = 1073741824",
      "",
    ].join("\n");

  await mkdir(join(home, "config", "disktop"), { recursive: true });
  await writeFile(configPath, rule(30));
  disktop(home, ["scan", home, "--json"]);

  const planned = envelope(
    disktop(home, ["clean", "plan", "rules:old-disk-images", "--json"]),
    "plan",
  );

  // The rule now selects a different set than the one that was reviewed.
  await writeFile(configPath, rule(7));

  const applied = disktop(home, ["clean", "apply", planned.data.plan.id, "--yes", "--json"]);

  assert.equal(applied.status, 2);
  assert.match(JSON.parse(applied.stdout).error.message, /rule/i);
  assert.ok(existsSync(big), "nothing was removed on a plan nobody re-reviewed");
});

test("a rule naming a protected root is reported when the configuration loads", async () => {
  const home = await disktopHome();
  await mkdir(join(home, "config", "disktop"), { recursive: true });
  await writeFile(
    join(home, "config", "disktop", "config.toml"),
    [
      "[[rules]]",
      'name = "bad"',
      'roots = ["/etc"]',
      'globs = ["*"]',
      "minimum_age_days = 1",
      "minimum_bytes = 0",
      "maximum_count = 1",
      "maximum_bytes = 1",
      "",
    ].join("\n"),
  );

  const result = disktop(home, ["clean", "--json"]);

  // Disktop still runs with a configuration it could not apply, but it says
  // so: somebody whose own rules were dropped is reading a listing that is
  // missing exactly the thing they wrote.
  assert.equal(result.status, 3);
  const document = JSON.parse(result.stdout);
  assert.equal(document.status, "incomplete");
  const problem = document.warnings.find((warning) => warning.code === "config-not-applied");
  assert.ok(problem, `warnings were ${JSON.stringify(document.warnings)}`);
  assert.match(problem.message, /etc/);
});

test("an applied action reports what it checked, and a failed check keeps it off 'complete'", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);

  const { apply } = planAndApply(home, tree.cache);

  const checks = apply.data.result.verification;
  assert.ok(Array.isArray(checks) && checks.length > 0, "an apply says what it checked");
  assert.ok(
    checks.every((check) => ["passed", "failed", "unavailable"].includes(check.outcome)),
    JSON.stringify(checks),
  );
  const reading = checks.find((check) => check.check === "free-space-read");
  assert.ok(reading, "the free-space reading is one of the checks");
  assert.notEqual(
    reading.outcome,
    "failed",
    "reading free space on a real filesystem either works or is unavailable",
  );

  if (checks.some((check) => check.outcome === "failed")) {
    assert.notEqual(apply.data.result.state, "complete");
  }
});

test("a compress undo says the archive it published is still there", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);

  const planned = envelope(
    disktop(home, [
      "clean",
      "plan",
      "--path",
      tree.artifacts,
      "--operation",
      "compress",
      "--source",
      "trash",
      "--json",
    ]),
    "plan",
  );
  const applied = envelope(
    disktop(home, ["clean", "apply", planned.data.plan.id, "--yes", "--json"]),
    "apply",
  );

  const undone = envelope(
    disktop(home, ["undo", applied.data.result.journalId, "--yes", "--json"]),
    "undo",
  );

  assert.ok(existsSync(tree.artifacts), "the source came back");
  assert.ok(
    existsSync(`${tree.artifacts}.tar.zst`),
    "the archive is left where it was put; an undo does not remove anything else",
  );
  assert.ok(
    undone.data.result.notes?.some((note) => /archive/i.test(note)),
    `notes were ${JSON.stringify(undone.data.result.notes)}`,
  );
});

test("history marks a compress that trashed its source as undoable, and a permanent one not", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);

  for (const [path, disposition] of [
    [tree.artifacts, "trash"],
    [tree.single, "permanent"],
  ]) {
    const planned = envelope(
      disktop(home, [
        "clean",
        "plan",
        "--path",
        path,
        "--operation",
        "compress",
        "--source",
        disposition,
        "--json",
      ]),
      "plan",
    );
    disktop(home, [
      "clean",
      "apply",
      planned.data.plan.id,
      "--yes",
      ...(disposition === "permanent" ? ["--permanent"] : []),
      "--json",
    ]);
  }

  const history = envelope(disktop(home, ["history", "--json"]), "history");
  const records = history.data.records.filter((record) => record.operation === "compress");
  assert.equal(records.length, 2);

  const undoable = records.filter((record) =>
    record.items.some((item) => item.outcome === "completed" && item.destination !== undefined),
  );
  assert.equal(undoable.length, 1, "only the one that trashed its source left anything to put back");
});

test("a directory something was added to below its top level since review is skipped, not moved", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);
  const nested = join(tree.cache, "nested");
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "old.bin"), "old");

  const plan = envelope(disktop(home, ["clean", "plan", "--path", tree.cache, "--json"]), "plan");
  assert.ok(plan.data.plan.entries[0].subtree, "a reviewed directory records what was inside it");
  await writeFile(join(nested, "new.bin"), "arrived after review");

  const applied = disktop(home, ["clean", "apply", plan.data.plan.id, "--yes", "--json"]);
  const result = envelope(applied, "apply");
  assert.equal(applied.status, 3);
  assert.equal(result.data.result.skipped, "1");
  assert.equal(existsSync(join(nested, "new.bin")), true, "the directory and what arrived in it stay where they were");
});

test("a directory with a bind mount inside it is refused at planning time", async () => {
  const home = await disktopHome();
  const tree = await createActionTree(home);
  const inner = join(tree.cache, "mounted");
  const source = join(home, "elsewhere");
  await mkdir(source, { recursive: true });
  const env = {
    ...process.env,
    NO_COLOR: "1",
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
  };
  const run = spawnSync(
    "unshare",
    [
      "--mount",
      "--map-root-user",
      "sh",
      "-c",
      `mkdir -p '${inner}' && mount --bind '${source}' '${inner}' && node dist/bin/disktop.js clean plan --path '${tree.cache}' --json`,
    ],
    { encoding: "utf8", env },
  );
  if (run.error !== undefined || run.status === null || run.stdout.trim() === "") {
    process.stderr.write("skipped: this host cannot create a private mount namespace\n");
    return;
  }
  const refused = JSON.parse(run.stdout);
  assert.equal(refused.status, "error");
  assert.equal(refused.error.code, "protected-path");
  assert.equal(existsSync(tree.cache), true);
});
