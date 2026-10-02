import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlan } from "../../dist/domain/actions.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";
import { createNativeActions } from "../../dist/platform/linux/actions/index.js";

const JOURNAL_DIRECTORY = "/home/example/.local/state/disktop";
const HOME_TRASH_DIRECTORY = "/home/example/.local/share/Trash";
const NOW = new Date("2026-10-01T09:00:00.000Z");

function plan(overrides = {}) {
  return buildPlan({
    operation: "trash",
    providerId: "cache.language",
    findingId: "cache.language:pip",
    scopeSummary: "1 directory under ~/.cache",
    createdAt: NOW,
    expiryMinutes: 60,
    warnings: [],
    entries: [
      {
        path: rawPathFromUtf8("/home/example/.cache/pip"),
        expected: {
          device: 66306n,
          inode: 1179651n,
          mountId: "29",
          kind: "directory",
          apparentBytes: 4096n,
          modifiedNanoseconds: 1758000000123456789n,
        },
        reviewedBytes: 41943040n,
      },
    ],
    ...overrides,
  });
}

/** A helper that answers with scripted events and remembers what it was asked. */
function fakeHelper(events) {
  const sent = [];
  const client = {
    async *stream(operation, operationArguments) {
      sent.push({ operation, arguments: operationArguments });
      for (const event of events) {
        yield event;
      }
    },
    async request(operation, operationArguments) {
      sent.push({ operation, arguments: operationArguments });
      return events[events.length - 1];
    },
    diagnostics: () => "",
    close: async () => {},
  };
  return { sent, start: async () => ({ started: true, client, hello: {}, location: {} }) };
}

const COMPLETED = {
  protocolVersion: 1,
  requestId: "trash-1",
  eventId: "2",
  event: "complete",
  result: {
    journalId: "act-1759305679004-9f2c1ab07d4e5610",
    state: "complete",
    completed: "1",
    skipped: "0",
    failed: "0",
    selectedBytes: "41943040",
    bytesMovedToTrash: "41943040",
    freeBytesBefore: "42949672960",
    freeBytesAfter: "42949672960",
    undoAvailable: true,
  },
};

test("applying a plan sends every reviewed identity the helper will check against", async () => {
  const helper = fakeHelper([COMPLETED]);
  const actions = createNativeActions({
    journalDirectory: JOURNAL_DIRECTORY,
    homeTrashDirectory: HOME_TRASH_DIRECTORY,
    start: helper.start,
  });

  const reviewed = plan();
  await actions.apply(reviewed, new AbortController().signal);

  assert.equal(helper.sent.length, 1);
  const [request] = helper.sent;
  assert.equal(request.operation, "trash");
  assert.equal(request.arguments.planId, reviewed.id);
  assert.equal(request.arguments.journalDirectory, rawPathFromUtf8(JOURNAL_DIRECTORY).bytesBase64);
  assert.equal(
    request.arguments.homeTrashDirectory,
    rawPathFromUtf8(HOME_TRASH_DIRECTORY).bytesBase64,
  );
  assert.deepEqual(request.arguments.targets, [
    {
      path: rawPathFromUtf8("/home/example/.cache/pip").bytesBase64,
      expected: {
        device: "66306",
        inode: "1179651",
        mountId: "29",
        kind: "directory",
        apparentBytes: "4096",
        modifiedNanoseconds: "1758000000123456789",
      },
      reviewedBytes: "41943040",
    },
  ]);
});

test("a result keeps selected bytes, trashed bytes, and the two readings apart", async () => {
  const helper = fakeHelper([COMPLETED]);
  const actions = createNativeActions({
    journalDirectory: JOURNAL_DIRECTORY,
    homeTrashDirectory: HOME_TRASH_DIRECTORY,
    start: helper.start,
  });

  const result = await actions.apply(plan(), new AbortController().signal);
  assert.equal(result.selectedBytes, 41943040n);
  assert.equal(result.bytesMovedToTrash, 41943040n);
  assert.equal(result.freeBytesBefore, 42949672960n);
  assert.equal(result.freeBytesAfter, 42949672960n);
  assert.equal(result.state, "complete");
  assert.equal(result.journalId, "act-1759305679004-9f2c1ab07d4e5610");
  assert.equal(result.undoAvailable, true);
});

test("a permanent plan becomes an erase, which never names a Trash", async () => {
  const helper = fakeHelper([COMPLETED]);
  const actions = createNativeActions({
    journalDirectory: JOURNAL_DIRECTORY,
    homeTrashDirectory: HOME_TRASH_DIRECTORY,
    start: helper.start,
  });

  await actions.apply(plan({ operation: "permanent" }), new AbortController().signal);
  const [request] = helper.sent;
  assert.equal(request.operation, "erase");
  assert.equal(request.arguments.homeTrashDirectory, undefined);
});

test("a success that names no journal record is a protocol violation, not a success", async () => {
  const helper = fakeHelper([
    { ...COMPLETED, result: { ...COMPLETED.result, journalId: undefined } },
  ]);
  const actions = createNativeActions({
    journalDirectory: JOURNAL_DIRECTORY,
    homeTrashDirectory: HOME_TRASH_DIRECTORY,
    start: helper.start,
  });

  await assert.rejects(
    actions.apply(plan(), new AbortController().signal),
    /journal/i,
  );
});

test("a refused protected path reaches the caller as a protected-path failure", async () => {
  const helper = fakeHelper([
    {
      protocolVersion: 1,
      requestId: "trash-1",
      eventId: "1",
      event: "error",
      error: { code: "protected-path", message: "The target is a protected system root." },
    },
  ]);
  const actions = createNativeActions({
    journalDirectory: JOURNAL_DIRECTORY,
    homeTrashDirectory: HOME_TRASH_DIRECTORY,
    start: helper.start,
  });

  await assert.rejects(actions.apply(plan(), new AbortController().signal), (error) => {
    assert.equal(error.failure.code, "protected-path");
    return true;
  });
});

test("a denied permission reaches the caller as a missing capability", async () => {
  const helper = fakeHelper([
    {
      protocolVersion: 1,
      requestId: "trash-1",
      eventId: "1",
      event: "error",
      error: { code: "permission-denied", message: "This user may not move the target." },
    },
  ]);
  const actions = createNativeActions({
    journalDirectory: JOURNAL_DIRECTORY,
    homeTrashDirectory: HOME_TRASH_DIRECTORY,
    start: helper.start,
  });

  await assert.rejects(actions.apply(plan(), new AbortController().signal), (error) => {
    assert.equal(error.name, "CapabilityUnavailable");
    assert.equal(error.capability.status, "permission-denied");
    return true;
  });
});

test("reading the journal reconciles first and decodes every number losslessly", async () => {
  const helper = fakeHelper([
    {
      protocolVersion: 1,
      requestId: "journal-reconcile-1",
      eventId: "1",
      event: "complete",
      result: {
        reconciled: "1",
        records: [
          {
            id: "act-1759305679004-9f2c1ab07d4e5610",
            planId: "plan-01HQ8Z3M4K5N6P7Q",
            operation: "trash",
            startedAtMilliseconds: "1759305679004",
            finishedAtMilliseconds: "1759305679231",
            state: "complete",
            completed: "1",
            skipped: "0",
            failed: "0",
            selectedBytes: "9007199254740993",
            bytesMovedToTrash: "9007199254740993",
            items: [
              {
                position: "0",
                path: rawPathFromUtf8("/home/example/.cache/pip").bytesBase64,
                destination: rawPathFromUtf8("/home/example/.local/share/Trash/files/pip")
                  .bytesBase64,
                outcome: "completed",
                bytes: "9007199254740993",
              },
            ],
          },
        ],
      },
    },
  ]);
  const actions = createNativeActions({
    journalDirectory: JOURNAL_DIRECTORY,
    homeTrashDirectory: HOME_TRASH_DIRECTORY,
    start: helper.start,
  });

  const page = await actions.list();
  assert.equal(helper.sent[0].operation, "journal-reconcile");
  assert.equal(page.reconciled, 1n);
  assert.equal(page.records.length, 1);
  const [record] = page.records;
  assert.equal(record.selectedBytes, 9007199254740993n, "a byte count past 2^53 keeps its value");
  assert.equal(record.startedAt, "2025-10-01T08:01:19.004Z");
  assert.equal(record.items[0].path.display, "/home/example/.cache/pip");
  assert.equal(record.items[0].destination.display, "/home/example/.local/share/Trash/files/pip");
});

test("a journal item's message reaches Disktop with its control characters made visible", async () => {
  const helper = fakeHelper([
    {
      protocolVersion: 1,
      requestId: "journal-reconcile-1",
      eventId: "1",
      event: "complete",
      result: {
        reconciled: "0",
        records: [
          {
            id: "act-1759305679004-9f2c1ab07d4e5610",
            planId: "plan-01HQ8Z3M4K5N6P7Q",
            operation: "trash",
            startedAtMilliseconds: "1759305679004",
            state: "partial",
            completed: "0",
            skipped: "1",
            failed: "0",
            selectedBytes: "1",
            bytesMovedToTrash: "0",
            items: [
              {
                position: "0",
                path: rawPathFromUtf8("/home/example/a").bytesBase64,
                outcome: "skipped",
                message: "changed\u001b[2J\nsecond line",
                bytes: "1",
              },
            ],
          },
        ],
      },
    },
  ]);
  const actions = createNativeActions({
    journalDirectory: JOURNAL_DIRECTORY,
    homeTrashDirectory: HOME_TRASH_DIRECTORY,
    start: helper.start,
  });
  const page = await actions.list();
  assert.doesNotMatch(page.records[0].items[0].message, /[\u001b\n]/);
});

test("a directory target carries its reviewed subtree to the helper", async () => {
  const helper = fakeHelper([COMPLETED]);
  const actions = createNativeActions({ journalDirectory: JOURNAL_DIRECTORY, homeTrashDirectory: HOME_TRASH_DIRECTORY, start: helper.start });
  const reviewed = plan();
  const withSubtree = { ...reviewed, entries: [{ ...reviewed.entries[0], subtree: { entries: 9n, digest: "b".repeat(64) } }] };
  await actions.apply(withSubtree, new AbortController().signal);
  assert.deepEqual(helper.sent[0].arguments.targets[0].subtree, { entries: "9", digest: "b".repeat(64) });
});

test("inspect asks the helper once and answers per path", async () => {
  const pip = rawPathFromUtf8("/home/example/.cache/pip");
  const etc = rawPathFromUtf8("/home/example/mnt");
  const helper = fakeHelper([
    {
      protocolVersion: 1,
      requestId: "inspect-1",
      eventId: "2",
      event: "complete",
      result: {
        paths: [
          { path: pip.bytesBase64, subtree: { entries: "4", digest: "c".repeat(64) } },
          { path: etc.bytesBase64, refusal: { code: "protected-path", message: "Another filesystem is mounted inside this directory." } },
        ],
      },
    },
  ]);
  const actions = createNativeActions({ journalDirectory: JOURNAL_DIRECTORY, homeTrashDirectory: HOME_TRASH_DIRECTORY, start: helper.start });
  const answers = await actions.inspect([pip, etc], new AbortController().signal);
  assert.equal(helper.sent[0].operation, "inspect");
  assert.deepEqual(answers.get(pip.bytesBase64), { kind: "inspected", subtree: { entries: 4n, digest: "c".repeat(64) } });
  assert.equal(answers.get(etc.bytesBase64).kind, "refused");
  assert.equal(answers.get(etc.bytesBase64).code, "protected-path");
});

test("emptying Trash names each Trash directory with what it held at review", async () => {
  const helper = fakeHelper([COMPLETED]);
  const actions = createNativeActions({ journalDirectory: JOURNAL_DIRECTORY, homeTrashDirectory: HOME_TRASH_DIRECTORY, start: helper.start });
  const trash = rawPathFromUtf8(HOME_TRASH_DIRECTORY);
  const emptying = plan({
    operation: "empty-trash",
    entries: [
      {
        path: trash,
        expected: { device: 1n, inode: 2n, mountId: "1", kind: "directory", apparentBytes: 4096n, modifiedNanoseconds: 1n },
        reviewedBytes: 0n,
        subtree: { entries: 2n, digest: "d".repeat(64) },
      },
    ],
  });
  await actions.apply(emptying, new AbortController().signal);
  assert.deepEqual(helper.sent[0].arguments.trashDirectories, [
    { path: trash.bytesBase64, subtree: { entries: "2", digest: "d".repeat(64) } },
  ]);
});
