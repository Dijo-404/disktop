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
