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
