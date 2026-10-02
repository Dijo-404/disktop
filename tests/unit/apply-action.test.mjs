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
        async apply(reviewed, _signal, options) {
          applied.push(reviewed);
          applied.options = options;
          return overrides.result ?? { ...RESULT, planId: reviewed.id };
        },
        async restore() {
          throw new Error("not used here");
        },
      },
      now: () => overrides.now ?? NOW,
      ...(overrides.effectiveUserId === undefined ? {} : { effectiveUserId: overrides.effectiveUserId }),
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

// --- What an apply checked after the fact ---

test("an apply reports what it verified, with the free-space reading among it", async () => {
  const stored = plan();
  const { service: apply } = service(stored);

  const outcome = await apply.apply({ planId: stored.id, confirmed: true }, SIGNAL);

  assert.equal(outcome.kind, "applied");
  const reading = outcome.result.verification.find((check) => check.check === "free-space-read");
  assert.ok(reading, `verification was ${JSON.stringify(outcome.result.verification)}`);
  assert.equal(reading.outcome, "passed");
});

test("a check that could not run is unavailable, never passed", async () => {
  const stored = plan();
  const { service: apply } = service(stored, {
    result: { ...RESULT, planId: "", freeBytesBefore: undefined, freeBytesAfter: undefined },
  });

  const outcome = await apply.apply({ planId: stored.id, confirmed: true }, SIGNAL);

  const reading = outcome.result.verification.find((check) => check.check === "free-space-read");
  assert.equal(reading.outcome, "unavailable");
  assert.notEqual(reading.outcome, "passed");
});

test("an action that skipped or failed an item is verified as not having disposed of everything", async () => {
  const stored = plan();
  const { service: apply } = service(stored, {
    result: { ...RESULT, planId: "", completed: 0n, failed: 1n, state: "partial" },
  });

  const outcome = await apply.apply({ planId: stored.id, confirmed: true }, SIGNAL);

  const disposed = outcome.result.verification.find((check) => check.check === "source-disposed");
  assert.equal(disposed.outcome, "failed");
  assert.match(disposed.detail, /1/);
});

test("a failed verification makes the action partial at best, never complete", async () => {
  const stored = plan();
  const { service: apply } = service(stored, {
    result: { ...RESULT, planId: "", completed: 0n, failed: 1n, state: "complete" },
  });

  const outcome = await apply.apply({ planId: stored.id, confirmed: true }, SIGNAL);

  assert.notEqual(
    outcome.result.state,
    "complete",
    "a result that failed its own check does not get to call itself complete",
  );
});

test("a move's destination is among the checks, and a copy nobody could confirm is unavailable", async () => {
  const stored = plan({
    operation: "move",
    destination: rawPathFromUtf8("/mnt/archive"),
    sourceDisposition: "trash",
  });
  const { service: apply } = service(stored);

  const outcome = await apply.apply({ planId: stored.id, confirmed: true }, SIGNAL);

  const destination = outcome.result.verification.find(
    (check) => check.check === "destination-present",
  );
  assert.ok(destination, `verification was ${JSON.stringify(outcome.result.verification)}`);
  assert.match(destination.detail, /\/mnt\/archive/);
});

test("a plan that publishes nothing is not checked for a destination it never had", async () => {
  const stored = plan();
  const { service: apply } = service(stored);

  const outcome = await apply.apply({ planId: stored.id, confirmed: true }, SIGNAL);

  assert.equal(
    outcome.result.verification.some((check) => check.check === "destination-present"),
    false,
  );
});

test("a copy that arrived but whose source could not be dealt with is not reported as unpublished", async () => {
  const stored = plan({
    operation: "move",
    destination: rawPathFromUtf8("/mnt/archive"),
    sourceDisposition: "trash",
  });
  // The helper's own word for "the output arrived and was verified, but the
  // original is still there": uncertain, which counts as neither completed nor
  // skipped.
  const { service: apply } = service(stored, {
    result: { ...RESULT, planId: "", completed: 0n, skipped: 0n, failed: 1n, state: "partial" },
  });

  const outcome = await apply.apply({ planId: stored.id, confirmed: true }, SIGNAL);

  const destination = outcome.result.verification.find(
    (check) => check.check === "destination-present",
  );
  assert.notEqual(
    destination.detail,
    `Nothing was published into /mnt/archive, so there is nothing there to confirm.`,
    "a result must not say nothing was published when a verified copy is sitting there",
  );
  assert.equal(
    destination.outcome,
    "unavailable",
    "Disktop did not look at the destination, so it says it could not tell",
  );
});

test("an unconfirmed move to Trash is not described as a permanent removal", async () => {
  const stored = plan({
    operation: "move",
    destination: rawPathFromUtf8("/mnt/archive"),
    sourceDisposition: "trash",
  });
  const { service: apply } = service(stored);

  const outcome = await apply.apply({ planId: stored.id, confirmed: false }, SIGNAL);

  assert.equal(outcome.kind, "refused");
  assert.doesNotMatch(
    outcome.failure.message,
    /permanently/i,
    "a confirmation prompt that misdescribes what it would do is worse than none",
  );
  assert.match(outcome.failure.message, /copy|move|another disk/i);
});

test("a move that trashes its source carries the note that Trash frees nothing yet", async () => {
  const stored = plan({
    operation: "move",
    destination: rawPathFromUtf8("/mnt/archive"),
    sourceDisposition: "trash",
  });
  const { service: apply } = service(stored);

  const outcome = await apply.apply({ planId: stored.id, confirmed: true }, SIGNAL);

  assert.equal(outcome.kind, "applied");
  assert.ok(
    outcome.notes.some((note) => /Trash/i.test(note)),
    `notes were ${JSON.stringify(outcome.notes)}`,
  );
});

async function managerPlan() {
  const { managerScope } = await import("../../dist/domain/managers.js");
  return buildPlan({
    operation: "manager",
    providerId: "managers",
    findingId: "managers:docker.prune-build-cache",
    scopeSummary: "Docker build cache",
    createdAt: NOW,
    expiryMinutes: 60,
    entries: [],
    manager: managerScope({ action: "docker.prune-build-cache", items: [], parameters: {}, count: { kind: "unknown" }, preview: "none" }),
    warnings: [],
  });
}

const MANAGER_RESULT = {
  planId: "",
  completed: 0n,
  skipped: 0n,
  failed: 0n,
  bytesMovedToTrash: 0n,
  freeBytesBefore: 1000n,
  freeBytesAfter: 5000n,
  state: "complete",
  journalId: "act-1",
  undoAvailable: false,
  verification: [
    { check: "manager-verified", outcome: "passed", detail: "Build cache listed again." },
    { check: "manager-command", outcome: "passed", detail: "All 1 command(s) finished with status 0." },
  ],
};

test("a manager plan is irreversible and needs --permanent", async () => {
  const reviewed = await managerPlan();
  const { service: apply, applied } = service(reviewed, { result: MANAGER_RESULT });
  const refused = await apply.apply({ planId: reviewed.id, confirmed: true }, SIGNAL);
  assert.equal(refused.kind, "refused");
  assert.match(refused.failure.message, /--permanent/);
  assert.equal(applied.length, 0);
});

test("a manager plan's prompt says what runs, not that files are removed", async () => {
  const reviewed = await managerPlan();
  const { service: apply } = service(reviewed, { result: MANAGER_RESULT });
  const refused = await apply.apply({ planId: reviewed.id, confirmed: false }, SIGNAL);
  assert.match(refused.failure.message, /docker builder prune --force/);
});

test("whether somebody can answer a password prompt reaches the action port", async () => {
  const reviewed = await managerPlan();
  const { service: apply, applied } = service(reviewed, { result: MANAGER_RESULT });
  await apply.apply({ planId: reviewed.id, confirmed: true, acknowledgePermanent: true, interactive: true }, SIGNAL);
  assert.equal(applied.options.interactive, true);
});

test("a manager result keeps the executor's checks and adds the free-space reading", async () => {
  const reviewed = await managerPlan();
  const { service: apply } = service(reviewed, { result: MANAGER_RESULT });
  const outcome = await apply.apply({ planId: reviewed.id, confirmed: true, acknowledgePermanent: true }, SIGNAL);
  assert.equal(outcome.kind, "applied");
  const checks = outcome.result.verification.map((check) => check.check);
  assert.deepEqual(checks, ["manager-verified", "manager-command", "free-space-read"]);
  assert.equal(outcome.result.state, "complete");
  assert.equal(outcome.observedFreeSpaceChange, 4000n);
  assert.ok(outcome.notes.some((note) => /estimate/i.test(note)));
});

test("a manager result whose command failed is not complete", async () => {
  const reviewed = await managerPlan();
  const failed = {
    ...MANAGER_RESULT,
    verification: [{ check: "manager-command", outcome: "failed", detail: "docker exited with status 1." }],
  };
  const { service: apply } = service(reviewed, { result: failed });
  const outcome = await apply.apply({ planId: reviewed.id, confirmed: true, acknowledgePermanent: true }, SIGNAL);
  assert.equal(outcome.result.state, "partial");
});

test("as root, a stored Trash plan is refused and a manager plan still runs", async () => {
  const trash = plan();
  const asRoot = service(trash, { effectiveUserId: 0 });
  const refused = await asRoot.service.apply({ planId: trash.id, confirmed: true }, SIGNAL);
  assert.equal(refused.kind, "refused");
  assert.equal(refused.failure.code, "permission-denied");
  assert.equal(asRoot.applied.length, 0);

  const manager = await managerPlan();
  const managed = service(manager, { effectiveUserId: 0, result: MANAGER_RESULT });
  const applied = await managed.service.apply({ planId: manager.id, confirmed: true, acknowledgePermanent: true }, SIGNAL);
  assert.equal(applied.kind, "applied");
});
