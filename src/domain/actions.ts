import type { Bytes, RawPath } from "./models.js";

/** Reviewed operations are fixed before an apply request is accepted. */
export type ActionOperation =
  | "trash"
  | "permanent"
  | "move"
  | "compress"
  | "dedup-hardlink"
  | "manager";

export interface EntryFingerprint {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mountId: string;
  readonly kind: "file" | "directory" | "symlink";
  readonly apparentBytes: Bytes;
  readonly modifiedNanoseconds: bigint;
}

export interface PlannedEntry {
  readonly path: RawPath;
  readonly expected: EntryFingerprint;
}

export interface ActionPlan {
  readonly id: string;
  readonly operation: ActionOperation;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly providerId: string;
  readonly exactItemCount?: bigint;
  readonly estimatedBytes?: Bytes;
  readonly entries?: readonly PlannedEntry[];
  readonly warnings: readonly string[];
}

export interface ActionResult {
  readonly planId: string;
  readonly completed: bigint;
  readonly skipped: bigint;
  readonly failed: bigint;
  readonly selectedBytes?: Bytes;
  readonly bytesMovedToTrash?: Bytes;
  readonly observedFreeSpaceChange?: bigint;
  readonly journalId: string;
  readonly undoAvailable: boolean;
}
