import type { Bytes, RawPath, ScanCompleteness } from "../domain/models.js";
import type { Accounting } from "./scan.js";

/** Bumped whenever a stored snapshot's shape changes; older files are ignored. */
export const SNAPSHOT_VERSION = 1;

/**
 * What a snapshot measured, and under which rules.
 *
 * Two snapshots are only comparable when every field here matches. A scan that
 * excluded a directory, counted apparent bytes, or crossed a mount is not
 * measuring the same thing as one that did not, and subtracting them would
 * report growth that never happened.
 */
export interface SnapshotScope {
  readonly roots: readonly RawPath[];
  readonly excludes: readonly RawPath[];
  readonly accounting: Accounting;
  readonly crossFilesystems: boolean;
  /** The filesystem identities the scan actually touched. */
  readonly filesystems: readonly string[];
}

/** One directory's subtree aggregate. Snapshots keep these, never every file. */
export interface DirectorySummary {
  readonly path: RawPath;
  readonly allocatedBytes: Bytes;
  readonly apparentBytes: Bytes;
  readonly entries: bigint;
}

export interface SnapshotTotals {
  readonly allocatedBytes: Bytes;
  readonly apparentBytes: Bytes;
  readonly sharedBytes: Bytes;
}

export interface SnapshotSummary {
  readonly version: typeof SNAPSHOT_VERSION;
  readonly id: string;
  readonly scanId: string;
  readonly scannedAt: string;
  readonly scope: SnapshotScope;
  readonly totals: SnapshotTotals;
  readonly completeness: ScanCompleteness;
  readonly directories: readonly DirectorySummary[];
}

export interface RetentionLimits {
  readonly keepLatest: number;
  readonly maxBytes?: bigint;
}

export interface SnapshotStore {
  save(snapshot: SnapshotSummary): Promise<void>;
  list(): Promise<readonly SnapshotSummary[]>;
  get(id: string): Promise<SnapshotSummary | undefined>;
  /** Drop snapshots beyond the retention limits, oldest first; returns how many went. */
  prune(limits: RetentionLimits): Promise<number>;
}
