import { CapabilityUnavailable } from "../domain/errors.js";
import type { Capability, RawPath, ScanCompleteness, Warning } from "../domain/models.js";
import type { Accounting, ScanPort, ScanRequest, ScanTotals } from "../ports/scan.js";

export interface ScanSettings {
  readonly crossFilesystems: boolean;
  readonly accounting: Accounting;
  readonly excludes: readonly RawPath[];
  readonly throttleBytesPerSecond?: bigint;
}

export interface ScanProgress {
  readonly scannedEntries: bigint;
  readonly processedBytes: bigint;
  readonly inaccessibleDirectories: bigint;
  readonly currentPath?: RawPath;
}

export interface ScanSummary {
  readonly scanId: string;
  readonly accounting: Accounting;
  readonly roots: readonly RawPath[];
  readonly completeness: ScanCompleteness;
  readonly totals: ScanTotals;
}

export type ScanOutcome =
  | { readonly kind: "scanned"; readonly summary: ScanSummary }
  | { readonly kind: "unavailable"; readonly capability: Capability };

/**
 * What one invocation may change about the configured defaults.
 *
 * Accounting and mount policy decide what a scan measures, so a snapshot
 * records the values that were actually used rather than the configured ones.
 */
export interface ScanOverrides {
  readonly accounting?: Accounting;
  readonly crossFilesystems?: boolean;
  readonly throttleBytesPerSecond?: bigint;
  readonly maxDepth?: bigint;
}

export interface ScanService {
  run(
    roots: readonly RawPath[],
    overrides: ScanOverrides,
    signal: AbortSignal,
    onProgress?: (progress: ScanProgress) => void,
  ): Promise<ScanOutcome>;
}

/**
 * One scan, from a set of roots to a stored, queryable result.
 *
 * Progress is handed to the caller as it arrives rather than accumulated, so
 * neither this service nor the surface above it holds anything that grows with
 * the number of entries. A scan that ends early still returns a summary: the
 * completeness flag and its warnings are how the caller learns it is partial,
 * and there is no path here that turns an unscanned subtree into zero bytes.
 */
export function createScanService(scanner: ScanPort, settings: ScanSettings): ScanService {
  return {
    async run(roots, overrides, signal, onProgress) {
      if (roots.length === 0) {
        throw new RangeError("A scan needs at least one root");
      }

      const throttle = overrides.throttleBytesPerSecond ?? settings.throttleBytesPerSecond;
      const request: ScanRequest = {
        roots,
        crossFilesystems: overrides.crossFilesystems ?? settings.crossFilesystems,
        excludes: settings.excludes,
        accounting: overrides.accounting ?? settings.accounting,
        ...(throttle === undefined ? {} : { throttleBytesPerSecond: throttle }),
        ...(overrides.maxDepth === undefined ? {} : { maxDepth: overrides.maxDepth }),
      };

      let summary: ScanSummary | undefined;
      try {
        for await (const event of scanner.run(request, signal)) {
          if (event.kind === "progress") {
            onProgress?.({
              scannedEntries: event.scannedEntries,
              processedBytes: event.processedBytes,
              inaccessibleDirectories: event.inaccessibleDirectories,
              ...(event.currentPath === undefined ? {} : { currentPath: event.currentPath }),
            });
            continue;
          }
          if (event.kind === "complete") {
            summary = {
              scanId: event.scanId,
              accounting: event.accounting,
              roots: event.roots,
              completeness: event.completeness,
              totals: event.totals,
            };
          }
        }
      } catch (error) {
        if (error instanceof CapabilityUnavailable) {
          return { kind: "unavailable", capability: error.capability };
        }
        throw error;
      }

      if (summary === undefined) {
        // A stream that ended without a completion is a fault, never a scan
        // that found nothing.
        throw new Error("The scan ended without a result.");
      }
      return { kind: "scanned", summary };
    },
  };
}

/** The warnings a caller should show first: what was missed, then why. */
export function orderedWarnings(completeness: ScanCompleteness): readonly Warning[] {
  const rank = (warning: Warning): number => {
    if (warning.code === "cancelled") {
      return 0;
    }
    return warning.code === "inaccessible-directory" ? 1 : 2;
  };
  return [...completeness.warnings].sort((left, right) => rank(left) - rank(right));
}
