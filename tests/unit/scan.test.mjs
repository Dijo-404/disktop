import assert from "node:assert/strict";
import { test } from "node:test";
import { createScanService, orderedWarnings } from "../../dist/application/scan.js";
import { createExploreService, boundedLimit, olderThanNanoseconds, parseSize } from "../../dist/application/explore.js";
import { CapabilityUnavailable } from "../../dist/domain/errors.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";

const SETTINGS = { crossFilesystems: false, accounting: "allocated", excludes: [] };
const ROOT = rawPathFromUtf8("/home/example");

function scannerEmitting(events) {
  return {
    // eslint-disable-next-line require-yield
    async *run() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function completeEvent(overrides = {}) {
  return {
    kind: "complete",
    scanId: "scan-1",
    accounting: "allocated",
    roots: [ROOT],
    completeness: { complete: true, scannedEntries: 3n, inaccessibleDirectories: 0n, excludedMounts: [], warnings: [] },
    totals: { allocatedBytes: 8192n, apparentBytes: 4096n, sharedBytes: 0n },
    ...overrides,
  };
}

test("a scan hands progress to the caller as it arrives and returns the summary", async () => {
  const seen = [];
  const service = createScanService(
    scannerEmitting([
      { kind: "progress", scannedEntries: 10n, processedBytes: 1024n, inaccessibleDirectories: 0n },
      { kind: "progress", scannedEntries: 20n, processedBytes: 2048n, inaccessibleDirectories: 1n },
      completeEvent(),
    ]),
    SETTINGS,
  );

  const outcome = await service.run([ROOT], new AbortController().signal, (progress) => seen.push(progress.scannedEntries));

  assert.equal(outcome.kind, "scanned");
  assert.equal(outcome.summary.scanId, "scan-1");
  assert.equal(outcome.summary.totals.allocatedBytes, 8192n);
  assert.deepEqual(seen, [10n, 20n]);
});

test("a partial scan still returns a summary that says it is partial", async () => {
  const service = createScanService(
    scannerEmitting([
      completeEvent({
        completeness: {
          complete: false,
          scannedEntries: 2n,
          inaccessibleDirectories: 1n,
          excludedMounts: [],
          warnings: [{ code: "inaccessible-directory", message: "Permission denied." }],
        },
      }),
    ]),
    SETTINGS,
  );

  const outcome = await service.run([ROOT], new AbortController().signal);

  assert.equal(outcome.kind, "scanned");
  assert.equal(outcome.summary.completeness.complete, false);
  assert.equal(outcome.summary.completeness.warnings.length, 1);
});

test("a stream that ends without a completion is a fault, not an empty scan", async () => {
  const service = createScanService(scannerEmitting([{ kind: "progress", scannedEntries: 1n, processedBytes: 0n, inaccessibleDirectories: 0n }]), SETTINGS);
  await assert.rejects(() => service.run([ROOT], new AbortController().signal), /without a result/);
});

test("a missing capability is reported as one rather than raised at the surface", async () => {
  const capability = { status: "unsupported-kernel", explanation: "openat2 is unavailable." };
  const service = createScanService(
    {
      // eslint-disable-next-line require-yield
      async *run() {
        throw new CapabilityUnavailable(capability);
      },
    },
    SETTINGS,
  );

  const outcome = await service.run([ROOT], new AbortController().signal);

  assert.equal(outcome.kind, "unavailable");
  assert.deepEqual(outcome.capability, capability);
});

test("a scan needs a root", async () => {
  const service = createScanService(scannerEmitting([]), SETTINGS);
  await assert.rejects(() => service.run([], new AbortController().signal), RangeError);
});

test("cancellation and denied directories are the warnings shown first", () => {
  const ordered = orderedWarnings({
    complete: false,
    scannedEntries: 0n,
    inaccessibleDirectories: 1n,
    excludedMounts: [],
    warnings: [
      { code: "symlink-not-followed", message: "" },
      { code: "inaccessible-directory", message: "" },
      { code: "cancelled", message: "" },
    ],
  });
  assert.deepEqual(ordered.map((warning) => warning.code), ["cancelled", "inaccessible-directory", "symlink-not-followed"]);
});

test("explore asks the index for one bounded page with defaults filled in", async () => {
  const asked = [];
  const service = createExploreService({
    async query(query) {
      asked.push(query);
      return { entries: [], nextCursor: "abcd" };
    },
  });

  const outcome = await service.page({ scanId: "scan-1" });

  assert.equal(outcome.kind, "page");
  assert.equal(outcome.page.nextCursor, "abcd");
  assert.equal(asked[0].sort, "allocated");
  assert.equal(asked[0].order, "descending");
  assert.equal(asked[0].limit, 50);
});

test("a page size is clamped to what the contract allows", () => {
  assert.equal(boundedLimit(undefined), 50);
  assert.equal(boundedLimit(0), 1);
  assert.equal(boundedLimit(-4), 1);
  assert.equal(boundedLimit(10_000), 1000);
  assert.equal(boundedLimit(7.9), 7);
  assert.equal(boundedLimit(Number.NaN), 50);
});

test("sizes parse in both unit bases and stay exact above 2^53", () => {
  assert.equal(parseSize("4096"), 4096n);
  assert.equal(parseSize("1GiB"), 1073741824n);
  assert.equal(parseSize("1GB"), 1000000000n);
  assert.equal(parseSize("500 MB"), 500000000n);
  assert.equal(parseSize("16EiB"), 18446744073709551616n);
  assert.equal(parseSize("1kib"), 1024n);
  assert.equal(parseSize("big"), undefined);
  assert.equal(parseSize("-1"), undefined);
  assert.equal(parseSize("1.5GiB"), undefined);
});

test("an age threshold becomes a nanosecond timestamp and never goes negative", () => {
  const now = new Date("2026-09-30T00:00:00.000Z");
  assert.equal(olderThanNanoseconds(now, 1), BigInt(now.getTime() - 86_400_000) * 1_000_000n);
  assert.equal(olderThanNanoseconds(new Date(0), 30), 0n);
  assert.throws(() => olderThanNanoseconds(now, -1), RangeError);
});
