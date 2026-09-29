import assert from "node:assert/strict";
import { test } from "node:test";
import { allocatedBytesFromBlocks, decimalBytes, formatBytes, parseDecimalBytes } from "../../dist/domain/sizes.js";

test("allocated size uses 512 byte Linux st_blocks units", () => {
  assert.equal(allocatedBytesFromBlocks(3n), 1536n);
  assert.equal(allocatedBytesFromBlocks(0n), 0n);
  assert.throws(() => allocatedBytesFromBlocks(-1n), RangeError);
});

test("decimal transport preserves integers beyond Number.MAX_SAFE_INTEGER", () => {
  const value = 18_446_744_073_709_551_615n;
  assert.equal(parseDecimalBytes(decimalBytes(value)), value);
  for (const invalid of ["-1", "+1", "01", "1.0", "1e6", "", " 1 "]) {
    assert.throws(() => parseDecimalBytes(invalid), RangeError);
  }
});

test("human-readable sizes are truncated, so a size never reads larger than it is", () => {
  assert.equal(formatBytes(0n, "iec"), "0 B");
  assert.equal(formatBytes(1023n, "iec"), "1023 B");
  assert.equal(formatBytes(1024n, "iec"), "1.0 KiB");
  // 1.99 GiB must not read as 2.0 GiB.
  assert.equal(formatBytes(2_147_000_000n, "iec"), "1.9 GiB");
  assert.equal(formatBytes(1_000_000_000n, "si"), "1.0 GB");
  assert.equal(formatBytes(1_000_000_000n, "iec"), "953.6 MiB");
});

test("a size beyond any practical disk still formats without losing its magnitude", () => {
  assert.equal(formatBytes(18_446_744_073_709_551_615n, "iec"), "15.9 EiB");
});

test("an observed free-space change can be negative and says so", () => {
  assert.equal(formatBytes(-1536n, "iec"), "-1.5 KiB");
});
