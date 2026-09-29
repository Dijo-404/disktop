import assert from "node:assert/strict";
import { test } from "node:test";
import { allocatedBytesFromBlocks, decimalBytes, parseDecimalBytes } from "../../dist/domain/sizes.js";

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
