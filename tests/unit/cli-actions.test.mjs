import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "../../dist/cli/run.js";
import { compileBundle } from "../support/schemas.mjs";
import { fakeContext, rawPath } from "../support/cli-context.mjs";

const validators = compileBundle("schemas/cli/v1");

function envelopeOf(context, schema) {
  const envelope = JSON.parse(context.captured.stdout);
  const validate = validators.get(schema);
  assert.ok(validate, `${schema} has no schema`);
  assert.ok(validate(envelope), `${schema}: ${JSON.stringify(validate.errors)}`);
  return envelope;
}

const PLAN = {
  id: "plan-20260929T081504117Z-0a1b2c3d",
  operation: "trash",
  createdAt: "2026-09-29T08:15:04.117Z",
  expiresAt: "2026-09-29T09:15:04.117Z",
  providerId: "cache.language",
  findingId: "cache.language:cargo-registry",
  scopeSummary: "1 directory, starting at /home/example/.cargo/registry",
  reversibility: "undo-from-trash",
  permission: "user",
  exactItemCount: 1n,
  selectedBytes: 7_314_112_512n,
  entries: [
    {
      path: rawPath("/home/example/.cargo/registry"),
      expected: {
        device: 2049n,
        inode: 1_442_113n,
        mountId: "29",
        kind: "directory",
        apparentBytes: 4096n,
        modifiedNanoseconds: 1_759_190_400_123_456_789n,
      },
      reviewedBytes: 7_314_112_512n,
      subtree: { entries: 1284n, digest: "5f2c".padEnd(64, "0") },
    },
  ],
  regenerationCost: "Re-downloaded on the next build that needs a crate.",
  warnings: ["Downloaded crate sources and their index."],
};

const RESULT = {
  planId: PLAN.id,
  completed: 1n,
  skipped: 0n,
  failed: 0n,
  selectedBytes: 7_314_112_512n,
  bytesMovedToTrash: 7_314_112_512n,
  freeBytesBefore: 450_000_000_000n,
  freeBytesAfter: 450_000_000_000n,
  state: "complete",
  journalId: "act-1759305679004-9f2c1ab07d4e5610",
  undoAvailable: true,
  verification: [
    {
      check: "source-disposed",
      outcome: "passed",
      detail: "All 1 reviewed item(s) were dealt with.",
    },
    {
      check: "free-space-read",
      outcome: "passed",
      detail: "Free space was read before the first item and after the last.",
    },
  ],
};

const RECORD = {
  id: RESULT.journalId,
  planId: PLAN.id,
  operation: "trash",
  startedAt: "2026-09-29T08:15:04.117Z",
  finishedAt: "2026-09-29T08:15:04.331Z",
  state: "complete",
  completed: 1n,
  skipped: 0n,
  failed: 0n,
  selectedBytes: 7_314_112_512n,
  bytesMovedToTrash: 7_314_112_512n,
  freeBytesBefore: 450_000_000_000n,
  freeBytesAfter: 450_000_000_000n,
  items: [
    {
      path: rawPath("/home/example/.cargo/registry"),
      destination: rawPath("/home/example/.local/share/Trash/files/registry"),
      outcome: "completed",
      bytes: 7_314_112_512n,
    },
  ],
};

function actionContext(overrides = {}) {
  const recorded = {};
  const context = fakeContext();
  context.actions = {
    async plan(request) {
      recorded.plan = request;
      return overrides.planOutcome ?? { kind: "planned", plan: PLAN };
    },
    async apply(request) {
      recorded.apply = request;
      return (
        overrides.applyOutcome ?? {
          kind: "applied",
          plan: PLAN,
          result: RESULT,
          observedFreeSpaceChange: 0n,
          notes: ["A Trash move on the same filesystem usually frees nothing until Trash is emptied."],
        }
      );
    },
    async history(cursor, limit) {
      recorded.history = { cursor, limit };
      return overrides.history ?? { records: [RECORD], reconciled: 0n };
    },
    async restore(journalId) {
      recorded.restore = journalId;
      return (
        overrides.undoOutcome ?? {
          kind: "restored",
          record: RECORD,
          result: { ...RESULT, journalId: "act-restore", undoAvailable: false, bytesMovedToTrash: 0n },
          notes: [],
        }
      );
    },
    async find(request) {
      recorded.find = request;
      return (
        overrides.findOutcome ?? {
          kind: "found",
          entries: [
            {
              id: "41",
              path: rawPath("/home/example/projects/empty"),
              kind: "directory",
              device: 2049n,
              inode: 77n,
              mountId: "29",
              linkCount: 2n,
              apparentBytes: 4096n,
              allocatedBytes: 4096n,
              ownerId: 1000n,
              modifiedNanoseconds: 1n,
              shared: false,
              childEntries: 0n,
            },
          ],
        }
      );
    },
  };
  context.recordedActions = recorded;
  return context;
}

test("planning a finding writes a plan envelope a script can read", async () => {
  const context = actionContext();
  const status = await runCli(
    ["clean", "plan", "cache.language:cargo-registry", "--operation", "trash", "--json"],
    context,
  );
  const envelope = envelopeOf(context, "plan");

  assert.equal(status, 0);
  assert.equal(envelope.command, "clean plan");
  assert.equal(envelope.data.plan.id, PLAN.id);
  assert.equal(envelope.data.plan.operation, "trash");
  assert.equal(envelope.data.plan.reversibility, "undo-from-trash");
  assert.equal(envelope.data.plan.selectedBytes, "7314112512");
  assert.equal(envelope.data.plan.entries[0].reviewedBytes, "7314112512");
  assert.deepEqual(context.recordedActions.plan, {
    operation: "trash",
    findingId: "cache.language:cargo-registry",
  });
});

test("planning a protected path exits 2 and says which rule refused it", async () => {
  const context = actionContext({
    planOutcome: {
      kind: "refused",
      failure: { code: "protected-path", message: "/etc/passwd cannot be cleaned up." },
    },
  });
  const status = await runCli(["clean", "plan", "--path", "/etc/passwd", "--json"], context);
  const envelope = envelopeOf(context, "plan");

  assert.equal(status, 2);
  assert.equal(envelope.status, "error");
  assert.equal(envelope.error.code, "protected-path");
});

test("planning needs something to plan", async () => {
  const context = actionContext();
  const status = await runCli(["clean", "plan", "--json"], context);
  assert.equal(status, 2);
  assert.equal(envelopeOf(context, "plan").error.code, "invalid-input");
});

test("a missing --yes is forwarded as a missing confirmation, and the refusal is what the user sees", async () => {
  const context = actionContext({
    applyOutcome: {
      kind: "refused",
      failure: { code: "invalid-input", message: "Applying that plan needs --yes." },
    },
  });
  const status = await runCli(["clean", "apply", PLAN.id, "--json"], context);

  // The handler judges nothing. One place decides whether a plan may run, and
  // it is the same place whether the request came from the CLI or the TUI.
  assert.equal(context.recordedActions.apply.confirmed, false);
  assert.equal(status, 2);
  assert.equal(envelopeOf(context, "apply").error.code, "invalid-input");
});

test("applying a confirmed plan reports the three numbers separately", async () => {
  const context = actionContext();
  const status = await runCli(["clean", "apply", PLAN.id, "--yes", "--json"], context);
  const envelope = envelopeOf(context, "apply");

  assert.equal(status, 0);
  assert.equal(envelope.command, "clean apply");
  assert.equal(envelope.data.result.selectedBytes, "7314112512");
  assert.equal(envelope.data.result.bytesMovedToTrash, "7314112512");
  assert.equal(envelope.data.result.observedFreeSpaceChange, "0");
  assert.equal(envelope.data.result.journalId, RESULT.journalId);
  assert.deepEqual(context.recordedActions.apply, {
    planId: PLAN.id,
    confirmed: true,
    acknowledgePermanent: false,
    interactive: false,
  });
});

test("a partial apply exits 3 and says what it could not do", async () => {
  const context = actionContext({
    applyOutcome: {
      kind: "applied",
      plan: PLAN,
      result: { ...RESULT, completed: 0n, skipped: 1n, state: "partial", bytesMovedToTrash: 0n },
      observedFreeSpaceChange: 0n,
      notes: [],
    },
  });
  const status = await runCli(["clean", "apply", PLAN.id, "--yes", "--json"], context);
  const envelope = envelopeOf(context, "apply");

  assert.equal(status, 3);
  assert.equal(envelope.status, "incomplete");
  assert.ok(envelope.warnings.length >= 1);
});

test("--permanent reaches the service, which is the only thing allowed to judge it", async () => {
  const context = actionContext({
    applyOutcome: {
      kind: "refused",
      failure: { code: "invalid-plan", message: "That plan moves its targets to Trash." },
    },
  });
  const status = await runCli(["clean", "apply", PLAN.id, "--yes", "--permanent", "--json"], context);

  assert.equal(status, 2);
  assert.equal(context.recordedActions.apply.acknowledgePermanent, true);
  assert.equal(envelopeOf(context, "apply").error.code, "invalid-plan");
});

test("history lists what was done, with every number as a decimal string", async () => {
  const context = actionContext();
  const status = await runCli(["history", "--json"], context);
  const envelope = envelopeOf(context, "history");

  assert.equal(status, 0);
  assert.equal(envelope.command, "history");
  assert.equal(envelope.data.records.length, 1);
  assert.equal(envelope.data.records[0].bytesMovedToTrash, "7314112512");
  assert.equal(envelope.data.records[0].items[0].outcome, "completed");
  assert.equal(envelope.data.reconciled, "0");
});

test("undo without --yes refuses, and with it reports what came back", async () => {
  const refused = actionContext();
  assert.equal(await runCli(["undo", RESULT.journalId, "--json"], refused), 2);
  assert.equal(refused.recordedActions.restore, undefined);

  const context = actionContext();
  const status = await runCli(["undo", RESULT.journalId, "--yes", "--json"], context);
  const envelope = envelopeOf(context, "undo");

  assert.equal(status, 0);
  assert.equal(envelope.data.result.completed, "1");
  assert.equal(context.recordedActions.restore, RESULT.journalId);
});

test("find empty answers from the stored scan and validates against its schema", async () => {
  const context = actionContext();
  const status = await runCli(["find", "empty", "--json"], context);
  const envelope = envelopeOf(context, "find");

  assert.equal(status, 0);
  assert.equal(envelope.command, "find");
  assert.equal(envelope.data.kind, "empty");
  assert.equal(envelope.data.entries.length, 1);
  assert.equal(envelope.data.entries[0].childEntries, "0");
  assert.equal(context.recordedActions.find.kind, "empty");
});

test("find duplicates is declared and refuses, because Phase 5 owns it", async () => {
  const context = actionContext({
    findOutcome: {
      kind: "refused",
      failure: { code: "not-implemented", message: "'disktop find duplicates' is not implemented yet." },
    },
  });
  const status = await runCli(["find", "duplicates", "--json"], context);

  assert.equal(status, 2);
  assert.equal(envelopeOf(context, "find").error.code, "not-implemented");
});

test("find refuses a kind that is not one of the four", async () => {
  const context = actionContext();
  const status = await runCli(["find", "enormous", "--json"], context);

  assert.equal(status, 2);
  assert.equal(envelopeOf(context, "find").error.code, "invalid-input");
  assert.equal(context.recordedActions.find, undefined);
});

test("Ctrl+C during 'find duplicates' aborts the signal the search was given", async () => {
  const handlers = new Set();
  let received;
  const context = fakeContext({
    actions: {
      async find(_request, signal) {
        received = signal;
        for (const handler of handlers) handler();
        return { kind: "duplicates", result: { kind: "found", groups: [], reclaimableBytes: 0n, complete: true, warnings: [], candidatesRead: 0n, filesHashed: 0n } };
      },
    },
  });
  context.signals = { listen: (handler) => handlers.add(handler), stop: (handler) => handlers.delete(handler) };
  await runCli(["find", "duplicates", "--json"], context);
  assert.ok(received, "the search was handed a signal");
  assert.equal(received.aborted, true);
  assert.equal(handlers.size, 0, "the interrupt listener is removed afterwards");
});

test("history reaches the page a cursor names, at the size asked for", async () => {
  const context = actionContext({ history: { records: [RECORD], reconciled: 0n, nextCursor: "c0ffee" } });
  const status = await runCli(["history", "--cursor", "abc123", "--limit", "5", "--json"], context);
  assert.equal(status, 0);
  assert.deepEqual(context.recordedActions.history, { cursor: "abc123", limit: 5 });
  assert.equal(envelopeOf(context, "history").data.nextCursor, "c0ffee");
});

test("history in text says how to reach the next page", async () => {
  const context = actionContext({ history: { records: [RECORD], reconciled: 0n, nextCursor: "c0ffee" } });
  await runCli(["history"], context);
  assert.match(context.captured.stdout, /disktop history --cursor c0ffee/);
});

for (const limit of ["0", "201", "ten"]) {
  test(`history --limit ${limit} is an input error`, async () => {
    const context = actionContext();
    const status = await runCli(["history", "--limit", limit, "--json"], context);
    assert.equal(status, 2);
    assert.equal(envelopeOf(context, "history").error.code, "invalid-input");
  });
}

test("a cursor the journal did not issue is an input error from history, not a crash", async () => {
  const context = actionContext();
  context.actions.history = async () => {
    const error = new Error("The journal cursor is not one this journal issued.");
    error.failure = { code: "invalid-plan", message: "The journal could not be read: The journal cursor is not one this journal issued." };
    throw error;
  };
  const status = await runCli(["history", "--cursor", "zz", "--json"], context);
  assert.equal(status, 2);
  const envelope = envelopeOf(context, "history");
  assert.equal(envelope.command, "history");
  assert.equal(envelope.error.code, "invalid-input");
});

test("apply tells the pipeline whether a password prompt can be answered", async () => {
  const atTerminal = actionContext();
  atTerminal.interactive = true;
  await runCli(["clean", "apply", PLAN.id, "--yes"], atTerminal);
  assert.equal(atTerminal.recordedActions.apply.interactive, true);

  const scripted = actionContext();
  scripted.interactive = true;
  await runCli(["clean", "apply", PLAN.id, "--yes", "--json"], scripted);
  assert.equal(scripted.recordedActions.apply.interactive, false, "--json never prompts");
});

test("an action this machine cannot carry out says why, without claiming it is about files", async () => {
  const context = actionContext({
    applyOutcome: { kind: "unavailable", capability: { status: "missing-tool", explanation: "Disktop has no apt adapter on this machine." } },
  });
  const status = await runCli(["clean", "apply", PLAN.id, "--yes", "--json"], context);
  assert.equal(status, 2);
  const message = envelopeOf(context, "apply").error.message;
  assert.match(message, /no apt adapter/);
  assert.doesNotMatch(message, /change files/);
});
