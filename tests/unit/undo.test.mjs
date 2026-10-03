import assert from "node:assert/strict";
import { test } from "node:test";
import { createUndoService } from "../../dist/application/undo.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";

const SIGNAL = new AbortController().signal;

const TRASHED = {
  id: "act-1759305679004-9f2c1ab07d4e5610",
  planId: "plan-01HQ8Z3M4K5N6P7Q",
  operation: "trash",
  startedAt: "2025-10-01T08:01:19.004Z",
  finishedAt: "2025-10-01T08:01:19.231Z",
  state: "complete",
  completed: 1n,
  skipped: 0n,
  failed: 0n,
  selectedBytes: 41943040n,
  bytesMovedToTrash: 41943040n,
  items: [
    {
      path: rawPathFromUtf8("/home/example/.cache/pip"),
      destination: rawPathFromUtf8("/home/example/.local/share/Trash/files/pip"),
      outcome: "completed",
      bytes: 41943040n,
    },
  ],
};

function service(records, overrides = {}) {
  const calls = [];
  return {
    calls,
    service: createUndoService({
      journal: {
        async list() {
          return { records, reconciled: overrides.reconciled ?? 0n };
        },
        async get(id) {
          calls.push({ kind: "get", id });
          return records.find((record) => record.id === id);
        },
      },
      actions: {
        async apply() {
          throw new Error("not used here");
        },
        async restore(journalId) {
          calls.push({ kind: "restore", journalId });
          return (
            overrides.result ?? {
              planId: "",
              completed: 1n,
              skipped: 0n,
              failed: 0n,
              selectedBytes: 41943040n,
              bytesMovedToTrash: 0n,
              state: "complete",
              journalId: "act-restore",
              undoAvailable: false,
            }
          );
        },
      },
    }),
  };
}

test("an unknown action is refused by name", async () => {
  const { service: undo, calls } = service([]);
  const outcome = await undo.restore("act-absent", SIGNAL);

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-input");
  assert.equal(calls.some((call) => call.kind === "restore"), false);
});

test("a permanent removal has nothing to put back and says so", async () => {
  const erased = { ...TRASHED, id: "act-erase", operation: "erase", items: [] };
  const { service: undo, calls } = service([erased]);
  const outcome = await undo.restore("act-erase", SIGNAL);

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "unsupported");
  assert.match(outcome.failure.message, /cannot be undone/i);
  assert.equal(calls.some((call) => call.kind === "restore"), false);
});

test("an action reconciliation could not judge is refused until it has been", async () => {
  const uncertain = { ...TRASHED, id: "act-uncertain", state: "uncertain" };
  const { service: undo } = service([uncertain]);
  const outcome = await undo.restore("act-uncertain", SIGNAL);

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-plan");
});

test("undoing a Trash action restores it and reports what came back", async () => {
  const { service: undo, calls } = service([TRASHED]);
  const outcome = await undo.restore(TRASHED.id, SIGNAL);

  assert.equal(outcome.kind, "restored");
  assert.equal(outcome.result.completed, 1n);
  assert.equal(
    outcome.result.planId,
    TRASHED.planId,
    "the restore reports the plan it undid; only the record knows which one that was",
  );
  assert.deepEqual(
    calls.filter((call) => call.kind === "restore"),
    [{ kind: "restore", journalId: TRASHED.id }],
  );
});

test("history reconciles before it is read, so an abandoned action never reads as running", async () => {
  const { service: undo } = service([TRASHED], { reconciled: 2n });
  const page = await undo.history();

  assert.equal(page.reconciled, 2n);
  assert.equal(page.records.length, 1);
});

// --- Undoing the shapes that publish an output ---

test("undoing a move that trashed its source restores it and says the copy is still there", async () => {
  const moved = { ...TRASHED, id: "act-move", operation: "copy-move" };
  const { service: undo, calls } = service([moved]);

  const outcome = await undo.restore("act-move", SIGNAL);

  assert.equal(outcome.kind, "restored");
  assert.ok(calls.some((call) => call.kind === "restore"));
  assert.ok(
    outcome.notes.some((note) => /copy|destination|published/i.test(note)),
    `notes were ${JSON.stringify(outcome.notes)}`,
  );
});

test("undoing a compress says the archive it published is still where it was put", async () => {
  const compressed = { ...TRASHED, id: "act-zst", operation: "compress" };
  const { service: undo } = service([compressed]);

  const outcome = await undo.restore("act-zst", SIGNAL);

  assert.equal(outcome.kind, "restored");
  assert.ok(
    outcome.notes.some((note) => /archive/i.test(note)),
    `notes were ${JSON.stringify(outcome.notes)}`,
  );
});

test("a history page that left items out is no evidence that nothing went to Trash", async () => {
  // A large move's first items failed; the ones that went to Trash are among
  // those the page did not carry. The helper reads the whole record itself.
  const shortened = {
    ...TRASHED,
    id: "act-shortened",
    operation: "copy-move",
    items: [{ ...TRASHED.items[0], destination: undefined, outcome: "failed" }],
    itemsOmitted: 499_999n,
  };
  const { service: undo, calls } = service([shortened]);

  const outcome = await undo.restore("act-shortened", SIGNAL);

  assert.equal(outcome.kind, "restored");
  assert.equal(calls.some((call) => call.kind === "restore"), true);
});

test("undoing a move whose source was removed permanently refuses", async () => {
  const permanent = {
    ...TRASHED,
    id: "act-permanent",
    operation: "copy-move",
    bytesMovedToTrash: 0n,
    items: [{ ...TRASHED.items[0], destination: undefined }],
  };
  const { service: undo, calls } = service([permanent]);

  const outcome = await undo.restore("act-permanent", SIGNAL);

  assert.equal(outcome.kind, "refused");
  assert.match(outcome.failure.message, /permanently|nothing to put back/i);
  assert.equal(calls.some((call) => call.kind === "restore"), false);
});

test("a plain Trash undo says nothing about a destination it never had", async () => {
  const { service: undo } = service([TRASHED]);

  const outcome = await undo.restore(TRASHED.id, SIGNAL);

  assert.equal(outcome.kind, "restored");
  assert.equal(
    outcome.notes.some((note) => /archive|copy at the destination/i.test(note)),
    false,
  );
});

test("an undo note does not present the restored sources as the output it published", async () => {
  const moved = { ...TRASHED, id: "act-note", operation: "copy-move" };
  const { service: undo } = service([moved]);

  const outcome = await undo.restore("act-note", SIGNAL);

  assert.equal(outcome.kind, "restored");
  const listing = outcome.notes.find((note) => /Restored:|no longer want/i.test(note));
  if (listing !== undefined) {
    assert.doesNotMatch(
      listing,
      /\/home\/example\/\.cache\/pip/,
      "the note offers to remove the copy, so it must not name the source it just put back",
    );
  }
});

test("an undo says plainly that Disktop does not know where the output went", async () => {
  const moved = { ...TRASHED, id: "act-where", operation: "copy-move" };
  const { service: undo } = service([moved]);

  const outcome = await undo.restore("act-where", SIGNAL);

  assert.ok(
    outcome.notes.some((note) => /history|where it was published|does not record/i.test(note)),
    `notes were ${JSON.stringify(outcome.notes)}`,
  );
});
