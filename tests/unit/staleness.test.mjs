import assert from "node:assert/strict";
import { test } from "node:test";
import { accessTimeConfidence, staleBeforeNanoseconds, stalenessBasis } from "../../dist/domain/staleness.js";

test("noatime means the kernel does not maintain an access time at all", () => {
  assert.equal(accessTimeConfidence(["rw", "noatime"]), "absent");
});

test("relatime means the access time is only coarsely maintained", () => {
  assert.equal(accessTimeConfidence(["rw", "relatime"]), "coarse");
});

test("nodiratime alone still leaves file access times maintained", () => {
  assert.equal(accessTimeConfidence(["rw", "nodiratime"]), "maintained");
});

test("strictatime is the case where an access time would mean what it says", () => {
  assert.equal(accessTimeConfidence(["rw", "strictatime"]), "maintained");
});

test("options that say nothing about atime leave it maintained", () => {
  assert.equal(accessTimeConfidence(["rw", "nosuid", "nodev"]), "maintained");
});

test("options nobody could read are unknown, never assumed to be maintained", () => {
  assert.equal(stalenessBasis(undefined).confidence, "unknown");
});

test("every basis measures the modification time, whatever the mount says about atime", () => {
  for (const options of [["noatime"], ["relatime"], ["strictatime"], undefined]) {
    const basis = stalenessBasis(options);
    assert.equal(basis.field, "modified", JSON.stringify(options));
  }
});

test("no label ever claims to know when a file was last opened", () => {
  for (const options of [["noatime"], ["relatime"], ["strictatime"], ["rw"], undefined]) {
    const basis = stalenessBasis(options);
    assert.doesNotMatch(basis.label, /not opened|last opened|accessed/i, JSON.stringify(options));
    assert.match(basis.label, /not modified since/i, JSON.stringify(options));
  }
});

test("a mount that keeps no access time says so, so a reader knows why mtime was used", () => {
  const basis = stalenessBasis(["noatime"]);

  assert.equal(basis.confidence, "absent");
  assert.match(basis.label, /noatime/);
});

test("a relatime mount names relatime rather than implying a precise reading", () => {
  const basis = stalenessBasis(["rw", "relatime"]);

  assert.equal(basis.confidence, "coarse");
  assert.match(basis.label, /relatime/);
});

test("noatime wins over relatime when a mount somehow reports both", () => {
  assert.equal(accessTimeConfidence(["relatime", "noatime"]), "absent");
});

test("an empty option list is a reading that happened and found nothing special", () => {
  assert.equal(accessTimeConfidence([]), "maintained");
  assert.equal(stalenessBasis([]).confidence, "maintained");
});

test("a cutoff is the threshold in days before now, in nanoseconds", () => {
  const now = new Date("2026-10-02T00:00:00.000Z");

  const cutoff = staleBeforeNanoseconds(now, 1);

  assert.equal(cutoff, BigInt(Date.parse("2026-10-01T00:00:00.000Z")) * 1_000_000n);
});

test("a cutoff is a bigint of nanoseconds, so it survives the helper's integer range", () => {
  const cutoff = staleBeforeNanoseconds(new Date("2026-10-02T00:00:00.000Z"), 183);

  assert.equal(typeof cutoff, "bigint");
  assert.ok(cutoff > 1_700_000_000_000_000_000n, `${cutoff} is not a plausible nanosecond clock`);
});

test("a threshold reaching past the epoch clamps to zero rather than going negative", () => {
  const cutoff = staleBeforeNanoseconds(new Date("1970-01-02T00:00:00.000Z"), 3650);

  assert.equal(cutoff, 0n);
});

test("a threshold that is not a whole number of days above zero is a programming error", () => {
  for (const days of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => staleBeforeNanoseconds(new Date(), days), RangeError, String(days));
  }
});
