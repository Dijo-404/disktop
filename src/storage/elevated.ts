import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RawPath } from "../domain/models.js";
import { rawPathFromBytes } from "../domain/paths.js";
import { decimalBytes, parseDecimalBytes } from "../domain/sizes.js";
import type { ElevatedMeasurement, ElevatedRecord, ElevatedStore } from "../ports/elevated.js";
import { readOwnFile, writeFileAtomically } from "./files.js";
import { PRIVATE_DIRECTORY_MODE } from "./xdg.js";

const VERSION = 1;
const SUFFIX = ".json";
const MAX_BYTES = 32 * 1024 * 1024;
/** Measurements outlive their scans otherwise; a few recent ones are all anybody reads. */
const KEEP = 8;

/**
 * What administrator-rights measurements found, one file per scan, beside the
 * snapshots. Written atomically and private to the user, like them, and read
 * strictly: a file this build cannot read is not a measurement.
 */
export function createElevatedStore(dataDirectory: string): ElevatedStore {
  const directory = join(dataDirectory, "elevated");
  return {
    async save(record) {
      if (!validId(record.scanId)) {
        throw new RangeError("A scan ID names a file and must be a plain name");
      }
      await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      await writeFileAtomically(join(directory, `${record.scanId}${SUFFIX}`), `${JSON.stringify(encode(record))}\n`, 0o600);
      await prune(directory);
    },

    async get(scanId) {
      if (!validId(scanId)) {
        return undefined;
      }
      try {
        const record = decode(JSON.parse(await readOwnFile(join(directory, `${scanId}${SUFFIX}`), MAX_BYTES, { followSymlinks: false })));
        return record.scanId === scanId ? record : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

function validId(id: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(id) && id !== "." && id !== "..";
}

async function prune(directory: string): Promise<void> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(SUFFIX) && validId(name.slice(0, -SUFFIX.length)));
  if (names.length <= KEEP) {
    return;
  }
  const dated = await Promise.all(
    names.map(async (name) => ({ name, modified: (await stat(join(directory, name)).catch(() => undefined))?.mtimeMs ?? 0 })),
  );
  dated.sort((left, right) => right.modified - left.modified);
  for (const { name } of dated.slice(KEEP)) {
    await rm(join(directory, name), { force: true });
  }
}

function encodePath(path: RawPath): string {
  return path.bytesBase64;
}

function decodePath(value: unknown): RawPath {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new RangeError("A stored path is not base64");
  }
  return rawPathFromBytes(new Uint8Array(Buffer.from(value, "base64")));
}

function encode(record: ElevatedRecord): Record<string, unknown> {
  return {
    version: VERSION,
    scanId: record.scanId,
    measuredAt: record.measuredAt,
    accounting: record.accounting,
    measurements: record.measurements.map((measurement) => ({
      path: encodePath(measurement.path),
      bytes: decimalBytes(measurement.bytes),
      children: measurement.children.map((child) => ({ path: encodePath(child.path), bytes: decimalBytes(child.bytes) })),
    })),
    skipped: record.skipped.map(encodePath),
  };
}

function decode(value: unknown): ElevatedRecord {
  const record = object(value);
  if (record.version !== VERSION || (record.accounting !== "allocated" && record.accounting !== "apparent")) {
    throw new RangeError("Not a measurement this build can read");
  }
  return {
    scanId: text(record.scanId),
    measuredAt: text(record.measuredAt),
    accounting: record.accounting,
    measurements: list(record.measurements).map((entry): ElevatedMeasurement => {
      const measurement = object(entry);
      return {
        path: decodePath(measurement.path),
        bytes: parseDecimalBytes(text(measurement.bytes)),
        children: list(measurement.children).map((child) => {
          const item = object(child);
          return { path: decodePath(item.path), bytes: parseDecimalBytes(text(item.bytes)) };
        }),
      };
    }),
    skipped: list(record.skipped).map(decodePath),
  };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError("Expected an object");
  }
  return value as Record<string, unknown>;
}

function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new RangeError("Expected a list");
  }
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new RangeError("Expected a string");
  }
  return value;
}
