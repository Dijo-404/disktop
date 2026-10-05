import { CapabilityUnavailable, StaleScanIndex, type OperationFailure } from "../domain/errors.js";
import type { Capability, IndexedEntry, RawPath, Warning } from "../domain/models.js";
import { isWithin, pathBytes, scanReaches } from "../domain/paths.js";
import type { ElevatedMeasurement, ElevatedRecord } from "../ports/elevated.js";
import type { ReportFilePort, ReportTargetCheck, ReportWriteOutcome } from "../ports/reports.js";
import type { TypeTotal } from "../ports/scan.js";
import type { SnapshotSummary } from "../ports/snapshots.js";
import type { DashboardService, InventoryView } from "./dashboard.js";
import type { ExploreService } from "./explore.js";
import type { FootprintService, FootprintSummary } from "./footprint.js";
import type { SnapshotService } from "./snapshots.js";

export const DEFAULT_REPORT_ENTRIES = 50;
export const MAX_REPORT_ENTRIES = 1000;

export type ReportSectionName = "capacity" | "scan" | "findings";

/** The joined capacity view, exactly as the dashboard and `devices` see it. */
export type CapacitySection = InventoryView;

export interface OmittedSection {
  readonly included: false;
  /** Why the section is not in this report, and what would put it there. */
  readonly reason: string;
}

export interface LargestEntries {
  readonly limit: number;
  readonly entries: readonly IndexedEntry[];
  /** True when the subtree holds more entries than the listing shows. */
  readonly more: boolean;
}

export interface ScanSection {
  readonly included: true;
  readonly complete: boolean;
  readonly warnings: readonly Warning[];
  /** The path the report was asked about; the snapshot's roots cover it. */
  readonly subject: RawPath;
  readonly snapshot: SnapshotSummary;
  /** Absent when the index could not answer, which a warning explains. */
  readonly largest?: LargestEntries;
  /**
   * What is directly inside the subject, largest first. Unlike `largest`,
   * which ranks a directory beside its own ancestors, these do not overlap,
   * so their sizes add up to the subject's.
   */
  readonly children?: LargestEntries;
  /** The largest regular files anywhere under the subject. */
  readonly largestFiles?: LargestEntries;
  readonly typeTotals?: readonly TypeTotal[];
  /** Unreadable directories under the subject, measured as root when somebody asked. */
  readonly elevated?: ElevatedSummary;
}

export interface ElevatedSummary {
  readonly measuredAt: string;
  readonly accounting: ElevatedRecord["accounting"];
  /** Largest first; never added into the scan's own totals. */
  readonly measurements: readonly ElevatedMeasurement[];
  readonly totalBytes: bigint;
}

export interface FindingsSection {
  readonly included: true;
  readonly complete: boolean;
  readonly warnings: readonly Warning[];
  readonly summary: FootprintSummary;
}

export interface Report {
  readonly generatedAt: Date;
  readonly version: string;
  /** False when any included section is short of what it covers. */
  readonly complete: boolean;
  readonly capacity: CapacitySection;
  readonly scan: ScanSection | OmittedSection;
  readonly findings: FindingsSection | OmittedSection;
}

export interface ReportRequest {
  /** The path whose stored scan to include. Absent leaves the scan out. */
  readonly subject?: RawPath;
  readonly limit: number;
  readonly findings: boolean;
  readonly generatedAt: Date;
  readonly version: string;
}

export type ReportOutcome =
  | { readonly kind: "report"; readonly report: Report }
  | { readonly kind: "refused"; readonly failure: OperationFailure };

export interface ReportService {
  gather(request: ReportRequest, signal: AbortSignal): Promise<ReportOutcome>;
  /** Whether a report could be published at `target`, asked before the slow part. */
  check(target: RawPath): Promise<ReportTargetCheck>;
  publish(target: RawPath, content: Uint8Array): Promise<ReportWriteOutcome>;
}

export interface ReportDependencies {
  readonly dashboard: DashboardService;
  readonly snapshots: Pick<SnapshotService, "list">;
  readonly explore: ExploreService;
  readonly footprint: FootprintService;
  readonly files: ReportFilePort;
  readonly effectiveUserId: number;
  /** What `--sudo` or the TUI's A measured, when anything was. */
  readonly elevated?: { recorded(scanId: string): Promise<ElevatedRecord | undefined> };
}

/** Every section a report carries, in the order the formats present them. */
export function includedSections(report: Report): readonly ReportSectionName[] {
  return [
    "capacity",
    ...(report.scan.included ? (["scan"] as const) : []),
    ...(report.findings.included ? (["findings"] as const) : []),
  ];
}

/** Every warning in a report, section by section, so none is reported twice. */
export function reportWarnings(report: Report): readonly Warning[] {
  return [
    ...report.capacity.warnings,
    ...(report.scan.included ? report.scan.warnings : []),
    ...(report.findings.included ? report.findings.warnings : []),
  ];
}

/**
 * Gather what a report says, from the services every other surface uses.
 *
 * A report adds no reading of its own. Capacity is the dashboard's joined
 * inventory, the scan is the newest stored snapshot that covers the path and
 * a page of its index, and the findings are what `disktop clean` would list.
 * Each section carries its own completeness and warnings, so a report that
 * could not see something says which part of it is short.
 */
export function createReportService(dependencies: ReportDependencies): ReportService {
  // As root Disktop changes no file itself. A report is a new file somewhere
  // the person named, and a root-owned file appearing in a directory a root
  // shell happened to be in is exactly the kind of change that rule is about.
  const rootRefusal: OperationFailure | undefined =
    dependencies.effectiveUserId === 0
      ? {
          code: "permission-denied",
          message:
            "Run as root, Disktop writes no file itself. Leave out --output and redirect standard output instead, for example 'disktop report --format html > report.html'.",
        }
      : undefined;

  return {
    async gather(request, signal) {
      if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > MAX_REPORT_ENTRIES) {
        return refuse("invalid-input", `A report lists from 1 to ${MAX_REPORT_ENTRIES} entries.`);
      }

      const capacity = await dependencies.dashboard.inventory();

      let scan: ScanSection | OmittedSection = {
        included: false,
        reason: "No --path was given, so no scan is included. Add --path PATH to include the newest stored scan that covers it.",
      };
      if (request.subject !== undefined) {
        const snapshot = await newestCovering(dependencies.snapshots, request.subject);
        if (snapshot === undefined) {
          return refuse(
            "invalid-input",
            `No stored scan covers ${request.subject.display}. Run 'disktop scan ${request.subject.display}' first, or leave out --path.`,
          );
        }
        scan = await scanSection(dependencies.explore, request.subject, snapshot, request.limit);
        const record = await dependencies.elevated?.recorded(snapshot.scanId);
        const elevated = record === undefined ? undefined : elevatedUnder(record, request.subject);
        if (elevated !== undefined) {
          scan = { ...scan, elevated };
        }
      }

      let findings: FindingsSection | OmittedSection = {
        included: false,
        reason: "Detectors were not run. Add --findings to include what they found.",
      };
      if (request.findings) {
        const summary = await dependencies.footprint.discover({ measureSizes: true }, signal);
        findings = { included: true, complete: summary.complete, warnings: summary.warnings, summary };
      }

      // A report somebody stopped is not written at all. Half a report saved
      // under the name they chose reads, later, like the whole one.
      if (signal.aborted) {
        return refuse("cancelled", "The report was interrupted, so nothing was written.");
      }

      const complete =
        capacity.complete && (!scan.included || scan.complete) && (!findings.included || findings.complete);
      return {
        kind: "report",
        report: { generatedAt: request.generatedAt, version: request.version, complete, capacity, scan, findings },
      };
    },

    async check(target) {
      return rootRefusal === undefined ? dependencies.files.check(target) : { kind: "refused", failure: rootRefusal };
    },

    async publish(target, content) {
      return rootRefusal === undefined
        ? dependencies.files.createExclusive(target, content)
        : { kind: "refused", failure: rootRefusal };
    },
  };
}

/** The newest snapshot that really reached the path, past no exclude or skipped mount. */
async function newestCovering(
  snapshots: Pick<SnapshotService, "list">,
  subject: RawPath,
): Promise<SnapshotSummary | undefined> {
  const stored = await snapshots.list();
  return stored.find((snapshot) =>
    scanReaches(snapshot.scope.roots, [...snapshot.scope.excludes, ...snapshot.completeness.excludedMounts], subject),
  );
}

/** The measurements at or below the subject, largest first, or nothing when none are. */
function elevatedUnder(record: ElevatedRecord, subject: RawPath): ElevatedSummary | undefined {
  const base = pathBytes(subject);
  const measurements = record.measurements
    .filter((measurement) => isWithin(base, pathBytes(measurement.path)))
    .sort((left, right) => (left.bytes === right.bytes ? 0 : left.bytes > right.bytes ? -1 : 1));
  if (measurements.length === 0) {
    return undefined;
  }
  return {
    measuredAt: record.measuredAt,
    accounting: record.accounting,
    measurements,
    totalBytes: measurements.reduce((sum, measurement) => sum + measurement.bytes, 0n),
  };
}

/**
 * The stored scan's summary plus one page of its index under the path.
 *
 * The summary lives in the snapshot and survives the index pruning a scan;
 * the largest entries and the type totals need the index. When the index
 * cannot answer, the summary is still reported and the section says what it
 * is missing rather than listing nothing as though nothing were there.
 */
async function scanSection(
  explore: ExploreService,
  subject: RawPath,
  snapshot: SnapshotSummary,
  limit: number,
): Promise<ScanSection> {
  const warnings: Warning[] = snapshot.completeness.complete ? [] : [...snapshot.completeness.warnings];
  if (!snapshot.completeness.complete && warnings.length === 0) {
    warnings.push({ code: "incomplete-scan", message: `Scan ${snapshot.scanId} did not finish reading its tree.` });
  }

  const unanswered = (capability: Capability | undefined, message: string): ScanSection => ({
    included: true,
    complete: false,
    warnings: [...warnings, { code: "index-unavailable", message: capability === undefined ? message : `${message} ${capability.explanation}` }],
    subject,
    snapshot,
  });

  let outcome;
  try {
    outcome = await explore.page({
      scanId: snapshot.scanId,
      filter: { underPath: subject },
      sort: "allocated",
      order: "descending",
      limit,
      includeTypeTotals: true,
    });
  } catch (error) {
    if (error instanceof StaleScanIndex) {
      return unanswered(
        undefined,
        `The index no longer holds scan ${snapshot.scanId}, so the largest entries and type totals are missing. Run 'disktop scan ${subject.display}' again to include them.`,
      );
    }
    if (error instanceof CapabilityUnavailable) {
      return unanswered(error.capability, "The index could not be read, so the largest entries and type totals are missing.");
    }
    throw error;
  }
  if (outcome.kind === "unavailable") {
    return unanswered(outcome.capability, "The index could not be read, so the largest entries and type totals are missing.");
  }

  // The breakdown that adds up: what is directly inside, then the largest
  // files on their own. Either is left out, not emptied, if the index cannot
  // answer for it.
  const own = await explore.page({ scanId: snapshot.scanId, filter: { atPath: subject }, limit: 1 });
  const subjectRow = own.kind === "page" ? own.page.entries.find((entry) => entry.path.bytesBase64 === subject.bytesBase64) : undefined;
  const children =
    subjectRow === undefined
      ? undefined
      : await explore.page({ scanId: snapshot.scanId, filter: { parentId: subjectRow.id }, sort: "allocated", order: "descending", limit });
  const files = await explore.page({
    scanId: snapshot.scanId,
    filter: { underPath: subject, kinds: ["file"] },
    sort: "allocated",
    order: "descending",
    limit,
  });

  return {
    included: true,
    complete: snapshot.completeness.complete,
    warnings,
    subject,
    snapshot,
    largest: { limit, entries: outcome.page.entries, more: outcome.page.nextCursor !== undefined },
    ...(children?.kind === "page"
      ? { children: { limit, entries: children.page.entries, more: children.page.nextCursor !== undefined } }
      : {}),
    ...(files.kind === "page" ? { largestFiles: { limit, entries: files.page.entries, more: files.page.nextCursor !== undefined } } : {}),
    typeTotals: outcome.page.typeTotals ?? [],
  };
}

function refuse(code: OperationFailure["code"], message: string): ReportOutcome {
  return { kind: "refused", failure: { code, message } };
}
