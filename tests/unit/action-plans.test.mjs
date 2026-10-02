import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPlan,
  isExpired,
  newPlanId,
  requiresAcknowledgement,
} from "../../dist/domain/actions.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";

const NOW = new Date("2026-10-01T09:00:00.000Z");

function entry(path = "/home/example/.cache/pip") {
  return {
    path: rawPathFromUtf8(path),
    expected: {
      device: 66306n,
      inode: 1179651n,
      mountId: "29",
      kind: "directory",
      apparentBytes: 4096n,
      modifiedNanoseconds: 1758000000123456789n,
    },
    reviewedBytes: 41943040n,
  };
}

function input(overrides = {}) {
  return {
    operation: "trash",
    providerId: "cache.language",
    findingId: "cache.language:pip",
    scopeSummary: "1 directory under ~/.cache",
    createdAt: NOW,
    expiryMinutes: 60,
    entries: [entry()],
    warnings: [],
    ...overrides,
  };
}

test("a plan id survives the helper's own identifier rule", () => {
  const id = newPlanId(NOW, () => "9f2c1ab07d4e5610");
  assert.match(id, /^[A-Za-z0-9._-]{8,128}$/);
  assert.notEqual(newPlanId(NOW, () => "0000000000000001"), id);
});

test("a plan expires at the moment it says it does, not a moment before", () => {
  const plan = buildPlan(input());
  assert.equal(plan.expiresAt, "2026-10-01T10:00:00.000Z");
  assert.equal(isExpired(plan, new Date("2026-10-01T09:59:59.999Z")), false);
  assert.equal(isExpired(plan, new Date("2026-10-01T10:00:00.000Z")), true);
});

test("a plan fixes its operation at review time and carries its own reversibility", () => {
  const trash = buildPlan(input());
  assert.equal(trash.operation, "trash");
  assert.equal(trash.reversibility, "undo-from-trash");
  assert.equal(requiresAcknowledgement(trash), false);

  const permanent = buildPlan(input({ operation: "permanent" }));
  assert.equal(permanent.reversibility, "irreversible");
  assert.equal(requiresAcknowledgement(permanent), true);
});

test("a plan totals the bytes its entries were reviewed at", () => {
  const plan = buildPlan(input({ entries: [entry("/home/example/a"), entry("/home/example/b")] }));
  assert.equal(plan.selectedBytes, 83886080n);
  assert.equal(plan.exactItemCount, 2n);
});

test("a plan with nothing in it is refused rather than stored", () => {
  assert.throws(() => buildPlan(input({ entries: [] })), /at least one/i);
});

test("a plan that only a manager could carry out needs no entries but needs a scope", () => {
  const plan = buildPlan(
    input({ operation: "manager", entries: [], managerScope: "flatpak uninstall --unused" }),
  );
  assert.equal(plan.managerScope, "flatpak uninstall --unused");
  assert.equal(plan.exactItemCount, undefined, "a manager cannot promise an exact count");
  assert.equal(plan.permission, "manager-privilege");
});

test("an irreversible plan always carries the warning that says so", () => {
  const plan = buildPlan(input({ operation: "permanent" }));
  assert.ok(
    plan.warnings.some((warning) => /cannot be undone/i.test(warning)),
    `warnings were ${JSON.stringify(plan.warnings)}`,
  );
});

// --- Phase 5: plans that carry a destination and a source disposition ---

function movable(overrides = {}) {
  return {
    operation: "move",
    providerId: "explicit-path",
    scopeSummary: "1 directory",
    createdAt: new Date("2026-10-02T09:00:00.000Z"),
    expiryMinutes: 60,
    entries: [entry()],
    warnings: [],
    destination: rawPathFromUtf8("/mnt/archive"),
    sourceDisposition: "trash",
    ...overrides,
  };
}

test("a move plan carries where it publishes and what becomes of the source", () => {
  const plan = buildPlan(movable());

  assert.equal(plan.destination.display, "/mnt/archive");
  assert.equal(plan.sourceDisposition, "trash");
});

test("a move without a destination is refused: apply time cannot choose one", () => {
  assert.throws(() => buildPlan(movable({ destination: undefined })), RangeError);
});

test("a move without a source disposition is refused", () => {
  assert.throws(() => buildPlan(movable({ sourceDisposition: undefined })), RangeError);
});

test("a compress plan needs both as well", () => {
  const plan = buildPlan(movable({ operation: "compress" }));
  assert.equal(plan.sourceDisposition, "trash");
  assert.throws(() => buildPlan(movable({ operation: "compress", destination: undefined })), RangeError);
});

test("an operation that publishes nothing may not carry a destination", () => {
  assert.throws(() => buildPlan(movable({ operation: "trash" })), RangeError);
  assert.throws(
    () =>
      buildPlan(
        movable({
          operation: "dedup-hardlink",
          destination: undefined,
          entries: [entry("/home/example/a.bin"), entry("/home/example/b.bin")],
        }),
      ),
    RangeError,
  );
});

test("a move that trashes its source can be undone; one that erases it cannot", () => {
  assert.equal(buildPlan(movable()).reversibility, "undo-from-trash");

  const permanent = buildPlan(movable({ sourceDisposition: "permanent" }));
  assert.equal(permanent.reversibility, "irreversible");
  assert.ok(
    permanent.warnings.some((warning) => /cannot be undone/i.test(warning)),
    `warnings were ${JSON.stringify(permanent.warnings)}`,
  );
});

test("a compress that erases its source is irreversible for the same reason", () => {
  const plan = buildPlan(movable({ operation: "compress", sourceDisposition: "permanent" }));
  assert.equal(plan.reversibility, "irreversible");
});

test("replacing a duplicate with a hardlink stays irreversible whatever else is asked", () => {
  const plan = buildPlan(
    movable({
      operation: "dedup-hardlink",
      destination: undefined,
      sourceDisposition: undefined,
      entries: [entry("/home/example/a.bin"), entry("/home/example/b.bin")],
      keepPath: rawPathFromUtf8("/home/example/a.bin"),
    }),
  );

  assert.equal(plan.reversibility, "irreversible");
  assert.equal(plan.destination, undefined);
  assert.equal(plan.sourceDisposition, undefined);
});

test("a hardlink plan needs at least two entries: there is nothing to link one file to", () => {
  assert.throws(
    () =>
      buildPlan(
        movable({
          operation: "dedup-hardlink",
          destination: undefined,
          sourceDisposition: undefined,
          entries: [],
        }),
      ),
    RangeError,
  );
});

test("a hardlink plan names the copy that is kept, and it is one of the plan's own entries", () => {
  const keep = entry("/home/example/a.bin");
  const plan = buildPlan(
    movable({
      operation: "dedup-hardlink",
      destination: undefined,
      sourceDisposition: undefined,
      entries: [keep, entry("/home/example/b.bin")],
      keepPath: keep.path,
    }),
  );

  assert.equal(plan.keepPath.display, "/home/example/a.bin");
});

test("a hardlink plan without a kept copy is refused rather than picking one", () => {
  assert.throws(
    () =>
      buildPlan(
        movable({
          operation: "dedup-hardlink",
          destination: undefined,
          sourceDisposition: undefined,
          entries: [entry("/home/example/a.bin"), entry("/home/example/b.bin")],
        }),
      ),
    RangeError,
  );
});

test("a kept copy that is not one of the plan's entries is refused", () => {
  assert.throws(
    () =>
      buildPlan(
        movable({
          operation: "dedup-hardlink",
          destination: undefined,
          sourceDisposition: undefined,
          entries: [entry("/home/example/a.bin"), entry("/home/example/b.bin")],
          keepPath: rawPathFromUtf8("/home/example/somewhere-else.bin"),
        }),
      ),
    RangeError,
  );
});

test("an operation that keeps nothing may not name a kept copy", () => {
  assert.throws(
    () => buildPlan(movable({ operation: "trash", destination: undefined, sourceDisposition: undefined, keepPath: rawPathFromUtf8("/home/example/a.bin") })),
    RangeError,
  );
});

test("a plan built from a rule carries the rule's hash", () => {
  const plan = buildPlan({
    operation: "trash",
    providerId: "rules",
    findingId: "rules:old-downloads",
    scopeSummary: "2 entries",
    createdAt: new Date("2026-10-02T09:00:00.000Z"),
    expiryMinutes: 60,
    entries: [entry("/home/example/Downloads/a.iso")],
    warnings: [],
    ruleHash: "a".repeat(64),
  });

  assert.equal(plan.ruleHash, "a".repeat(64));
});

test("a rule hash that is not a hash is refused rather than stored", () => {
  assert.throws(
    () =>
      buildPlan({
        operation: "trash",
        providerId: "rules",
        scopeSummary: "1 entry",
        createdAt: new Date("2026-10-02T09:00:00.000Z"),
        expiryMinutes: 60,
        entries: [entry()],
        warnings: [],
        ruleHash: "not-a-hash",
      }),
    RangeError,
  );
});

test("a plan whose expiry is not a date counts as expired", () => {
  const stored = { ...buildPlan(input()), expiresAt: "never" };
  assert.equal(isExpired(stored, new Date("2026-10-01T09:00:00.000Z")), true);
});
