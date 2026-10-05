import type { Capability, RawPath, Warning } from "../domain/models.js";
import { isWithin, pathBytes } from "../domain/paths.js";
import type { ElevatedMeasurePort, ElevatedRecord, ElevatedRunOptions, ElevatedStore } from "../ports/elevated.js";
import type { FileIndexPort } from "../ports/scan.js";
import type { SnapshotSummary } from "../ports/snapshots.js";

/** The most directories one request measures; the rest are counted, not dropped silently. */
const MAX_DIRECTORIES = 4096;
const PAGE = 1000;

export type ElevatedOutcome =
  | {
      readonly kind: "measured";
      readonly record: ElevatedRecord;
      /** The directories' combined size, in the scan's own accounting. */
      readonly totalBytes: bigint;
      /** The scan holds more unreadable directories than one request measures. */
      readonly more: boolean;
      readonly warnings: readonly Warning[];
    }
  | { readonly kind: "nothing-unreadable" }
  | { readonly kind: "denied"; readonly explanation: string }
  | { readonly kind: "unavailable"; readonly capability: Capability };

export interface ElevatedService {
  /**
   * Directories the scan recorded and could not enter, leaving out the mounts
   * it stayed out of on purpose: those are other filesystems, measured on
   * their own, and adding them here would count another disk as this one.
   */
  unreadable(snapshot: SnapshotSummary): Promise<{ readonly paths: readonly RawPath[]; readonly more: boolean }>;
  measure(snapshot: SnapshotSummary, options: ElevatedRunOptions): Promise<ElevatedOutcome>;
  recorded(scanId: string): Promise<ElevatedRecord | undefined>;
}

export interface ElevatedDependencies {
  readonly index: FileIndexPort;
  readonly port: ElevatedMeasurePort;
  readonly store: ElevatedStore;
  readonly now: () => Date;
}

/**
 * Sizes for what an ordinary user's scan could not read, measured with
 * administrator rights when somebody asks for it.
 *
 * The scan itself is never changed: these numbers come from a different tool
 * running as a different user, so they are kept beside the scan and shown as
 * what they are rather than added into its totals.
 */
export function createElevatedService(dependencies: ElevatedDependencies): ElevatedService {
  const unreadable: ElevatedService["unreadable"] = async (snapshot) => {
    const skipped = [...snapshot.completeness.excludedMounts, ...snapshot.scope.excludes].map(pathBytes);
    const paths: RawPath[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await dependencies.index.query({
        scanId: snapshot.scanId,
        filter: { kinds: ["directory"], unentered: true },
        sort: "name",
        order: "ascending",
        limit: PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const entry of page.entries) {
        const bytes = pathBytes(entry.path);
        if (!skipped.some((mount) => isWithin(mount, bytes))) {
          paths.push(entry.path);
        }
      }
      cursor = page.nextCursor;
      if (cursor === undefined) {
        return { paths: paths.slice(0, MAX_DIRECTORIES), more: paths.length > MAX_DIRECTORIES };
      }
      if (paths.length > MAX_DIRECTORIES) {
        return { paths: paths.slice(0, MAX_DIRECTORIES), more: true };
      }
    }
  };

  return {
    unreadable,

    async measure(snapshot, options) {
      const { paths, more } = await unreadable(snapshot);
      if (paths.length === 0) {
        return { kind: "nothing-unreadable" };
      }
      const reading = await dependencies.port.measure(paths, snapshot.scope.accounting, options);
      if (reading.kind !== "measured") {
        return reading;
      }
      const record: ElevatedRecord = {
        scanId: snapshot.scanId,
        measuredAt: dependencies.now().toISOString(),
        accounting: reading.accounting,
        measurements: reading.measurements,
        skipped: reading.skipped,
      };
      await dependencies.store.save(record);
      return {
        kind: "measured",
        record,
        totalBytes: reading.measurements.reduce((sum, measurement) => sum + measurement.bytes, 0n),
        more,
        warnings: reading.warnings,
      };
    },

    recorded(scanId) {
      return dependencies.store.get(scanId);
    },
  };
}
