import type { Report } from "../application/report.js";
import type { RawPath, Warning } from "../domain/models.js";
import { sanitizeText } from "../domain/paths.js";
import { filesystemUsage, instantFromNanoseconds } from "./usage.js";

/**
 * The one column layout every row shares, so the file loads into a
 * spreadsheet or a dataframe as a single table. `section` says what a row is;
 * a cell a section does not use is empty. An empty cell is "not applicable or
 * not known", never zero: an unmeasured size is an empty `size_bytes` beside
 * `size_basis` `unknown`. docs/cli.md lists which columns each section fills.
 */
export const CSV_COLUMNS = [
  "section",
  "id",
  "kind",
  "path_display",
  "path_bytes_base64",
  "allocated_bytes",
  "apparent_bytes",
  "shared_bytes",
  "size_bytes",
  "size_basis",
  "total_bytes",
  "free_bytes",
  "available_bytes",
  "used_percent",
  "inodes_used_percent",
  "threshold_percent",
  "entries",
  "modified_at",
  "status",
  "detail",
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];
type Row = Partial<Record<CsvColumn, string>>;

/** RFC 4180 ends every record, the last one included, with CRLF. */
const RECORD_END = "\r\n";

/**
 * The characters a spreadsheet reads as the start of a formula, plus the
 * apostrophe that marks a neutralised cell. Prefixing an apostrophe to a
 * cell that already begins with one keeps the rule reversible: a consumer
 * that wants the original strips exactly one leading apostrophe from every
 * cell that has one, and nothing else changes.
 */
const FORMULA_LEAD = /^[=+\-@\t\r']/;

/**
 * One cell, safe to open in a spreadsheet and to parse as RFC 4180.
 *
 * Text is sanitized first, so no control character survives into a cell: a
 * newline in a filename is its Control Picture, not a record break. A cell a
 * spreadsheet would evaluate — `=cmd|' /C calc'!A0`, `@SUM(...)`, `+1`, `-1`
 * — is prefixed with an apostrophe so it is shown as the text it is. Then
 * the cell is quoted when it holds a comma, a quote, or a line break, with
 * every quote doubled.
 */
export function csvCell(value: string): string {
  const sanitized = sanitizeText(value);
  const neutralised = FORMULA_LEAD.test(sanitized) ? `'${sanitized}` : sanitized;
  return /[",\r\n]/.test(neutralised) ? `"${neutralised.replace(/"/g, '""')}"` : neutralised;
}

export function renderCsvReport(report: Report): string {
  const rows: Row[] = [];
  const add = (row: Row): void => {
    rows.push(row);
  };
  const warn = (section: string, warning: Warning): void =>
    add({ section: "warning", id: warning.code, kind: section, ...pathCells(warning.path), detail: warning.message });

  add({ section: "report", id: "schema-version", detail: "1" });
  add({ section: "report", id: "generated-at", detail: report.generatedAt.toISOString() });
  add({ section: "report", id: "generator", detail: `disktop ${report.version}` });
  add({ section: "report", id: "status", status: report.complete ? "complete" : "incomplete" });
  add({ section: "report", id: "capacity", kind: "section", status: report.capacity.complete ? "complete" : "incomplete" });
  add({
    section: "report",
    id: "scan",
    kind: "section",
    status: report.scan.included ? (report.scan.complete ? "complete" : "incomplete") : "omitted",
    ...(report.scan.included ? {} : { detail: report.scan.reason }),
  });
  add({
    section: "report",
    id: "findings",
    kind: "section",
    status: report.findings.included ? (report.findings.complete ? "complete" : "incomplete") : "omitted",
    ...(report.findings.included ? {} : { detail: report.findings.reason }),
  });

  const { capacity } = report;
  add({ section: "capability", id: "capacity", status: capacity.capability.status, detail: capacity.capability.explanation });
  for (const filesystem of capacity.filesystems) {
    const usage = filesystemUsage(filesystem);
    const [first] = filesystem.mounts;
    add({
      section: "filesystem",
      id: filesystem.id,
      kind: filesystem.type,
      ...pathCells(first),
      total_bytes: filesystem.totalBytes.toString(10),
      free_bytes: filesystem.freeBytes.toString(10),
      available_bytes: filesystem.availableBytes.toString(10),
      used_percent: String(usage.usedPercent),
      ...(usage.inodesUsedPercent === undefined ? {} : { inodes_used_percent: String(usage.inodesUsedPercent) }),
      ...(filesystem.readOnly === undefined ? {} : { status: filesystem.readOnly ? "read-only" : "read-write" }),
      detail: [
        `source ${filesystem.source}`,
        ...(filesystem.deviceId === undefined ? [] : [`device ${filesystem.deviceId}`]),
        ...(filesystem.network ? ["network"] : []),
        ...(filesystem.removable ? ["removable"] : []),
      ].join("; "),
    });
    // The first mount is on the filesystem row; a filesystem mounted in more
    // than one place gets a row for each place, so no mount point is lost.
    for (const mount of filesystem.mounts.slice(1)) {
      add({ section: "mount", id: filesystem.id, ...pathCells(mount) });
    }
  }
  for (const device of capacity.devices) {
    add({
      section: "device",
      id: device.id,
      kind: device.kind,
      total_bytes: device.sizeBytes.toString(10),
      entries: String(device.partitions.length),
      detail: [
        `name ${device.name}`,
        ...(device.model === undefined ? [] : [`model ${device.model}`]),
        ...(device.transport === undefined ? [] : [`transport ${device.transport}`]),
        ...(device.removable ? ["removable"] : []),
        ...(device.partitions.length === 0 ? [] : [`partitions ${device.partitions.join(" ")}`]),
      ].join("; "),
    });
  }
  for (const volume of capacity.unmounted) {
    add({
      section: "unmounted",
      id: volume.id,
      kind: volume.filesystemType,
      path_display: volume.devicePath,
      total_bytes: volume.sizeBytes.toString(10),
      status: volume.state,
      detail: [`device ${volume.deviceId}`, ...(volume.label === undefined ? [] : [`label ${volume.label}`]), "usage unknown until mounted"].join("; "),
    });
  }
  for (const alert of capacity.alerts) {
    add({
      section: "alert",
      id: alert.filesystemId,
      kind: alert.kind,
      used_percent: String(alert.usedPercent),
      threshold_percent: String(alert.thresholdPercent),
      detail: alert.message,
    });
  }
  for (const warning of capacity.warnings) {
    warn("capacity", warning);
  }

  const { scan } = report;
  if (scan.included) {
    const { snapshot } = scan;
    add({
      section: "scan",
      id: snapshot.scanId,
      kind: snapshot.scope.accounting,
      ...pathCells(scan.subject),
      allocated_bytes: snapshot.totals.allocatedBytes.toString(10),
      apparent_bytes: snapshot.totals.apparentBytes.toString(10),
      shared_bytes: snapshot.totals.sharedBytes.toString(10),
      entries: snapshot.completeness.scannedEntries.toString(10),
      modified_at: snapshot.scannedAt,
      status: scan.complete ? "complete" : "incomplete",
      detail: `snapshot ${snapshot.id}; ${snapshot.completeness.inaccessibleDirectories} unreadable director${
        snapshot.completeness.inaccessibleDirectories === 1n ? "y" : "ies"
      }; totals cover the whole scan, entries cover the path`,
    });
    for (const root of snapshot.scope.roots) {
      add({ section: "scan-root", id: snapshot.scanId, ...pathCells(root) });
    }
    for (const excluded of snapshot.completeness.excludedMounts) {
      add({ section: "excluded-mount", id: snapshot.scanId, ...pathCells(excluded) });
    }
    // What is directly inside the path, which adds up, and the largest
    // files, which a spreadsheet would otherwise have to dig out of `entry`.
    for (const [section, ranked] of [
      ["child", scan.children],
      ["largest-file", scan.largestFiles],
    ] as const) {
      for (const entry of ranked?.entries ?? []) {
        const modified = instantFromNanoseconds(entry.modifiedNanoseconds);
        const unentered = entry.kind === "directory" && entry.childEntries === undefined;
        add({
          section,
          id: entry.id,
          kind: entry.kind,
          ...pathCells(entry.path),
          // A directory the scan never went inside has no size to report.
          ...(unentered
            ? { status: "not-entered" }
            : { allocated_bytes: entry.allocatedBytes.toString(10), apparent_bytes: entry.apparentBytes.toString(10) }),
          ...(entry.childEntries === undefined ? {} : { entries: entry.childEntries.toString(10) }),
          ...(modified === undefined ? {} : { modified_at: modified }),
          ...(entry.shared ? { status: "shared-hardlink" } : entry.broken === true ? { status: "broken-symlink" } : {}),
        });
      }
    }
    for (const measurement of scan.elevated?.measurements ?? []) {
      add({
        section: "measured-as-root",
        id: snapshot.scanId,
        kind: "directory",
        ...pathCells(measurement.path),
        size_bytes: measurement.bytes.toString(10),
        size_basis: scan.elevated?.accounting === "apparent" ? "measured-apparent" : "measured-allocated",
        modified_at: scan.elevated?.measuredAt ?? "",
        detail: "unreadable to the scan; measured afterwards by du running read-only as root; not in the totals",
      });
    }
    if (scan.largest !== undefined) {
      for (const entry of scan.largest.entries) {
        const modified = instantFromNanoseconds(entry.modifiedNanoseconds);
        add({
          section: "entry",
          id: entry.id,
          kind: entry.kind,
          ...pathCells(entry.path),
          allocated_bytes: entry.allocatedBytes.toString(10),
          apparent_bytes: entry.apparentBytes.toString(10),
          ...(entry.childEntries === undefined ? {} : { entries: entry.childEntries.toString(10) }),
          ...(modified === undefined ? {} : { modified_at: modified }),
          ...(entry.shared ? { status: "shared-hardlink" } : entry.broken === true ? { status: "broken-symlink" } : {}),
        });
      }
      if (scan.largest.more) {
        add({
          section: "entry-limit",
          id: snapshot.scanId,
          entries: String(scan.largest.limit),
          detail: `Only the ${scan.largest.limit} largest entries are listed; more exist under the path.`,
        });
      }
    }
    for (const total of scan.typeTotals ?? []) {
      add({
        section: "type-total",
        id: total.extension,
        kind: "extension",
        allocated_bytes: total.allocatedBytes.toString(10),
        apparent_bytes: total.apparentBytes.toString(10),
        entries: total.entries.toString(10),
        ...(total.extension === "" ? { detail: "files with no extension" } : {}),
      });
    }
    for (const warning of scan.warnings) {
      warn("scan", warning);
    }
  }

  const { findings } = report;
  if (findings.included) {
    const { summary } = findings;
    add({ section: "capability", id: "findings", status: summary.capability.status, detail: summary.capability.explanation });
    for (const finding of summary.findings) {
      add({
        section: "finding",
        id: finding.id,
        kind: finding.category,
        ...(finding.size.bytes === undefined ? {} : { size_bytes: finding.size.bytes.toString(10) }),
        size_basis: finding.size.basis,
        entries: String(finding.paths.length),
        status: finding.capability.status,
        detail: [
          finding.title,
          `confidence ${finding.confidence}`,
          ...(finding.active ? ["in use"] : []),
          ...(finding.managerScope === undefined ? [] : [`runs ${finding.managerScope}`]),
          `actions ${finding.availableActionIds.length === 0 ? "none" : finding.availableActionIds.join(" ")}`,
        ].join("; "),
      });
      // One row per path, so a finding's size is on its own row once and a
      // column sum never counts it twice.
      for (const path of finding.paths) {
        add({ section: "finding-path", id: finding.id, ...pathCells(path) });
      }
    }
    for (const provider of summary.providers) {
      add({
        section: "provider",
        id: provider.providerId,
        kind: provider.ran ? "ran" : "did-not-run",
        entries: String(provider.findings),
        status: provider.capability.status,
        detail: `${provider.complete ? "complete" : "incomplete"}; ${provider.capability.explanation}`,
      });
    }
    for (const total of summary.categoryTotals) {
      add({
        section: "category-total",
        id: total.category,
        size_bytes: total.bytes.toString(10),
        entries: String(total.findings),
        detail: `${total.unmeasured} unmeasured; ${total.nested} inside another finding, counted once`,
      });
    }
    for (const warning of findings.warnings) {
      warn("findings", warning);
    }
  }

  const lines = [CSV_COLUMNS.map(csvCell).join(","), ...rows.map((row) => CSV_COLUMNS.map((column) => csvCell(row[column] ?? "")).join(","))];
  return `${lines.join(RECORD_END)}${RECORD_END}`;
}

function pathCells(path: RawPath | undefined): Row {
  return path === undefined ? {} : { path_display: path.display, path_bytes_base64: path.bytesBase64 };
}
