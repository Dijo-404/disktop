/**
 * What the journal says after the helper stops in the middle.
 *
 * The gate asks for honest partial results and no unjournaled success. Both
 * are checked here by killing the real helper while it is working through a
 * list of targets and then reading the journal back through the same
 * `journal-reconcile` operation Disktop itself uses.
 *
 * Every tree lives under the system temporary directory and holds nothing but
 * fixture bytes.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { compileBundle } from "../support/schemas.mjs";

const validators = compileBundle("schemas/native/v1");
const binary = resolve("native/disktop-fs/target/debug/disktop-fs");
const sandboxes = [];

after(async () => {
  for (const root of sandboxes) {
    await rm(root, { recursive: true, force: true });
  }
});

async function sandbox(targets) {
  const root = await mkdtemp(join(tmpdir(), "disktop-recovery-"));
  sandboxes.push(root);
  const paths = [];
  for (let index = 0; index < targets; index += 1) {
    const path = join(root, "work", `item-${String(index).padStart(3, "0")}.bin`);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "x".repeat(4096));
    paths.push(path);
  }
  return { root, paths };
}

const encode = (text) => Buffer.from(text, "utf8").toString("base64");

/** The fingerprint a reviewed plan would have recorded for a live path. */
async function fingerprint(path) {
  const { lstat } = await import("node:fs/promises");
  const reading = await lstat(path, { bigint: true });
  return {
    device: String(reading.dev),
    inode: String(reading.ino),
    mountId: String(reading.dev),
    kind: "file",
    apparentBytes: String(reading.size),
    modifiedNanoseconds: String(reading.mtimeNs),
  };
}

/**
 * Run one request against the helper and kill the process the moment
 * `stop(events)` says to. Returns every event it managed to write.
 */
function runUntil(request, stop) {
  return new Promise((done, fail) => {
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    const events = [];
    let buffer = "";
    let killed = false;

    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== "") {
          const event = JSON.parse(line);
          events.push(event);
          if (!killed && stop(events)) {
            killed = true;
            child.kill("SIGKILL");
          } else if (event.event === "complete" || event.event === "error") {
            // The helper keeps reading stdin until the client goes away, so
            // the stream is closed once the request it was given has settled.
            // Closing it earlier would cancel the very work under test.
            child.stdin.end();
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.on("error", fail);
    child.on("close", () => done({ events, killed }));
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

function request(operation, requestId, operationArguments) {
  return { protocolVersion: 1, requestId, operation, arguments: operationArguments };
}

/** Reconcile, then read the whole journal back. */
async function journal(root) {
  const { events } = await runUntil(
    request("journal-reconcile", "journal-1", {
      journalDirectory: encode(join(root, "state")),
      limit: "200",
    }),
    () => false,
  );
  const complete = events.find((event) => event.event === "complete");
  assert.ok(complete, `the journal did not answer: ${JSON.stringify(events)}`);
  const validate = validators.get("journal-result");
  assert.ok(validate(complete), `journal-result: ${JSON.stringify(validate.errors)}`);
  return complete.result;
}

async function trashRequest(root, paths) {
  const targets = [];
  for (const path of paths) {
    targets.push({ path: encode(path), expected: await fingerprint(path), reviewedBytes: "4096" });
  }
  return request("trash", "trash-recovery", {
    planId: "plan-recovery-000001",
    journalDirectory: encode(join(root, "state")),
    homeTrashDirectory: encode(join(root, "trash")),
    targets,
  });
}

test("a helper killed mid-action leaves a record that never claims to be complete", async () => {
  const { root, paths } = await sandbox(40);
  const { events, killed } = await runUntil(
    await trashRequest(root, paths),
    (seen) => seen.filter((event) => event.event === "item-result").length >= 3,
  );
  assert.equal(killed, true, "the helper was stopped while it still had work left");
  assert.equal(
    events.some((event) => event.event === "complete"),
    false,
    "it never reported finishing",
  );

  const page = await journal(root);
  const record = page.records.find((entry) => entry.planId === "plan-recovery-000001");
  assert.ok(record, "the interrupted action is in the journal");
  assert.notEqual(record.state, "complete", `an interrupted action read as ${record.state}`);
  assert.ok(["partial", "uncertain"].includes(record.state), `unexpected state ${record.state}`);
  assert.ok(page.reconciled >= "1", "reconciliation said it resolved something");
});

test("no item is left claiming to be running once the journal has been reconciled", async () => {
  const { root, paths } = await sandbox(40);
  await runUntil(
    await trashRequest(root, paths),
    (seen) => seen.filter((event) => event.event === "item-result").length >= 3,
  );

  const record = (await journal(root)).records.find(
    (entry) => entry.planId === "plan-recovery-000001",
  );
  for (const item of record.items) {
    assert.notEqual(
      item.outcome,
      "in-progress",
      `${item.path} still claims to be running after reconciliation`,
    );
  }
});

test("nothing moved without a journal record saying so", async () => {
  const { root, paths } = await sandbox(40);
  await runUntil(
    await trashRequest(root, paths),
    (seen) => seen.filter((event) => event.event === "item-result").length >= 3,
  );

  const record = (await journal(root)).records.find(
    (entry) => entry.planId === "plan-recovery-000001",
  );
  const journalled = new Map(
    record.items.map((item) => [Buffer.from(item.path, "base64").toString("utf8"), item.outcome]),
  );

  for (const path of paths) {
    const outcome = journalled.get(path);
    if (existsSync(path)) {
      // Still where it was: the journal may say nothing about it, or say it was
      // skipped or uncertain, but it must never claim it completed.
      assert.notEqual(outcome, "completed", `${path} is still here and the journal says it moved`);
      continue;
    }
    // Gone from its original path: the journal has to account for it. An item
    // the helper moved without writing anything down is the failure this whole
    // design exists to prevent.
    assert.ok(
      outcome === "completed" || outcome === "uncertain",
      `${path} is gone and the journal says '${outcome ?? "nothing"}'`,
    );
  }
});

test("reconciling twice changes nothing the second time", async () => {
  const { root, paths } = await sandbox(20);
  await runUntil(
    await trashRequest(root, paths),
    (seen) => seen.filter((event) => event.event === "item-result").length >= 2,
  );

  const first = await journal(root);
  const second = await journal(root);
  assert.ok(first.reconciled >= "1");
  assert.equal(second.reconciled, "0", "the second reading had nothing left to resolve");
  assert.deepEqual(second.records, first.records, "the records did not move under a second read");
});

test("an action that finished is complete, and every item in it is accounted for", async () => {
  const { root, paths } = await sandbox(5);
  const { events } = await runUntil(await trashRequest(root, paths), () => false);
  const complete = events.find((event) => event.event === "complete");
  assert.ok(complete, "the action finished");
  assert.equal(complete.result.state, "complete");
  assert.equal(complete.result.completed, "5");

  const record = (await journal(root)).records.find((entry) => entry.id === complete.result.journalId);
  assert.equal(record.state, "complete");
  assert.equal(record.items.length, 5);
  for (const item of record.items) {
    assert.equal(item.outcome, "completed");
    assert.ok(item.destination, "a completed Trash item records where it went");
  }
});

/**
 * A sandbox of identical copies, plus the one that is kept.
 *
 * Every copy holds the same bytes, so each one is a legitimate replacement
 * and the only thing that stops the helper is being killed.
 */
async function duplicateSandbox(copies) {
  const root = await mkdtemp(join(tmpdir(), "disktop-recovery-link-"));
  sandboxes.push(root);
  const content = "y".repeat(8192);
  await mkdir(join(root, "work"), { recursive: true });
  const keep = join(root, "work", "keep.bin");
  await writeFile(keep, content);
  const paths = [];
  for (let index = 0; index < copies; index += 1) {
    const path = join(root, "work", `copy-${String(index).padStart(3, "0")}.bin`);
    await writeFile(path, content);
    paths.push(path);
  }
  return { root, keep, paths };
}

async function hardlinkRequest(root, keep, paths) {
  const targets = [];
  for (const path of paths) {
    targets.push({ path: encode(path), expected: await fingerprint(path), reviewedBytes: "8192" });
  }
  return request("dedup-hardlink", "link-recovery", {
    planId: "plan-recovery-link01",
    journalDirectory: encode(join(root, "state")),
    keep: { path: encode(keep), expected: await fingerprint(keep), reviewedBytes: "0" },
    targets,
  });
}

test("a hardlink replacement killed mid-action never reads as complete", async () => {
  const { root, keep, paths } = await duplicateSandbox(40);
  const { events, killed } = await runUntil(
    await hardlinkRequest(root, keep, paths),
    (seen) => seen.filter((event) => event.event === "item-result").length >= 3,
  );
  assert.equal(killed, true, "the helper was stopped while it still had work left");
  assert.equal(events.some((event) => event.event === "complete"), false);

  const record = (await journal(root)).records.find(
    (entry) => entry.planId === "plan-recovery-link01",
  );
  assert.ok(record, "the interrupted replacement is in the journal");
  assert.notEqual(record.state, "complete");
  assert.ok(["partial", "uncertain"].includes(record.state), `unexpected state ${record.state}`);
  for (const item of record.items) {
    assert.notEqual(item.outcome, "in-progress", "an item still claims to be running");
  }
});

test("a hardlink replacement leaves every reviewed name holding the right bytes, whenever it stops", async () => {
  const { root, keep, paths } = await duplicateSandbox(40);
  await runUntil(
    await hardlinkRequest(root, keep, paths),
    (seen) => seen.filter((event) => event.event === "item-result").length >= 3,
  );

  // Whether an item ran, was about to run, or never started, its name is
  // still there and still holds the content. The exchange is what guarantees
  // this: the name goes from one valid inode straight to the other.
  const expected = "y".repeat(8192);
  for (const path of [keep, ...paths]) {
    assert.ok(existsSync(path), `${path} stopped existing`);
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(path, "utf8"), expected, `${path} holds the wrong bytes`);
  }
});

test("a killed hardlink replacement leaves no staging name behind in the directory", async () => {
  const { root, keep, paths } = await duplicateSandbox(40);
  await runUntil(
    await hardlinkRequest(root, keep, paths),
    (seen) => seen.filter((event) => event.event === "item-result").length >= 3,
  );

  const { readdir } = await import("node:fs/promises");
  const names = await readdir(join(root, "work"));
  const staging = names.filter((name) => name.startsWith(".disktop-link"));
  // A kill between the link and the exchange can leave exactly one staging
  // name: the kernel offers no way to make those two steps one. More than one
  // would mean the helper is not cleaning up after itself between items.
  assert.ok(staging.length <= 1, `staging names left behind: ${JSON.stringify(staging)}`);
});

async function moveSandbox(count) {
  const root = await mkdtemp(join(tmpdir(), "disktop-recovery-move-"));
  sandboxes.push(root);
  await mkdir(join(root, "work"), { recursive: true });
  await mkdir(join(root, "elsewhere"), { recursive: true });
  const paths = [];
  for (let index = 0; index < count; index += 1) {
    const path = join(root, "work", `item-${String(index).padStart(3, "0")}.bin`);
    await writeFile(path, "z".repeat(16384));
    paths.push(path);
  }
  return { root, paths };
}

async function moveRequest(root, paths) {
  const targets = [];
  for (const path of paths) {
    targets.push({ path: encode(path), expected: await fingerprint(path), reviewedBytes: "16384" });
  }
  return request("copy-move", "move-recovery", {
    planId: "plan-recovery-move01",
    journalDirectory: encode(join(root, "state")),
    homeTrashDirectory: encode(join(root, "trash")),
    destinationDirectory: encode(join(root, "elsewhere")),
    sourceDisposition: "trash",
    targets,
  });
}

test("a move killed mid-action never reads as complete and never loses a source", async () => {
  const { root, paths } = await moveSandbox(40);
  const { events, killed } = await runUntil(
    await moveRequest(root, paths),
    (seen) => seen.filter((event) => event.event === "item-result").length >= 3,
  );
  assert.equal(killed, true, "the helper was stopped while it still had work left");
  assert.equal(events.some((event) => event.event === "complete"), false);

  const record = (await journal(root)).records.find(
    (entry) => entry.planId === "plan-recovery-move01",
  );
  assert.ok(record, "the interrupted move is in the journal");
  assert.notEqual(record.state, "complete");

  // Every source is either still where it was or in Trash. Nothing is gone:
  // the source is only touched after its copy is published and verified.
  const { readdir } = await import("node:fs/promises");
  const trashed = existsSync(join(root, "trash", "files"))
    ? await readdir(join(root, "trash", "files"))
    : [];
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    assert.ok(
      existsSync(path) || trashed.some((entry) => entry.startsWith(name)),
      `${name} is neither where it was nor in Trash`,
    );
  }
});

test("a killed move leaves no half-written file under a published name", async () => {
  const { root, paths } = await moveSandbox(40);
  await runUntil(
    await moveRequest(root, paths),
    (seen) => seen.filter((event) => event.event === "item-result").length >= 3,
  );

  const { readdir, readFile } = await import("node:fs/promises");
  const arrived = await readdir(join(root, "elsewhere"));
  for (const name of arrived) {
    if (name.includes(".disktop-partial")) {
      // A kill during the copy can leave exactly this: a staged name the
      // publish never reached. It is not a published name, which is the point.
      continue;
    }
    assert.equal(
      (await readFile(join(root, "elsewhere", name), "utf8")).length,
      16384,
      `${name} was published half-written`,
    );
  }
});
