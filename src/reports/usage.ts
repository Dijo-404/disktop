import type { Filesystem } from "../domain/models.js";
import { usedPercentOfInodes, usedPercentOfSpace } from "../domain/sizes.js";

export interface FilesystemUsage {
  /** The share `df` reports: root's reserve is left out of the denominator. */
  readonly usedPercent: number;
  /** Absent when the filesystem reports no inode counts; never zero in their place. */
  readonly inodesUsedPercent?: number;
}

/** The two percentages every format shows beside a filesystem, computed once. */
export function filesystemUsage(filesystem: Filesystem): FilesystemUsage {
  const usedPercent = usedPercentOfSpace(filesystem.totalBytes, filesystem.freeBytes, filesystem.availableBytes);
  if (filesystem.totalInodes === undefined || filesystem.freeInodes === undefined || filesystem.totalInodes === 0n) {
    return { usedPercent };
  }
  return { usedPercent, inodesUsedPercent: usedPercentOfInodes(filesystem.totalInodes, filesystem.freeInodes) };
}

/**
 * A nanosecond timestamp as an ISO instant, or undefined when it falls
 * outside what a date can represent. A timestamp before 1970 or beyond year
 * 275760 is real data on some filesystems; it is shown as absent, never
 * clamped into a date that did not happen.
 */
export function instantFromNanoseconds(nanoseconds: bigint): string | undefined {
  const milliseconds = nanoseconds / 1_000_000n;
  // Exactly zero is what a filesystem with no timestamp there reports (FAT's
  // root), and what the helper clamps a pre-1970 time to: no time recorded.
  if (nanoseconds <= 0n || milliseconds > 8_640_000_000_000_000n) {
    return undefined;
  }
  return new Date(Number(milliseconds)).toISOString();
}
