import { includedSections, type LargestEntries, type Report } from "../application/report.js";
import { decimalBytes } from "../domain/sizes.js";
import type { SnapshotSummary } from "../ports/snapshots.js";
import {
  encodeAlert,
  encodeCapability,
  encodeCategoryTotal,
  encodeCompleteness,
  encodeDevice,
  encodeFilesystem,
  encodeFinding,
  encodeIndexedEntry,
  encodeProviderReport,
  encodeRawPath,
  encodeScanTotals,
  encodeTypeTotal,
  encodeUnmountedVolume,
  encodeWarning,
} from "../cli/output.js";
import { filesystemUsage } from "./usage.js";

/** Bumped only together with a new `schemas/cli/v<N>/report-document.json`. */
export const REPORT_SCHEMA_VERSION = "1";

/**
 * The standalone JSON document `disktop report --format json` writes.
 *
 * It is not a CLI envelope: it is a file somebody keeps, so it names its own
 * schema version, when it was made, and by which Disktop. It reuses the
 * encoders behind `--json`, so a filesystem, an entry, or a finding reads the
 * same here as anywhere else: every integer that can exceed 2^53 is a decimal
 * string and every path carries its raw bytes in base64 beside a display form.
 */
export function renderJsonReport(report: Report): string {
  return `${JSON.stringify(reportDocument(report), null, 2)}\n`;
}

export function reportDocument(report: Report): Record<string, unknown> {
  const { capacity, scan, findings } = report;
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    document: "disktop-report",
    generatedAt: report.generatedAt.toISOString(),
    generator: { name: "disktop", version: report.version },
    status: report.complete ? "complete" : "incomplete",
    sections: [...includedSections(report)],
    capacity: {
      complete: capacity.complete,
      warnings: capacity.warnings.map(encodeWarning),
      capability: encodeCapability(capacity.capability),
      devices: capacity.devices.map(encodeDevice),
      filesystems: capacity.filesystems.map((filesystem) => {
        const usage = filesystemUsage(filesystem);
        return {
          filesystem: encodeFilesystem(filesystem),
          usedPercent: usage.usedPercent,
          ...(usage.inodesUsedPercent === undefined ? {} : { inodesUsedPercent: usage.inodesUsedPercent }),
        };
      }),
      alerts: capacity.alerts.map(encodeAlert),
      unmounted: capacity.unmounted.map(encodeUnmountedVolume),
    },
    scan: scan.included
      ? {
          included: true,
          complete: scan.complete,
          warnings: scan.warnings.map(encodeWarning),
          subject: encodeRawPath(scan.subject),
          snapshot: encodeSnapshotSummary(scan.snapshot),
          ...(scan.largest === undefined
            ? {}
            : {
                entries: {
                  sort: "allocated",
                  order: "descending",
                  limit: scan.largest.limit,
                  more: scan.largest.more,
                  items: scan.largest.entries.map(encodeIndexedEntry),
                },
              }),
          ...(scan.children === undefined ? {} : { children: rankedEntries(scan.children) }),
          ...(scan.largestFiles === undefined ? {} : { largestFiles: rankedEntries(scan.largestFiles) }),
          ...(scan.typeTotals === undefined ? {} : { typeTotals: scan.typeTotals.map(encodeTypeTotal) }),
          ...(scan.elevated === undefined
            ? {}
            : {
                elevated: {
                  measuredAt: scan.elevated.measuredAt,
                  accounting: scan.elevated.accounting,
                  bytes: decimalBytes(scan.elevated.totalBytes),
                  items: scan.elevated.measurements.map((measurement) => ({
                    path: encodeRawPath(measurement.path),
                    bytes: decimalBytes(measurement.bytes),
                    children: measurement.children.map((child) => ({ path: encodeRawPath(child.path), bytes: decimalBytes(child.bytes) })),
                  })),
                },
              }),
        }
      : { included: false, reason: scan.reason },
    findings: findings.included
      ? {
          included: true,
          complete: findings.complete,
          warnings: findings.warnings.map(encodeWarning),
          capability: encodeCapability(findings.summary.capability),
          measured: findings.summary.measured,
          findings: findings.summary.findings.map(encodeFinding),
          providers: findings.summary.providers.map(encodeProviderReport),
          categoryTotals: findings.summary.categoryTotals.map(encodeCategoryTotal),
        }
      : { included: false, reason: findings.reason },
  };
}

function rankedEntries(ranked: LargestEntries): Record<string, unknown> {
  return {
    sort: "allocated",
    order: "descending",
    limit: ranked.limit,
    more: ranked.more,
    items: ranked.entries.map(encodeIndexedEntry),
  };
}

/**
 * The snapshot without its directory aggregates: the report lists the
 * largest entries from the index instead, which go below directory level.
 */
function encodeSnapshotSummary(snapshot: SnapshotSummary): Record<string, unknown> {
  return {
    id: snapshot.id,
    scanId: snapshot.scanId,
    scannedAt: snapshot.scannedAt,
    scope: {
      roots: snapshot.scope.roots.map(encodeRawPath),
      excludes: snapshot.scope.excludes.map(encodeRawPath),
      accounting: snapshot.scope.accounting,
      crossFilesystems: snapshot.scope.crossFilesystems,
      filesystems: [...snapshot.scope.filesystems],
      ...(snapshot.scope.maxDepth === undefined ? {} : { maxDepth: snapshot.scope.maxDepth }),
    },
    totals: encodeScanTotals(snapshot.totals),
    completeness: encodeCompleteness(snapshot.completeness),
  };
}
