import type { Bytes, IndexedEntry, RawPath, ScanCompleteness, Warning } from "../domain/models.js";

export type Accounting = "allocated" | "apparent";

export interface ScanRequest {
  readonly roots: readonly RawPath[];
  readonly crossFilesystems: boolean;
  readonly excludes: readonly RawPath[];
  readonly accounting: Accounting;
  readonly throttleBytesPerSecond?: bigint;
  readonly maxDepth?: bigint;
}

/**
 * What a finished or partial scan measured.
 *
 * `sharedBytes` are the bytes reached through a second hardlink to an inode
 * already counted; they are reported separately rather than added, because
 * removing one of those paths frees nothing.
 */
export interface ScanTotals {
  readonly allocatedBytes: Bytes;
  readonly apparentBytes: Bytes;
  /** In the same unit as the totals above, so the two can be compared. */
  readonly sharedBytes: Bytes;
}

export type ScanEvent =
  | {
      readonly kind: "progress";
      readonly scannedEntries: bigint;
      readonly processedBytes: bigint;
      readonly inaccessibleDirectories: bigint;
      readonly currentPath?: RawPath;
    }
  | { readonly kind: "warning"; readonly warning: Warning }
  | {
      readonly kind: "complete";
      readonly scanId: string;
      readonly accounting: Accounting;
      readonly roots: readonly RawPath[];
      readonly completeness: ScanCompleteness;
      readonly totals: ScanTotals;
      /** The filesystems the walk actually read, as the helper observed them. */
      readonly filesystems: readonly string[];
    };

export interface ScanPort {
  run(request: ScanRequest, signal: AbortSignal): AsyncIterable<ScanEvent>;
}

export type EntryKindFilter = IndexedEntry["kind"];

export interface EntryFilter {
  /** Restrict the page to this path and everything below it. */
  readonly underPath?: RawPath;
  readonly parentId?: string;
  readonly nameContains?: string;
  readonly extension?: string;
  readonly minAllocatedBytes?: bigint;
  readonly maxAllocatedBytes?: bigint;
  readonly modifiedBeforeNanoseconds?: bigint;
  readonly ownerId?: bigint;
  readonly kinds?: readonly EntryKindFilter[];
}

export type EntrySort = "allocated" | "apparent" | "modified" | "name";
export type SortOrder = "ascending" | "descending";

/** One page. There is no request shape that asks the index for a whole tree. */
export interface EntryQuery {
  readonly scanId: string;
  readonly filter: EntryFilter;
  readonly sort: EntrySort;
  readonly order: SortOrder;
  readonly limit: number;
  readonly cursor?: string;
  readonly includeTypeTotals?: boolean;
  readonly includeOwnerTotals?: boolean;
}

export interface TypeTotal {
  readonly extension: string;
  readonly entries: bigint;
  readonly allocatedBytes: Bytes;
  readonly apparentBytes: Bytes;
}

/** Bytes per owning user id, over regular files only. */
export interface OwnerTotal {
  readonly ownerId: bigint;
  readonly entries: bigint;
  readonly allocatedBytes: Bytes;
  readonly apparentBytes: Bytes;
}

export interface EntryPage {
  readonly entries: readonly IndexedEntry[];
  readonly nextCursor?: string;
  readonly typeTotals?: readonly TypeTotal[];
  readonly ownerTotals?: readonly OwnerTotal[];
}

export interface FileIndexPort {
  query(query: EntryQuery): Promise<EntryPage>;
}
