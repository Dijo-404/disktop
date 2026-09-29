import type { ScanCompleteness } from "../domain/models.js";

export interface SnapshotSummary {
  readonly id: string;
  readonly scannedAt: string;
  readonly rootIds: readonly string[];
  readonly allocatedBytes: bigint;
  readonly apparentBytes: bigint;
  readonly completeness: ScanCompleteness;
}

export interface SnapshotStore {
  save(snapshot: SnapshotSummary): Promise<void>;
  list(): Promise<readonly SnapshotSummary[]>;
  get(id: string): Promise<SnapshotSummary | undefined>;
  prune(keepLatest: number): Promise<bigint>;
}
