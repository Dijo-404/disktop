/** Linux st_blocks units are 512 bytes, regardless of filesystem block size. */
export function allocatedBytesFromBlocks(blocks: bigint): bigint {
  if (blocks < 0n) {
    throw new RangeError("Allocated block count cannot be negative");
  }
  return blocks * 512n;
}

/** Keep exact byte values in memory and serialize them as decimal strings. */
export function decimalBytes(value: bigint): string {
  if (value < 0n) {
    throw new RangeError("Byte count cannot be negative");
  }
  return value.toString(10);
}

export function parseDecimalBytes(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new RangeError("Expected a non-negative decimal byte count");
  }
  return BigInt(value);
}
