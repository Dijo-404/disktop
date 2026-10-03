import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { RawPath, ScanCompleteness, Warning } from "../domain/models.js";
import { rawPathFromBytes } from "../domain/paths.js";
import { decimalBytes, parseDecimalBytes } from "../domain/sizes.js";
import {
  SNAPSHOT_VERSION,
  type DirectorySummary,
  type SnapshotStore,
  type SnapshotSummary,
} from "../ports/snapshots.js";
import { readOwnFile, writeFileAtomically } from "./files.js";
import { PRIVATE_DIRECTORY_MODE } from "./xdg.js";

const PRIVATE_FILE_MODE = 0o600;
const SNAPSHOT_SUFFIX = ".json";
/**
 * Far above what a snapshot holds — a few hundred directory rows and the
 * scan's bounded warnings — and far below what would hurt to read.
 */
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

/**
 * Versioned compact snapshots on disk, one JSON file each.
 *
 * A snapshot is written to a temporary name and renamed into place, so a
 * crash mid-write leaves either the previous file or none — never a truncated
 * one that would later read as a smaller filesystem. Files whose version or
 * shape this build does not understand are skipped rather than guessed at.
 *
 * These are Disktop's own records under `$XDG_DATA_HOME`. Nothing here touches
 * a user file; removing a snapshot removes a summary, not data.
 */
export function createSnapshotStore(dataDirectory: string): SnapshotStore {
  const directory = join(dataDirectory, "snapshots");

  return {
    async save(snapshot) {
      if (!isSafeId(snapshot.id)) {
        throw new RangeError("A snapshot ID names one file in the store and nothing else");
      }
      await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      const encoded = `${JSON.stringify(encodeSnapshot(snapshot), null, 2)}\n`;
      await writeFileAtomically(join(directory, `${snapshot.id}${SNAPSHOT_SUFFIX}`), encoded, PRIVATE_FILE_MODE);
    },

    async list() {
      const snapshots: SnapshotSummary[] = [];
      for (const name of await snapshotFiles(directory)) {
        const snapshot = await readSnapshot(directory, name.slice(0, -SNAPSHOT_SUFFIX.length));
        if (snapshot !== undefined) {
          snapshots.push(snapshot);
        }
      }
      // Newest first: every caller wants the most recent comparable scan.
      return snapshots.sort((left, right) => right.scannedAt.localeCompare(left.scannedAt));
    },

    async get(id) {
      if (!isSafeId(id)) {
        return undefined;
      }
      return readSnapshot(directory, id);
    },

    async prune(limits) {
      const snapshots = await this.list();
      const keep = Math.max(1, Math.trunc(limits.keepLatest));
      const kept = snapshots.slice(0, keep);
      const doomed = snapshots.slice(keep);

      if (limits.maxBytes !== undefined) {
        let used = 0n;
        for (const snapshot of kept) {
          used += await fileBytes(join(directory, `${snapshot.id}${SNAPSHOT_SUFFIX}`));
        }
        // Drop oldest-first from what the count limit would otherwise have
        // kept, but never the newest: a store with no snapshot is worse than
        // a store slightly over budget.
        for (let index = kept.length - 1; index >= 1 && used > limits.maxBytes; index -= 1) {
          const snapshot = kept[index] as SnapshotSummary;
          used -= await fileBytes(join(directory, `${snapshot.id}${SNAPSHOT_SUFFIX}`));
          doomed.push(snapshot);
        }
      }

      for (const snapshot of doomed) {
        await rm(join(directory, `${snapshot.id}${SNAPSHOT_SUFFIX}`), { force: true });
      }
      return doomed.length;
    },
  };
}

/** A snapshot ID names one file in one directory; it is never a path. */
export function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(id) && id !== "." && id !== "..";
}

export function newSnapshotId(scannedAt: Date): string {
  const stamp = scannedAt.toISOString().replace(/[:.]/g, "-");
  return `snap-${stamp}-${randomBytes(4).toString("hex")}`;
}

async function snapshotFiles(directory: string): Promise<readonly string[]> {
  try {
    const names = await readdir(directory);
    return names.filter((name) => name.endsWith(SNAPSHOT_SUFFIX) && isSafeId(name.slice(0, -SNAPSHOT_SUFFIX.length)));
  } catch {
    return [];
  }
}

async function fileBytes(path: string): Promise<bigint> {
  try {
    const stats = await stat(path, { bigint: true });
    return stats.size;
  } catch {
    return 0n;
  }
}

/**
 * One snapshot, read from the file its ID names.
 *
 * The file must be a regular file, not a link, and small; and the ID inside it
 * must be the one its name gives. Prune removes a snapshot by that ID, so a
 * file claiming another one — `../anything` — would otherwise direct a removal
 * outside the store.
 */
async function readSnapshot(directory: string, id: string): Promise<SnapshotSummary | undefined> {
  let text: string;
  try {
    text = await readOwnFile(join(directory, `${id}${SNAPSHOT_SUFFIX}`), MAX_SNAPSHOT_BYTES, { followSymlinks: false });
  } catch {
    return undefined;
  }
  try {
    const snapshot = decodeSnapshot(JSON.parse(text));
    return snapshot.id === id ? snapshot : undefined;
  } catch {
    // A snapshot this build cannot read is skipped, not repaired: a guessed
    // reading would be compared against a real one.
    return undefined;
  }
}

function encodeSnapshot(snapshot: SnapshotSummary): Record<string, unknown> {
  return {
    version: SNAPSHOT_VERSION,
    id: snapshot.id,
    scanId: snapshot.scanId,
    scannedAt: snapshot.scannedAt,
    scope: {
      roots: snapshot.scope.roots.map(encodePath),
      excludes: snapshot.scope.excludes.map(encodePath),
      accounting: snapshot.scope.accounting,
      crossFilesystems: snapshot.scope.crossFilesystems,
      ...(snapshot.scope.maxDepth === undefined ? {} : { maxDepth: snapshot.scope.maxDepth }),
      filesystems: [...snapshot.scope.filesystems],
    },
    totals: {
      allocatedBytes: decimalBytes(snapshot.totals.allocatedBytes),
      apparentBytes: decimalBytes(snapshot.totals.apparentBytes),
      sharedBytes: decimalBytes(snapshot.totals.sharedBytes),
    },
    completeness: {
      complete: snapshot.completeness.complete,
      scannedEntries: decimalBytes(snapshot.completeness.scannedEntries),
      inaccessibleDirectories: decimalBytes(snapshot.completeness.inaccessibleDirectories),
      excludedMounts: snapshot.completeness.excludedMounts.map(encodePath),
      warnings: snapshot.completeness.warnings.map((warning) => ({
        code: warning.code,
        message: warning.message,
        ...(warning.path === undefined ? {} : { path: encodePath(warning.path) }),
      })),
    },
    directories: snapshot.directories.map((entry) => ({
      path: encodePath(entry.path),
      allocatedBytes: decimalBytes(entry.allocatedBytes),
      apparentBytes: decimalBytes(entry.apparentBytes),
      entries: decimalBytes(entry.entries),
    })),
  };
}

function decodeSnapshot(value: unknown): SnapshotSummary {
  const document = expectRecord(value, "snapshot");
  if (document.version !== SNAPSHOT_VERSION) {
    throw new RangeError("The snapshot was written by a different version of Disktop");
  }
  const scope = expectRecord(document.scope, "scope");
  const totals = expectRecord(document.totals, "totals");
  const accounting = scope.accounting;
  if (accounting !== "allocated" && accounting !== "apparent") {
    throw new RangeError("The snapshot names an unknown accounting mode");
  }

  return {
    version: SNAPSHOT_VERSION,
    id: expectString(document.id, "id"),
    scanId: expectString(document.scanId, "scanId"),
    scannedAt: expectString(document.scannedAt, "scannedAt"),
    scope: {
      roots: expectPaths(scope.roots, "roots"),
      excludes: expectPaths(scope.excludes, "excludes"),
      accounting,
      crossFilesystems: expectBoolean(scope.crossFilesystems, "crossFilesystems"),
      ...(scope.maxDepth === undefined ? {} : { maxDepth: expectString(scope.maxDepth, "maxDepth") }),
      filesystems: expectStrings(scope.filesystems, "filesystems"),
    },
    totals: {
      allocatedBytes: parseDecimalBytes(expectString(totals.allocatedBytes, "allocatedBytes")),
      apparentBytes: parseDecimalBytes(expectString(totals.apparentBytes, "apparentBytes")),
      sharedBytes: parseDecimalBytes(expectString(totals.sharedBytes, "sharedBytes")),
    },
    completeness: decodeCompleteness(document.completeness),
    directories: decodeDirectories(document.directories),
  };
}

function decodeCompleteness(value: unknown): ScanCompleteness {
  const record = expectRecord(value, "completeness");
  const warnings = record.warnings;
  if (!Array.isArray(warnings)) {
    throw new RangeError("The snapshot has no warning list");
  }
  return {
    complete: expectBoolean(record.complete, "complete"),
    scannedEntries: parseDecimalBytes(expectString(record.scannedEntries, "scannedEntries")),
    inaccessibleDirectories: parseDecimalBytes(expectString(record.inaccessibleDirectories, "inaccessibleDirectories")),
    excludedMounts: expectPaths(record.excludedMounts, "excludedMounts"),
    warnings: warnings.map((entry: unknown): Warning => {
      const warning = expectRecord(entry, "warning");
      const path = warning.path;
      return {
        code: expectString(warning.code, "code"),
        message: expectString(warning.message, "message"),
        ...(typeof path === "string" ? { path: decodePath(path) } : {}),
      };
    }),
  };
}

function decodeDirectories(value: unknown): readonly DirectorySummary[] {
  if (!Array.isArray(value)) {
    throw new RangeError("The snapshot has no directory list");
  }
  return value.map((entry: unknown) => {
    const directory = expectRecord(entry, "directory");
    return {
      path: decodePath(expectString(directory.path, "path")),
      allocatedBytes: parseDecimalBytes(expectString(directory.allocatedBytes, "allocatedBytes")),
      apparentBytes: parseDecimalBytes(expectString(directory.apparentBytes, "apparentBytes")),
      entries: parseDecimalBytes(expectString(directory.entries, "entries")),
    };
  });
}

function encodePath(path: RawPath): string {
  return path.bytesBase64;
}

function decodePath(encoded: string): RawPath {
  return rawPathFromBytes(new Uint8Array(Buffer.from(encoded, "base64")));
}

function expectRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError(`The snapshot's '${field}' is not an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new RangeError(`The snapshot's '${field}' is not a string`);
  }
  return value;
}

function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new RangeError(`The snapshot's '${field}' is not a boolean`);
  }
  return value;
}

function expectStrings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry: unknown) => typeof entry !== "string")) {
    throw new RangeError(`The snapshot's '${field}' is not a list of strings`);
  }
  return value as readonly string[];
}

function expectPaths(value: unknown, field: string): readonly RawPath[] {
  return expectStrings(value, field).map(decodePath);
}
