import { includedSections, reportWarnings, type Report } from "../application/report.js";
import type { Filesystem, IndexedEntry, RawPath, Warning } from "../domain/models.js";
import { sanitizeText } from "../domain/paths.js";
import { formatBytes } from "../domain/sizes.js";
import { filesystemUsage, instantFromNanoseconds } from "./usage.js";

export type Units = "iec" | "si";

/**
 * Nothing may load and nothing may run. The page is one file holding
 * filenames other people chose, so even a mistake in escaping cannot fetch a
 * resource or execute a script; inline styles are the only thing allowed.
 */
export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'";

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Text made safe for an HTML element or a quoted attribute.
 *
 * The text is sanitized first, so a control character or a bidirectional
 * override in a name cannot reorder what is shown around it, and then every
 * character HTML gives a meaning to is escaped. Every value on the page goes
 * through here; there is no path that writes text unescaped.
 */
export function escapeHtml(value: string): string {
  return sanitizeText(value).replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

const STYLE = `
:root { color-scheme: light dark; --ink: #1d232a; --muted: #5b6672; --line: #d8dee4; --panel: #f6f8fa;
  --fill: #2f6fb3; --warn: #b3261e; --ok: #1f7a3e; --bar: #e3e8ee; }
@media (prefers-color-scheme: dark) {
  :root { --ink: #e6edf3; --muted: #9aa7b3; --line: #30363d; --panel: #161b22; --fill: #4f93d8; --warn: #f2735f;
    --ok: #4fbf72; --bar: #2a313a; }
  body { background: #0d1117; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 48px; color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 1.6rem; margin: 0 0 4px; }
h2 { font-size: 1.25rem; margin: 32px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--line); }
h3 { font-size: 1.05rem; margin: 20px 0 6px; }
p { margin: 6px 0; }
.meta, .note, caption { color: var(--muted); }
caption { text-align: left; padding: 4px 0; caption-side: top; }
.status { display: inline-block; padding: 2px 10px; border-radius: 999px; font-weight: 600; color: #fff; }
.status.complete { background: var(--ok); }
.status.incomplete { background: var(--warn); }
.warnings { border-left: 4px solid var(--warn); background: var(--panel); padding: 8px 12px 8px 28px; margin: 12px 0; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid var(--line); }
th { background: var(--panel); font-weight: 600; }
td.num, th.num { text-align: right; white-space: nowrap; }
td.nowrap { white-space: nowrap; }
td.path { overflow-wrap: anywhere; word-break: break-all; font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; font-size: 0.9em; }
.bar { display: inline-block; width: 120px; height: 10px; background: var(--bar); border-radius: 5px; overflow: hidden; vertical-align: middle; margin-right: 8px; }
.bar > span { display: block; height: 100%; background: var(--fill); }
.bar.alert > span { background: var(--warn); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 8px 0 16px; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
.flag { color: var(--warn); font-weight: 600; }
details > summary { cursor: pointer; }
details ul { margin: 4px 0 8px; padding-left: 20px; }
footer { margin-top: 40px; color: var(--muted); font-size: 0.85rem; }
`;

/**
 * One standalone HTML file: no script, no external resource, no link that
 * leaves the page. Sizes are shown in the chosen units with the exact byte
 * count beside them in a tooltip, an unknown size says unknown, and every
 * section that is short of what it covers says so above its table.
 */
export function renderHtmlReport(report: Report, units: Units): string {
  const size = (bytes: bigint): string =>
    `<span title="${escapeHtml(`${bytes.toString(10)} bytes`)}">${escapeHtml(formatBytes(bytes, units))}</span>`;
  const warnings = reportWarnings(report);
  const sections = includedSections(report);
  const parts: string[] = [];

  parts.push(
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    // A constant of Disktop's own holding no quote, ampersand, or angle
    // bracket, so it is written as it is rather than entity-encoded.
    `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="generator" content="${escapeHtml(`Disktop ${report.version}`)}">`,
    `<title>${escapeHtml(`Disktop report, ${report.generatedAt.toISOString()}`)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    "<header>",
    "<h1>Disktop report</h1>",
    `<p class="meta">Generated ${escapeHtml(report.generatedAt.toISOString())} by Disktop ${escapeHtml(report.version)}. Sizes in ${
      units === "iec" ? "IEC units (1 KiB = 1024 bytes)" : "SI units (1 kB = 1000 bytes)"
    }; hover a size for its exact byte count.</p>`,
    `<p><span class="status ${report.complete ? "complete" : "incomplete"}">${report.complete ? "Complete" : "Incomplete"}</span> ${
      report.complete
        ? "Every section below read everything it covers."
        : `${warnings.length} warning${warnings.length === 1 ? " says" : "s say"} what is missing.`
    } Sections: ${escapeHtml(sections.join(", "))}.</p>`,
    "</header>",
  );

  if (warnings.length > 0) {
    parts.push(...warningList(warnings));
  }

  parts.push(...capacitySection(report, size));
  parts.push(...scanSection(report, size));
  parts.push(...findingsSection(report, size));

  parts.push(
    "<footer>",
    "<p>Made by Disktop from readings on this machine. The page contains no scripts and loads nothing. ",
    "Names are shown with control and direction-changing characters replaced; a name marked &#8224; is shown ",
    "with substitutions, and its exact bytes are in its tooltip and in the JSON and CSV exports.</p>",
    "</footer>",
    "</main>",
    "</body>",
    "</html>",
    "",
  );
  return parts.join("\n");
}

type Size = (bytes: bigint) => string;

/** Paths listed under one kind of warning before the rest are only counted. */
const PATHS_PER_WARNING = 200;

/**
 * Warnings grouped by kind. A scan of `/` as an ordinary user carries
 * hundreds of unreadable directories, and a flat list of them buried
 * everything else; each kind is now one line that opens to its paths.
 */
function warningList(warnings: readonly Warning[]): string[] {
  const groups = new Map<string, Warning[]>();
  for (const warning of warnings) {
    const group = groups.get(warning.code);
    if (group === undefined) {
      groups.set(warning.code, [warning]);
    } else {
      group.push(warning);
    }
  }
  const parts = ['<ul class="warnings">'];
  for (const [code, group] of groups) {
    const first = group[0] as Warning;
    if (group.length === 1) {
      parts.push(
        `<li><strong>${escapeHtml(code)}</strong>: ${escapeHtml(first.message)}${first.path === undefined ? "" : ` (${pathText(first.path)})`}</li>`,
      );
      continue;
    }
    const sameMessage = group.every((warning) => warning.message === first.message);
    parts.push(
      `<li><details><summary><strong>${escapeHtml(code)}</strong> &times; ${group.length}${
        sameMessage ? `: ${escapeHtml(first.message)}` : ""
      }</summary><ul>`,
    );
    for (const warning of group.slice(0, PATHS_PER_WARNING)) {
      const text = sameMessage ? "" : escapeHtml(warning.message);
      const where = warning.path === undefined ? "" : pathText(warning.path);
      parts.push(`<li>${[where, text].filter((part) => part !== "").join(": ")}</li>`);
    }
    if (group.length > PATHS_PER_WARNING) {
      parts.push(`<li class="note">and ${group.length - PATHS_PER_WARNING} more, listed in the JSON and CSV exports</li>`);
    }
    parts.push("</ul></details></li>");
  }
  parts.push("</ul>");
  return parts;
}

function capacitySection(report: Report, size: Size): string[] {
  const { capacity } = report;
  const alerting = new Set(capacity.alerts.filter((alert) => alert.kind === "low-space").map((alert) => alert.filesystemId));
  const inodeAlerting = new Set(capacity.alerts.filter((alert) => alert.kind === "low-inodes").map((alert) => alert.filesystemId));
  const parts = ['<section id="capacity">', "<h2>Capacity</h2>"];
  parts.push(...sectionState(capacity.complete, `${capacity.capability.status}: ${capacity.capability.explanation}`));

  if (capacity.filesystems.length === 0) {
    parts.push('<p class="note">No filesystem could be inspected.</p>');
  } else {
    parts.push(
      '<div class="table-wrap"><table>',
      "<caption>Filesystems, with the share used counted the way df counts it</caption>",
      '<thead><tr><th>Mounted at</th><th>Type</th><th class="num">Size</th><th class="num">Available</th><th>Used</th><th class="num">Inodes used</th><th>Source</th></tr></thead>',
      "<tbody>",
    );
    for (const filesystem of capacity.filesystems) {
      parts.push(filesystemRow(filesystem, size, alerting.has(filesystem.id), inodeAlerting.has(filesystem.id)));
    }
    parts.push("</tbody></table></div>");
  }

  if (capacity.alerts.length > 0) {
    parts.push("<h3>Alerts</h3>", "<ul>");
    for (const alert of capacity.alerts) {
      parts.push(`<li><span class="flag">${escapeHtml(alert.kind)}</span>: ${escapeHtml(alert.message)}</li>`);
    }
    parts.push("</ul>");
  }

  parts.push("<h3>Devices</h3>");
  if (capacity.devices.length === 0) {
    parts.push('<p class="note">No block device could be inspected.</p>');
  } else {
    parts.push(
      '<div class="table-wrap"><table>',
      '<thead><tr><th>Device</th><th>Kind</th><th class="num">Size</th><th>Partitions</th><th>Detail</th></tr></thead>',
      "<tbody>",
    );
    for (const device of capacity.devices) {
      const detail = [device.transport, device.model, device.removable ? "removable" : undefined].filter((part) => part !== undefined).join(", ");
      parts.push(
        `<tr><td>${escapeHtml(device.name)}</td><td>${escapeHtml(device.kind)}</td><td class="num">${size(device.sizeBytes)}</td><td>${escapeHtml(
          device.partitions.join(", ") || "none",
        )}</td><td>${escapeHtml(detail)}</td></tr>`,
      );
    }
    parts.push("</tbody></table></div>");
  }
  if (capacity.unmounted.length > 0) {
    parts.push(
      "<h3>Not mounted</h3>",
      '<div class="table-wrap"><table>',
      "<caption>Partitions holding data, and locked encrypted containers, that nothing has mounted. How full they are is unknown until they are mounted.</caption>",
      '<thead><tr><th>Device</th><th>Type</th><th class="num">Size</th><th>State</th><th>Label</th><th>On disk</th></tr></thead>',
      "<tbody>",
    );
    for (const volume of capacity.unmounted) {
      parts.push(
        `<tr><td class="path">${escapeHtml(volume.devicePath)}</td><td>${escapeHtml(volume.filesystemType)}</td><td class="num">${size(volume.sizeBytes)}</td><td>${
          volume.state === "locked" ? '<span class="flag">encrypted, locked</span>' : "not mounted"
        }</td><td>${escapeHtml(volume.label ?? "")}</td><td>${escapeHtml(volume.deviceId)}</td></tr>`,
      );
    }
    parts.push("</tbody></table></div>");
  }
  parts.push("</section>");
  return parts;
}

function filesystemRow(filesystem: Filesystem, size: Size, alerting: boolean, inodeAlerting: boolean): string {
  const usage = filesystemUsage(filesystem);
  const flags = [
    filesystem.readOnly === true ? "read-only" : undefined,
    filesystem.network ? "network" : undefined,
    filesystem.removable ? "removable" : undefined,
  ].filter((flag) => flag !== undefined);
  const mounts = filesystem.mounts.map(pathText).join("<br>");
  const inodes =
    usage.inodesUsedPercent === undefined
      ? '<span class="note">not reported</span>'
      : `${inodeAlerting ? '<span class="flag">' : ""}${usage.inodesUsedPercent}%${inodeAlerting ? "</span>" : ""}`;
  return [
    "<tr>",
    `<td class="path">${mounts}</td>`,
    `<td>${escapeHtml(filesystem.type)}</td>`,
    `<td class="num">${size(filesystem.totalBytes)}</td>`,
    `<td class="num">${size(filesystem.availableBytes)}</td>`,
    `<td class="nowrap">${bar(usage.usedPercent, alerting)}${usage.usedPercent}%</td>`,
    `<td class="num">${inodes}</td>`,
    `<td>${escapeHtml(filesystem.source)}${flags.length === 0 ? "" : ` <span class="note">(${escapeHtml(flags.join(", "))})</span>`}</td>`,
    "</tr>",
  ].join("");
}

/** A capacity bar drawn with a CSS width; the percentage is an integer Disktop computed. */
function bar(percent: number, alerting: boolean): string {
  const width = Math.min(100, Math.max(0, Math.trunc(percent)));
  return `<span class="bar${alerting ? " alert" : ""}" role="img" aria-label="${width}% used"><span style="width: ${width}%"></span></span>`;
}

function scanSection(report: Report, size: Size): string[] {
  const { scan } = report;
  const parts = ['<section id="scan">', "<h2>Scan</h2>"];
  if (!scan.included) {
    parts.push(`<p class="note">${escapeHtml(scan.reason)}</p>`, "</section>");
    return parts;
  }

  const { snapshot } = scan;
  parts.push(...sectionState(scan.complete));
  parts.push(
    "<dl>",
    `<dt>Path</dt><dd>${pathText(scan.subject)}</dd>`,
    `<dt>Scan of</dt><dd>${snapshot.scope.roots.map(pathText).join("<br>")}</dd>`,
    `<dt>Scanned at</dt><dd>${escapeHtml(snapshot.scannedAt)}</dd>`,
    `<dt>Snapshot</dt><dd>${escapeHtml(snapshot.id)}</dd>`,
    `<dt>Accounting</dt><dd>${escapeHtml(snapshot.scope.accounting)}${
      snapshot.scope.crossFilesystems
        ? ", crossing into nested mounts"
        : snapshot.scope.sameFilesystemMounts === true
          ? ", one filesystem (its other subvolume mounts included)"
          : ", stopping at every mount"
    }${snapshot.scope.maxDepth === undefined ? "" : `, at most ${escapeHtml(snapshot.scope.maxDepth)} levels deep`}</dd>`,
    `<dt>Entries scanned</dt><dd>${escapeHtml(snapshot.completeness.scannedEntries.toString(10))}</dd>`,
    `<dt>Allocated</dt><dd>${size(snapshot.totals.allocatedBytes)} <span class="note">(blocks on disk, whole scan)</span></dd>`,
    `<dt>Apparent</dt><dd>${size(snapshot.totals.apparentBytes)} <span class="note">(the sizes files claim)</span></dd>`,
    `<dt>Shared hardlinks</dt><dd>${size(snapshot.totals.sharedBytes)} <span class="note">(counted once, not added)</span></dd>`,
    `<dt>Unreadable directories</dt><dd>${escapeHtml(snapshot.completeness.inaccessibleDirectories.toString(10))}</dd>`,
  );
  if (snapshot.completeness.excludedMounts.length > 0) {
    parts.push(
      `<dt>Not entered</dt><dd>${snapshot.completeness.excludedMounts.map(pathText).join("<br>")} <span class="note">(other filesystems and excluded paths; not counted)</span></dd>`,
    );
  }
  parts.push("</dl>");

  const skipped = new Set(snapshot.completeness.excludedMounts.map((path) => path.bytesBase64));
  const unentered = (entry: IndexedEntry): string | undefined =>
    entry.kind === "directory" && entry.childEntries === undefined
      ? skipped.has(entry.path.bytesBase64)
        ? "another mount, not scanned"
        : "unreadable, size unknown"
      : undefined;

  parts.push(`<h3>What is inside ${pathText(scan.subject)}</h3>`);
  if (scan.children === undefined) {
    parts.push('<p class="note">The index could not list what is directly inside the path; the warnings above say why.</p>');
  } else if (scan.children.entries.length === 0) {
    parts.push('<p class="note">Nothing directly inside the path is in the scan.</p>');
  } else {
    const whole = scan.children.entries.reduce((sum, entry) => sum + entry.allocatedBytes, 0n);
    parts.push(
      '<div class="table-wrap"><table>',
      `<caption>${
        scan.children.more ? `The ${scan.children.limit} largest of what is directly inside the path` : "Everything directly inside the path"
      }, by allocated bytes. These do not overlap: a directory's size is its whole subtree.</caption>`,
      '<thead><tr><th class="num">Allocated</th><th>Share</th><th class="num">Apparent</th><th>Kind</th><th>Modified</th><th>Name</th></tr></thead>',
      "<tbody>",
    );
    for (const entry of scan.children.entries) {
      const unread = unentered(entry);
      const share = whole === 0n ? 0 : Number((entry.allocatedBytes * 1000n) / whole) / 10;
      parts.push(
        `<tr><td class="num">${unread === undefined ? size(entry.allocatedBytes) : '<span class="note">unknown</span>'}</td><td class="nowrap">${
          unread === undefined ? `${shareBar(share)}${share.toFixed(1)}%` : ""
        }</td><td class="num">${unread === undefined ? size(entry.apparentBytes) : ""}</td><td>${escapeHtml(entry.kind)}</td><td class="nowrap">${modified(entry)}</td><td class="path">${pathText(
          entry.path,
        )}${unread === undefined ? entryNotes(entry) : ` <span class="flag">(${escapeHtml(unread)})</span>`}</td></tr>`,
      );
    }
    parts.push("</tbody></table></div>");
  }

  parts.push("<h3>Largest files</h3>");
  if (scan.largestFiles === undefined) {
    parts.push('<p class="note">The index could not list the largest files; the warnings above say why.</p>');
  } else if (scan.largestFiles.entries.length === 0) {
    parts.push('<p class="note">No regular file under the path is in the scan.</p>');
  } else {
    parts.push(
      '<div class="table-wrap"><table>',
      `<caption>${scan.largestFiles.more ? `The ${scan.largestFiles.limit} largest files under the path` : "Every file under the path"}, by allocated bytes</caption>`,
      '<thead><tr><th class="num">#</th><th class="num">Allocated</th><th class="num">Apparent</th><th>Modified</th><th>Path</th></tr></thead>',
      "<tbody>",
    );
    for (const [position, entry] of scan.largestFiles.entries.entries()) {
      parts.push(
        `<tr><td class="num">${position + 1}</td><td class="num">${size(entry.allocatedBytes)}</td><td class="num">${size(entry.apparentBytes)}</td><td class="nowrap">${modified(
          entry,
        )}</td><td class="path">${pathText(entry.path)}${entryNotes(entry)}</td></tr>`,
      );
    }
    parts.push("</tbody></table></div>");
  }

  if (scan.elevated !== undefined) {
    parts.push(
      "<h3>Unreadable directories, measured as root</h3>",
      `<p class="note">Measured ${escapeHtml(scan.elevated.measuredAt)} by the system's du running read-only as root, after the scan. ${size(
        scan.elevated.totalBytes,
      )} in ${scan.elevated.measurements.length} director${scan.elevated.measurements.length === 1 ? "y" : "ies"}; not added to the totals above, and not in the index.</p>`,
      '<div class="table-wrap"><table>',
      `<thead><tr><th class="num">${scan.elevated.accounting === "apparent" ? "Apparent" : "Allocated"}</th><th>Path</th><th>Largest inside</th></tr></thead>`,
      "<tbody>",
    );
    for (const measurement of scan.elevated.measurements.slice(0, 200)) {
      const inside = measurement.children
        .slice(0, 3)
        .map((child) => `${pathText(child.path)} ${size(child.bytes)}`)
        .join("<br>");
      parts.push(`<tr><td class="num">${size(measurement.bytes)}</td><td class="path">${pathText(measurement.path)}</td><td class="path">${inside}</td></tr>`);
    }
    parts.push("</tbody></table></div>");
  }

  parts.push("<h3>File types</h3>");
  if (scan.typeTotals === undefined) {
    parts.push('<p class="note">The index could not answer, so the totals per file type are missing.</p>');
  } else if (scan.typeTotals.length === 0) {
    parts.push('<p class="note">No regular file under the path.</p>');
  } else {
    parts.push(
      '<div class="table-wrap"><table>',
      "<caption>Regular files under the path, per extension; directories and shared hardlinks are left out</caption>",
      '<thead><tr><th>Extension</th><th class="num">Files</th><th class="num">Allocated</th><th class="num">Apparent</th></tr></thead>',
      "<tbody>",
    );
    for (const total of scan.typeTotals) {
      parts.push(
        `<tr><td>${total.extension === "" ? '<span class="note">(none)</span>' : escapeHtml(`.${total.extension}`)}</td><td class="num">${escapeHtml(
          total.entries.toString(10),
        )}</td><td class="num">${size(total.allocatedBytes)}</td><td class="num">${size(total.apparentBytes)}</td></tr>`,
      );
    }
    parts.push("</tbody></table></div>");
  }
  parts.push("</section>");
  return parts;
}

function findingsSection(report: Report, size: Size): string[] {
  const { findings } = report;
  const parts = ['<section id="findings">', "<h2>Findings</h2>"];
  if (!findings.included) {
    parts.push(`<p class="note">${escapeHtml(findings.reason)}</p>`, "</section>");
    return parts;
  }

  const { summary } = findings;
  parts.push(...sectionState(findings.complete, summary.capability.explanation));
  if (!summary.measured) {
    parts.push('<p class="note">Directory footprints could not be measured, so sizes nothing else reported are unknown.</p>');
  }
  if (summary.findings.length === 0) {
    parts.push('<p class="note">No detector found anything.</p>');
  } else {
    parts.push(
      '<div class="table-wrap"><table>',
      "<caption>What the detectors found. Nothing here was changed; acting on a finding is 'disktop clean plan'.</caption>",
      '<thead><tr><th class="num">Size</th><th>Measured as</th><th>Category</th><th>What</th><th>Paths</th><th>Actions</th></tr></thead>',
      "<tbody>",
    );
    for (const finding of summary.findings) {
      const notes = [finding.active ? "in use" : undefined, finding.confidence === "observed" ? undefined : finding.confidence].filter(
        (note) => note !== undefined,
      );
      const paths =
        finding.paths.length === 0
          ? finding.managerScope === undefined
            ? '<span class="note">none</span>'
            : `<span class="note">${escapeHtml(finding.managerScope)}</span>`
          : finding.paths.map(pathText).join("<br>");
      parts.push(
        `<tr><td class="num">${finding.size.bytes === undefined ? "unknown" : size(finding.size.bytes)}</td><td class="nowrap" title="${escapeHtml(
          finding.size.explanation,
        )}">${escapeHtml(finding.size.basis)}</td><td class="nowrap">${escapeHtml(finding.category)}</td><td>${escapeHtml(finding.title)}${
          notes.length === 0 ? "" : ` <span class="flag">(${escapeHtml(notes.join(", "))})</span>`
        }</td><td class="path">${paths}</td><td>${escapeHtml(
          finding.availableActionIds.length === 0 ? "none" : finding.availableActionIds.join(", "),
        )}</td></tr>`,
      );
    }
    parts.push("</tbody></table></div>");
  }

  if (summary.categoryTotals.length > 0) {
    parts.push(
      "<h3>Per category</h3>",
      '<div class="table-wrap"><table>',
      "<caption>Bytes per category, each byte counted once; an unmeasured finding adds nothing</caption>",
      '<thead><tr><th>Category</th><th class="num">Findings</th><th class="num">Bytes</th><th class="num">Unmeasured</th><th class="num">Inside another</th></tr></thead>',
      "<tbody>",
    );
    for (const total of summary.categoryTotals) {
      parts.push(
        `<tr><td>${escapeHtml(total.category)}</td><td class="num">${total.findings}</td><td class="num">${size(total.bytes)}</td><td class="num">${
          total.unmeasured
        }</td><td class="num">${total.nested}</td></tr>`,
      );
    }
    parts.push("</tbody></table></div>");
  }

  parts.push(
    "<h3>Detectors</h3>",
    '<div class="table-wrap"><table>',
    "<caption>Every detector that was asked, including the ones that could not look</caption>",
    '<thead><tr><th>Detector</th><th>Capability</th><th>Ran</th><th class="num">Findings</th><th>Explanation</th></tr></thead>',
    "<tbody>",
  );
  for (const provider of summary.providers) {
    parts.push(
      `<tr><td>${escapeHtml(provider.providerId)}</td><td${provider.capability.status === "available" ? "" : ' class="flag"'}>${escapeHtml(
        provider.capability.status,
      )}</td><td>${provider.ran ? "yes" : "no"}${provider.complete ? "" : ", incomplete"}</td><td class="num">${provider.findings}</td><td>${escapeHtml(
        provider.capability.explanation,
      )}</td></tr>`,
    );
  }
  parts.push("</tbody></table></div>", "</section>");
  return parts;
}

function modified(entry: IndexedEntry): string {
  return escapeHtml(instantFromNanoseconds(entry.modifiedNanoseconds)?.slice(0, 10) ?? "unknown");
}

function entryNotes(entry: IndexedEntry): string {
  const notes = [entry.shared ? "shared hardlink, counted under another path" : undefined, entry.broken === true ? "broken symlink" : undefined].filter(
    (note) => note !== undefined,
  );
  return notes.length === 0 ? "" : ` <span class="note">(${escapeHtml(notes.join("; "))})</span>`;
}

/** A share-of-the-whole bar, drawn like the capacity bars. */
function shareBar(percent: number): string {
  const width = Math.min(100, Math.max(0, Math.round(percent)));
  return `<span class="bar" role="img" aria-label="${width}% of the path"><span style="width: ${width}%"></span></span>`;
}

function sectionState(complete: boolean, explanation?: string): string[] {
  return [
    `<p><span class="status ${complete ? "complete" : "incomplete"}">${complete ? "Complete" : "Incomplete"}</span>${
      explanation === undefined ? "" : ` <span class="note">${escapeHtml(explanation)}</span>`
    }</p>`,
  ];
}

/**
 * A path as a reader sees it. When the display form is not the exact name —
 * it was not valid UTF-8, or it held a character that had to be replaced —
 * it is marked, and its raw bytes are in the tooltip, because two different
 * names can be shown the same.
 */
function pathText(path: RawPath): string {
  if (path.utf8 !== undefined && path.utf8 === path.display) {
    return escapeHtml(path.display);
  }
  return `<span title="${escapeHtml(`Shown with substitutions. Raw bytes, base64: ${path.bytesBase64}`)}">${escapeHtml(path.display)}&#8224;</span>`;
}
