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

/**
 * The used share `df` reports: blocks reserved for root are left out of the
 * denominator, because they are not space this user can reclaim. Rounded down,
 * so the number never overstates how full a filesystem is and a threshold is
 * only crossed once it has genuinely been crossed.
 */
export function usedPercentOfSpace(totalBytes: bigint, freeBytes: bigint, availableBytes: bigint): number {
  const used = totalBytes > freeBytes ? totalBytes - freeBytes : 0n;
  return percent(used, used + availableBytes);
}

/** Inodes have no reserved-versus-available distinction, so the total is the denominator. */
export function usedPercentOfInodes(totalInodes: bigint, freeInodes: bigint): number {
  const used = totalInodes > freeInodes ? totalInodes - freeInodes : 0n;
  return percent(used, totalInodes);
}

function percent(used: bigint, whole: bigint): number {
  if (whole <= 0n) {
    return 0;
  }
  const value = (used * 100n) / whole;
  return value > 100n ? 100 : Number(value);
}

const IEC_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"] as const;
const SI_UNITS = ["B", "kB", "MB", "GB", "TB", "PB", "EB"] as const;

/**
 * Human-readable text for a byte count. The underlying value is unchanged; this
 * is display only, and an exact figure stays available as a decimal string.
 */
export function formatBytes(value: bigint, units: "iec" | "si"): string {
  const base = units === "iec" ? 1024n : 1000n;
  const names = units === "iec" ? IEC_UNITS : SI_UNITS;
  const negative = value < 0n;
  let magnitude = negative ? -value : value;

  let index = 0;
  let remainder = 0n;
  while (magnitude >= base && index < names.length - 1) {
    remainder = magnitude % base;
    magnitude /= base;
    index += 1;
  }

  const sign = negative ? "-" : "";
  if (index === 0) {
    return `${sign}${magnitude} ${names[0]}`;
  }
  // One decimal place, truncated rather than rounded, so a size never reads larger than it is.
  const tenths = (remainder * 10n) / base;
  return `${sign}${magnitude}.${tenths} ${names[index]}`;
}
