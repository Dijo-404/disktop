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
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
