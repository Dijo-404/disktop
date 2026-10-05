import type { Bytes, RawPath } from "../domain/models.js";
import type { EntrySort, FileIndexPort } from "../ports/scan.js";
import {
  SNAPSHOT_VERSION,
  type DirectorySummary,
  type RetentionLimits,
  type SnapshotScope,
  type SnapshotStore,
  type SnapshotSummary,
} from "../ports/snapshots.js";
import type { ScanSummary } from "./scan.js";

/** How many directory aggregates one snapshot keeps. */
export const SNAPSHOT_DIRECTORIES = 200;

/** Everything about a scan's scope that the scan itself does not report. */
export interface RecordedScope {
  readonly excludes: readonly RawPath[];
}

export interface SnapshotService {
  record(summary: ScanSummary, scope: RecordedScope, now: Date): Promise<SnapshotSummary>;
  list(): Promise<readonly SnapshotSummary[]>;
  /** The newest snapshot whose scope matches, for continuing work on one scan. */
  latestFor(scope: SnapshotScope): Promise<SnapshotSummary | undefined>;
  diff(earlier: string, later: string): Promise<DiffOutcome>;
  prune(limits: RetentionLimits): Promise<number>;
}

export type DiffOutcome =
  | { readonly kind: "diff"; readonly diff: SnapshotDiff }
  | { readonly kind: "missing"; readonly id: string }
  | { readonly kind: "incomparable"; readonly reasons: readonly string[] };

export type ChangeKind = "grew" | "shrank" | "added" | "removed" | "unchanged";

export interface DirectoryChange {
  readonly path: RawPath;
  readonly kind: ChangeKind;
  readonly earlierBytes: Bytes;
  readonly laterBytes: Bytes;
  /** Signed, so a caller never has to infer direction from the two totals. */
  readonly deltaBytes: bigint;
}

export interface SnapshotDiff {
  readonly earlier: SnapshotSummary;
  readonly later: SnapshotSummary;
  readonly totalDeltaBytes: bigint;
  readonly directories: readonly DirectoryChange[];
  /**
   * True when either side was partial. The numbers are still the ones that
   * were measured; what is uncertain is whether a change is real or is a
   * subtree one scan could see and the other could not.
   */
  readonly uncertain: boolean;
  readonly uncertainty: readonly string[];
}

/**
 * Growth history over compact snapshots.
 *
 * Two snapshots are compared only when they measured the same thing under the
 * same rules. Anything else is refused with the reasons, because a diff
 * between different scopes reads exactly like real growth and there is no way
 * for the person looking at it to tell.
 */
export function createSnapshotService(store: SnapshotStore, index: FileIndexPort): SnapshotService {
  return {
    async record(summary, scope, now) {
      // Rank and store the directories by the column the scan measured. Under
      // apparent accounting the allocated-largest directories are a different
      // set, and a sparse file that grew by gigabytes would not be among them.
      const directories = await topDirectories(index, summary.scanId, summary.accounting);
      const snapshot: SnapshotSummary = {
        version: SNAPSHOT_VERSION,
        id: `snap-${now.toISOString().replace(/[:.]/g, "-")}-${summary.scanId.slice(-8)}`,
        scanId: summary.scanId,
        scannedAt: now.toISOString(),
        scope: {
          roots: summary.roots,
          excludes: scope.excludes,
          accounting: summary.accounting,
          crossFilesystems: summary.crossFilesystems,
          ...(summary.maxDepth === undefined ? {} : { maxDepth: summary.maxDepth.toString(10) }),
          filesystems: summary.filesystems,
          sameFilesystemMounts: true,
        },
        totals: summary.totals,
        completeness: summary.completeness,
        directories,
      };
      await store.save(snapshot);
      return snapshot;
    },

    list() {
      return store.list();
    },

    async latestFor(scope) {
      const snapshots = await store.list();
      return snapshots.find((snapshot) => incompatibilities(snapshot.scope, scope).length === 0);
    },

    async diff(earlierId, laterId) {
      const earlier = await store.get(earlierId);
      if (earlier === undefined) {
        return { kind: "missing", id: earlierId };
      }
      const later = await store.get(laterId);
      if (later === undefined) {
        return { kind: "missing", id: laterId };
      }

      const reasons = incompatibilities(earlier.scope, later.scope);
      if (reasons.length > 0) {
        return { kind: "incomparable", reasons };
      }
      return { kind: "diff", diff: compare(earlier, later) };
    },

    prune(limits) {
      return store.prune(limits);
    },
  };
}

/** Every reason the two scopes measured different things, in reading order. */
export function incompatibilities(earlier: SnapshotScope, later: SnapshotScope): readonly string[] {
  const reasons: string[] = [];
  if (earlier.accounting !== later.accounting) {
    reasons.push(`One scan counted ${earlier.accounting} bytes and the other counted ${later.accounting} bytes.`);
  }
  if (earlier.crossFilesystems !== later.crossFilesystems) {
    reasons.push("One scan crossed filesystem boundaries and the other did not.");
  } else if (!earlier.crossFilesystems && (earlier.sameFilesystemMounts ?? false) !== (later.sameFilesystemMounts ?? false)) {
    reasons.push("One scan stopped at every mount and the other also walked the filesystem's other mounts, such as Btrfs subvolumes.");
  }
  if (earlier.maxDepth !== later.maxDepth) {
    // A depth-limited scan of an unchanged tree otherwise reads as a large
    // deletion, which is exactly what this refusal exists to prevent.
    reasons.push(
      `One scan stopped at depth ${earlier.maxDepth ?? "unlimited"} and the other at depth ${later.maxDepth ?? "unlimited"}.`,
    );
  }
  if (!samePathSet(earlier.roots, later.roots)) {
    reasons.push("The two scans covered different roots.");
  }
  if (!samePathSet(earlier.excludes, later.excludes)) {
    reasons.push("The two scans excluded different paths.");
  }
  if (!sameSet(earlier.filesystems, later.filesystems)) {
    reasons.push("The two scans touched different filesystems.");
  }
  return reasons;
}

function compare(earlier: SnapshotSummary, later: SnapshotSummary): SnapshotDiff {
  // Both sides ran under the same accounting mode, or they would not have
  // reached this far. Reporting allocated bytes for an apparent-mode history
  // would answer a question nobody asked.
  const measured = (entry: DirectorySummary): bigint =>
    later.scope.accounting === "apparent" ? entry.apparentBytes : entry.allocatedBytes;
  const total = (snapshot: SnapshotSummary): bigint =>
    later.scope.accounting === "apparent" ? snapshot.totals.apparentBytes : snapshot.totals.allocatedBytes;

  const before = new Map(earlier.directories.map((entry) => [entry.path.bytesBase64, entry]));
  const after = new Map(later.directories.map((entry) => [entry.path.bytesBase64, entry]));
  const changes: DirectoryChange[] = [];

  for (const [key, entry] of after) {
    const previous = before.get(key);
    const earlierBytes = previous === undefined ? 0n : measured(previous);
    const delta = measured(entry) - earlierBytes;
    changes.push({
      path: entry.path,
      kind: previous === undefined ? "added" : direction(delta),
      earlierBytes,
      laterBytes: measured(entry),
      deltaBytes: delta,
    });
  }
  for (const [key, entry] of before) {
    if (after.has(key)) {
      continue;
    }
    changes.push({
      path: entry.path,
      kind: "removed",
      earlierBytes: measured(entry),
      laterBytes: 0n,
      deltaBytes: -measured(entry),
    });
  }

  // Largest movement first, in either direction.
  changes.sort((left, right) => compareBigint(absolute(right.deltaBytes), absolute(left.deltaBytes)));

  const uncertainty: string[] = [];
  if (!earlier.completeness.complete) {
    uncertainty.push("The earlier scan was incomplete, so part of the tree it reports was never measured.");
  }
  if (!later.completeness.complete) {
    uncertainty.push("The later scan was incomplete, so part of the tree it reports was never measured.");
  }
  if (changes.some((change) => change.kind === "added" || change.kind === "removed")) {
    uncertainty.push(
      "A directory present on only one side may have been created, removed, renamed, or simply pushed out of the snapshot's top entries.",
    );
  }

  return {
    earlier,
    later,
    totalDeltaBytes: total(later) - total(earlier),
    directories: changes,
    uncertain: uncertainty.length > 0,
    uncertainty,
  };
}

async function topDirectories(index: FileIndexPort, scanId: string, sort: EntrySort): Promise<readonly DirectorySummary[]> {
  const page = await index.query({
    scanId,
    filter: { kinds: ["directory"] },
    sort,
    order: "descending",
    limit: SNAPSHOT_DIRECTORIES,
  });
  return page.entries.map((entry) => ({
    path: entry.path,
    allocatedBytes: entry.allocatedBytes,
    apparentBytes: entry.apparentBytes,
    // A directory row's own entry count is not carried on the wire; the
    // snapshot records what the index does report and claims nothing more.
    entries: 0n,
  }));
}

function direction(delta: bigint): ChangeKind {
  if (delta > 0n) {
    return "grew";
  }
  return delta < 0n ? "shrank" : "unchanged";
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function compareBigint(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function samePathSet(left: readonly RawPath[], right: readonly RawPath[]): boolean {
  return sameSet(
    left.map((path) => path.bytesBase64),
    right.map((path) => path.bytesBase64),
  );
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const seen = new Set(left);
  return right.every((value) => seen.has(value));
}
