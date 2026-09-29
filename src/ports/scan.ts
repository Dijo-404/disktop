import type { IndexedEntry, RawPath, ScanCompleteness, Warning } from "../domain/models.js";

export interface ScanRequest {
  readonly roots: readonly RawPath[];
  readonly crossFilesystems: boolean;
  readonly excludes: readonly RawPath[];
  readonly accounting: "allocated" | "apparent";
  readonly throttleBytesPerSecond?: bigint;
}

export type ScanEvent =
  | { readonly kind: "progress"; readonly scannedEntries: bigint }
  | { readonly kind: "warning"; readonly warning: Warning }
  | { readonly kind: "complete"; readonly scanId: string; readonly completeness: ScanCompleteness };

export interface ScanPort {
  run(request: ScanRequest, signal: AbortSignal): AsyncIterable<ScanEvent>;
}

export interface EntryFilter {
  readonly nameContains?: string;
  readonly extension?: string;
  readonly minBytes?: bigint;
  readonly maxBytes?: bigint;
  readonly olderThan?: string;
  readonly ownerId?: bigint;
}

export interface EntryPage {
  readonly entries: readonly IndexedEntry[];
  readonly nextCursor?: string;
}

export interface FileIndexPort {
  query(scanId: string, filter: EntryFilter, cursor?: string): Promise<EntryPage>;
}
