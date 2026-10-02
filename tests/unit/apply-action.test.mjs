import assert from "node:assert/strict";
import { test } from "node:test";
import { createApplyService } from "../../dist/application/apply-action.js";
import { buildPlan } from "../../dist/domain/actions.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";

const NOW = new Date("2026-10-01T09:00:00.000Z");
const SIGNAL = new AbortController().signal;

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

const RESULT = {
  planId: "",
  completed: 1n,
  skipped: 0n,
  failed: 0n,
  selectedBytes: 41943040n,
  bytesMovedToTrash: 41943040n,
  freeBytesBefore: 42949672960n,
  freeBytesAfter: 42949672960n,
  state: "complete",
  journalId: "act-1759305679004-9f2c1ab07d4e5610",
  undoAvailable: true,
};

function service(stored, overrides = {}) {
  const applied = [];
  return {
    applied,
    service: createApplyService({
      store: {
        async get(id) {
          return stored?.id === id ? stored : undefined;
        },
      },
      actions: {
        async apply(reviewed) {
          applied.push(reviewed);
          return overrides.result ?? { ...RESULT, planId: reviewed.id };
        },
        async restore() {
          throw new Error("not used here");
        },
      },
      now: () => overrides.now ?? NOW,
      ...(overrides.currentRuleHashes === undefined
        ? {}
        : { currentRuleHashes: overrides.currentRuleHashes }),
    }),
  };
}

test("an unknown plan id is refused and nothing is applied", async () => {
  const { service: apply, applied } = service(undefined);
  const outcome = await apply.apply({ planId: "plan-absent", confirmed: true }, SIGNAL);

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-plan");
  assert.deepEqual(applied, []);
});

test("an unconfirmed apply refuses rather than running what it was handed", async () => {
  const stored = plan();
  const { service: apply, applied } = service(stored);
  const outcome = await apply.apply({ planId: stored.id, confirmed: false }, SIGNAL);

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-input");
  assert.deepEqual(applied, []);
});

test("an expired plan is refused rather than applied to whatever is there now", async () => {
  const stored = plan();
  const { service: apply, applied } = service(stored, {
    now: new Date("2026-10-01T10:00:01.000Z"),
  });
  const outcome = await apply.apply({ planId: stored.id, confirmed: true }, SIGNAL);

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-plan");
  assert.match(outcome.failure.message, /expired/i);
  assert.deepEqual(applied, []);
});

test("a permanent plan without its acknowledgement is refused", async () => {
  const stored = plan({ operation: "permanent" });
  const { service: apply, applied } = service(stored);
  const outcome = await apply.apply({ planId: stored.id, confirmed: true }, SIGNAL);

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-plan");
  assert.match(outcome.failure.message, /--permanent/);
  assert.deepEqual(applied, []);
});

test("acknowledging permanence on a Trash plan is refused rather than taken as an upgrade", async () => {
  const stored = plan();
  const { service: apply, applied } = service(stored);
  const outcome = await apply.apply(
    { planId: stored.id, confirmed: true, acknowledgePermanent: true },
    SIGNAL,
  );

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-plan");
  assert.match(outcome.failure.message, /Trash/);
  assert.deepEqual(applied, []);
});

test("a confirmed permanent plan runs once its irreversibility is acknowledged", async () => {
  const stored = plan({ operation: "permanent" });
  const { service: apply, applied } = service(stored);
  const outcome = await apply.apply(
    { planId: stored.id, confirmed: true, acknowledgePermanent: true },
    SIGNAL,
  );

  assert.equal(outcome.kind, "applied");
  assert.equal(applied.length, 1);
  assert.equal(applied[0].operation, "permanent");
});

test("a result keeps selected bytes, trashed bytes, and the observed change apart", async () => {
  const stored = plan();
  const { service: apply } = service(stored);
  const outcome = await apply.apply({ planId: stored.id, confirmed: true }, SIGNAL);

  assert.equal(outcome.kind, "applied");
  assert.equal(outcome.result.selectedBytes, 41943040n);
  assert.equal(outcome.result.bytesMovedToTrash, 41943040n);
  assert.equal(outcome.observedFreeSpaceChange, 0n);
  assert.ok(
    outcome.notes.some((note) => /other processes/i.test(note)),
    `notes were ${JSON.stringify(outcome.notes)}`,
  );
});

test("a partial result says so and keeps the counts it really achieved", async () => {
  const stored = plan();
  const { service: apply } = service(stored, {
    result: {
      ...RESULT,
      completed: 0n,
      skipped: 1n,
      bytesMovedToTrash: 0n,
      state: "partial",
      undoAvailable: false,
    },
  });
  const outcome = await apply.apply({ planId: stored.id, confirmed: true }, SIGNAL);

  assert.equal(outcome.kind, "applied");
  assert.equal(outcome.result.state, "partial");
  assert.equal(outcome.result.skipped, 1n);
  assert.equal(outcome.result.bytesMovedToTrash, 0n);
});

test("free space that nothing could read leaves the observed change unknown rather than zero", async () => {
  const stored = plan();
  const { service: apply } = service(stored, {
    result: { ...RESULT, freeBytesBefore: undefined, freeBytesAfter: undefined },
  });
  const outcome = await apply.apply({ planId: stored.id, confirmed: true }, SIGNAL);

  assert.equal(outcome.kind, "applied");
  assert.equal(outcome.observedFreeSpaceChange, undefined);
});

// --- A plan built from a cleanup rule ---

test("a plan from a rule is applied when the rule in the file still hashes the same", async () => {
  const stored = plan({ providerId: "rules", findingId: "rules:old", ruleHash: "b".repeat(64) });
  const { service: apply, applied } = service(stored, {
    currentRuleHashes: () => new Set(["b".repeat(64)]),
  });

  const outcome = await apply.apply({ planId: stored.id, confirmed: true }, SIGNAL);

  assert.equal(outcome.kind, "applied");
  assert.equal(applied.length, 1);
});

test("a plan whose rule has been edited since it was reviewed is refused", async () => {
  const stored = plan({ providerId: "rules", findingId: "rules:old", ruleHash: "b".repeat(64) });
  const { service: apply, applied } = service(stored, {
    currentRuleHashes: () => new Set(["c".repeat(64)]),
  });

  const outcome = await apply.apply({ planId: stored.id, confirmed: true }, SIGNAL);

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-plan");
  assert.match(outcome.failure.message, /rule/i);
  assert.deepEqual(applied, [], "nothing was applied");
});

test("a plan whose rule has been removed from the file is refused", async () => {
  const stored = plan({ providerId: "rules", findingId: "rules:old", ruleHash: "b".repeat(64) });
  const { service: apply } = service(stored, { currentRuleHashes: () => new Set() });

  const outcome = await apply.apply({ planId: stored.id, confirmed: true }, SIGNAL);

  assert.equal(outcome.kind, "refused");
  assert.match(outcome.failure.message, /rule/i);
});

test("a plan that came from no rule is unaffected by what the rules now say", async () => {
  const stored = plan();
  const { service: apply, applied } = service(stored, {
    currentRuleHashes: () => new Set(["d".repeat(64)]),
  });

  const outcome = await apply.apply({ planId: stored.id, confirmed: true }, SIGNAL);

  assert.equal(outcome.kind, "applied");
  assert.equal(applied.length, 1);
});

test("a plan from a rule is applied when nothing can say what the rules are now", async () => {
  const stored = plan({ providerId: "rules", findingId: "rules:old", ruleHash: "b".repeat(64) });
  const { service: apply, applied } = service(stored);

  const outcome = await apply.apply({ planId: stored.id, confirmed: true }, SIGNAL);

  assert.equal(
    outcome.kind,
    "applied",
    "a caller that supplied no rules is a caller with no rules to contradict",
  );
  assert.equal(applied.length, 1);
});
