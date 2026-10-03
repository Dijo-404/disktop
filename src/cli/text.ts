import type { OwnerShare } from "../application/explore.js";
import { describeCommand, type ManagerScope } from "../domain/managers.js";
import type { Alert, Filesystem, IndexedEntry, StorageDevice, Warning } from "../domain/models.js";
import type { DecidedGroup } from "../application/duplicates.js";
import type { ScanSummary } from "../application/scan.js";
import type { SnapshotDiff } from "../application/snapshots.js";
import type { FootprintSummary, ProviderReport } from "../application/footprint.js";
import type { TypeTotal } from "../ports/scan.js";
import type { ActionPlan, ActionResult } from "../domain/actions.js";
import type { JournalRecord } from "../ports/actions.js";
import type { SnapshotSummary } from "../ports/snapshots.js";
import { sanitizeForDisplay } from "../domain/paths.js";
import { formatBytes, usedPercentOfInodes, usedPercentOfSpace } from "../domain/sizes.js";

export type Units = "iec" | "si";

/** A fixed-width capacity table that still reads at 80 columns. */
export function filesystemLines(filesystems: readonly Filesystem[], units: Units): string[] {
  if (filesystems.length === 0) {
    return ["No filesystems could be inspected."];
  }

  const rows = filesystems.map((filesystem) => ({
    mount: filesystem.mounts.map((mount) => mount.display).join(", "),
    type: filesystem.type,
    size: formatBytes(filesystem.totalBytes, units),
    available: formatBytes(filesystem.availableBytes, units),
    used: `${usedPercentOfSpace(filesystem.totalBytes, filesystem.freeBytes, filesystem.availableBytes)}%`,
    inodes:
      filesystem.totalInodes === undefined || filesystem.freeInodes === undefined
        ? "-"
        : `${usedPercentOfInodes(filesystem.totalInodes, filesystem.freeInodes)}%`,
  }));

  const mountWidth = Math.max(11, ...rows.map((row) => row.mount.length));
  const typeWidth = Math.max(4, ...rows.map((row) => row.type.length));
  const header = `${"Mount".padEnd(mountWidth)}  ${"Type".padEnd(typeWidth)}  ${"Size".padStart(10)}  ${"Available".padStart(10)}  ${"Used".padStart(5)}  ${"Inodes".padStart(6)}`;

  return [
    header,
    ...rows.map(
      (row) =>
        `${row.mount.padEnd(mountWidth)}  ${row.type.padEnd(typeWidth)}  ${row.size.padStart(10)}  ${row.available.padStart(10)}  ${row.used.padStart(5)}  ${row.inodes.padStart(6)}`,
    ),
  ];
}

export function deviceLines(devices: readonly StorageDevice[], units: Units): string[] {
  if (devices.length === 0) {
    return ["No block devices could be inspected."];
  }

  const rows = devices.map((device) => ({
    name: device.name,
    kind: device.kind,
    size: formatBytes(device.sizeBytes, units),
    detail: [device.transport, device.model, device.removable ? "removable" : undefined].filter((part) => part !== undefined).join(" "),
    partitions: String(device.partitions.length),
  }));

  const nameWidth = Math.max(6, ...rows.map((row) => row.name.length));
  return [
    `${"Device".padEnd(nameWidth)}  ${"Kind".padEnd(7)}  ${"Size".padStart(10)}  ${"Parts".padStart(5)}  Detail`,
    ...rows.map((row) => `${row.name.padEnd(nameWidth)}  ${row.kind.padEnd(7)}  ${row.size.padStart(10)}  ${row.partitions.padStart(5)}  ${row.detail}`),
  ];
}

export function alertLines(alerts: readonly Alert[]): string[] {
  return alerts.map((alert) => `[${alert.kind}] ${alert.message}`);
}

/** Warnings go to stderr so a redirected stdout still holds only the answer. */
/**
 * Text that did not come from Disktop, made safe to print.
 *
 * Most of what reaches this file is already a `RawPath.display`, which is
 * sanitized where the bytes are decoded. The exceptions are the places a
 * filename or a line of configuration gets interpolated into a sentence —
 * a warning the helper wrote about a file it could not open, a finding's title
 * built from a rule's name. A terminal reading an escape sequence out of one of
 * those does what the sequence says, which for `ESC[2J` is to erase everything
 * the person was reading.
 */
function safeLine(value: string): string {
  return sanitizeForDisplay(new Uint8Array(Buffer.from(value, "utf8")));
}

export function warningLines(warnings: readonly Warning[]): string[] {
  return warnings.map((warning) => `warning: ${warning.code}: ${safeLine(warning.message)}`);
}

/** What one finished or partial scan measured, at 80 columns. */
export function scanLines(summary: ScanSummary, snapshotId: string, units: Units): string[] {
  const totals = summary.totals;
  const lines = [
    `Scanned ${summary.roots.map((root) => root.display).join(", ")}`,
    `  entries          ${summary.completeness.scannedEntries}`,
    `  allocated        ${formatBytes(totals.allocatedBytes, units)}`,
    `  apparent         ${formatBytes(totals.apparentBytes, units)}`,
  ];
  if (totals.sharedBytes > 0n) {
    lines.push(`  shared hardlinks ${formatBytes(totals.sharedBytes, units)} (counted once, under the first path seen)`);
  }
  if (summary.completeness.inaccessibleDirectories > 0n) {
    lines.push(`  unreadable dirs  ${summary.completeness.inaccessibleDirectories}`);
  }
  lines.push(
    `  accounting       ${summary.accounting}`,
    summary.completeness.complete ? "  result           complete" : "  result           incomplete, see the warnings below",
    `  snapshot         ${snapshotId}`,
  );
  return lines;
}

/** Largest first by default; the ranking column is named in the header. */
export function entryLines(entries: readonly IndexedEntry[], units: Units, accounting: "allocated" | "apparent"): string[] {
  if (entries.length === 0) {
    return ["No entries matched."];
  }
  const rows = entries.map((entry) => ({
    size: formatBytes(accounting === "apparent" ? entry.apparentBytes : entry.allocatedBytes, units),
    kind: entry.kind === "directory" ? "dir" : entry.kind === "symlink" ? "link" : entry.kind === "file" ? "file" : "other",
    note: entry.shared ? " (shared hardlink)" : "",
    path: entry.path.display,
  }));
  const sizeWidth = Math.max(9, ...rows.map((row) => row.size.length));

  return [
    `${`Size (${accounting})`.padStart(sizeWidth)}  Kind  Path`,
    ...rows.map((row) => `${row.size.padStart(sizeWidth)}  ${row.kind.padEnd(4)}  ${row.path}${row.note}`),
  ];
}

/**
 * Duplicate groups as a person reads them.
 *
 * Each group names the copy that would survive and why, then the copies the
 * rule would act on. A group the rule could not decide shows its reason and no
 * keeper: there is nothing to act on there and pretending otherwise is how the
 * wrong file goes.
 */
export function duplicateLines(
  groups: readonly DecidedGroup[],
  reclaimableBytes: bigint,
  units: Units,
): string[] {
  if (groups.length === 0) {
    return ["No duplicate files matched."];
  }

  const lines: string[] = [
    `${groups.length} ${groups.length === 1 ? "group" : "groups"} of identical files; removing the copies below would free ${formatBytes(reclaimableBytes, units)}.`,
  ];
  for (const [position, decided] of groups.entries()) {
    const size = formatBytes(decided.group.apparentBytes, units);
    lines.push(`${position + 1}. ${size} each, ${decided.group.files.length} copies`);
    if (decided.decision.kind === "undecidable") {
      lines.push(`     undecided: ${decided.decision.reason}`);
      for (const file of decided.group.files) {
        lines.push(`       ?  ${file.path.display}`);
      }
      continue;
    }
    lines.push(`     keep: ${decided.decision.kept.path.display}`);
    lines.push(`     because ${decided.decision.basis}`);
    for (const other of decided.decision.others) {
      lines.push(`       -  ${other.path.display}`);
    }
  }
  return lines;
}

export function ownerLines(owners: readonly OwnerShare[], units: Units): string[] {
  return owners.map(
    (owner) =>
      `${formatBytes(owner.allocatedBytes, units).padStart(12)}  ${String(owner.entries).padStart(10)} files  ${
        owner.name === undefined ? `user ${owner.ownerId}` : `${safeLine(owner.name)} (${owner.ownerId})`
      }`,
  );
}

export function typeTotalLines(totals: readonly TypeTotal[], units: Units): string[] {
  if (totals.length === 0) {
    return ["No file types to total."];
  }
  const rows = totals.map((total) => ({
    extension: total.extension === "" ? "(none)" : `.${total.extension}`,
    files: total.entries.toString(),
    size: formatBytes(total.allocatedBytes, units),
  }));
  const extensionWidth = Math.max(9, ...rows.map((row) => row.extension.length));

  return [
    `${"Extension".padEnd(extensionWidth)}  ${"Files".padStart(9)}  ${"Allocated".padStart(10)}`,
    ...rows.map((row) => `${row.extension.padEnd(extensionWidth)}  ${row.files.padStart(9)}  ${row.size.padStart(10)}`),
  ];
}

export function snapshotLines(snapshots: readonly SnapshotSummary[], units: Units): string[] {
  if (snapshots.length === 0) {
    return ["No snapshots are stored yet. Run 'disktop scan PATH' to record one."];
  }
  const rows = snapshots.map((snapshot) => ({
    id: snapshot.id,
    when: snapshot.scannedAt,
    size: formatBytes(snapshot.totals.allocatedBytes, units),
    scope: `${snapshot.scope.accounting}, ${snapshot.scope.roots.map((root) => root.display).join(", ")}`,
    note: snapshot.completeness.complete ? "" : "  (incomplete)",
  }));
  const idWidth = Math.max(2, ...rows.map((row) => row.id.length));

  return [
    `${"ID".padEnd(idWidth)}  ${"Scanned at".padEnd(24)}  ${"Allocated".padStart(10)}  Scope`,
    ...rows.map((row) => `${row.id.padEnd(idWidth)}  ${row.when.padEnd(24)}  ${row.size.padStart(10)}  ${row.scope}${row.note}`),
  ];
}

/** Growth between two snapshots, largest movement first, signed. */
export function diffLines(diff: SnapshotDiff, units: Units): string[] {
  const sign = (value: bigint): string => (value > 0n ? "+" : value < 0n ? "-" : " ");
  const magnitude = (value: bigint): bigint => (value < 0n ? -value : value);

  const lines = [
    `${diff.earlier.id} -> ${diff.later.id}`,
    `Total ${sign(diff.totalDeltaBytes)}${formatBytes(magnitude(diff.totalDeltaBytes), units)}`,
    "",
  ];
  if (diff.directories.length === 0) {
    lines.push("No directory in either snapshot changed.");
    return lines;
  }

  const rows = diff.directories.map((change) => ({
    delta: `${sign(change.deltaBytes)}${formatBytes(magnitude(change.deltaBytes), units)}`,
    kind: change.kind,
    path: change.path.display,
  }));
  const deltaWidth = Math.max(6, ...rows.map((row) => row.delta.length));
  const kindWidth = Math.max(7, ...rows.map((row) => row.kind.length));

  lines.push(`${"Change".padStart(deltaWidth)}  ${"State".padEnd(kindWidth)}  Path`);
  for (const row of rows) {
    lines.push(`${row.delta.padStart(deltaWidth)}  ${row.kind.padEnd(kindWidth)}  ${row.path}`);
  }
  return lines;
}

/**
 * What the detectors found, grouped by category and widest first.
 *
 * A finding nothing measured prints `unknown` rather than a number, and data
 * that is in use is marked, so a Firefox profile is never read off the screen
 * as a cache that can go.
 */
export function findingLines(summary: FootprintSummary, units: Units): string[] {
  if (summary.findings.length === 0) {
    return ["No detector found anything. Run 'disktop scan ~' first if no scan covers your home directory."];
  }

  const rows = summary.findings.map((finding) => ({
    size: finding.size.bytes === undefined ? "unknown" : formatBytes(finding.size.bytes, units),
    category: finding.category,
    title: safeLine(finding.title),
    note: [
      finding.active ? "in use" : undefined,
      finding.confidence === "observed" ? undefined : finding.confidence,
      finding.availableActionIds.length === 0 ? "no action" : finding.availableActionIds.join("/"),
    ]
      .filter((part) => part !== undefined)
      .join(", "),
  }));

  const sizeWidth = Math.max(7, ...rows.map((row) => row.size.length));
  const categoryWidth = Math.max(8, ...rows.map((row) => row.category.length));
  const lines = [
    `${"Size".padStart(sizeWidth)}  ${"Category".padEnd(categoryWidth)}  What`,
    ...rows.map((row) => `${row.size.padStart(sizeWidth)}  ${row.category.padEnd(categoryWidth)}  ${row.title} (${row.note})`),
    "",
  ];

  for (const total of summary.categoryTotals) {
    const notes = [
      total.unmeasured === 0 ? undefined : `${total.unmeasured} unmeasured`,
      total.nested === 0 ? undefined : `${total.nested} inside another, counted once`,
    ].filter((note) => note !== undefined);
    const suffix = notes.length === 0 ? "" : `, ${notes.join(", ")}`;
    lines.push(`${total.category}: ${formatBytes(total.bytes, units)} across ${total.findings} findings${suffix}`);
  }
  if (!summary.measured) {
    lines.push(
      "Directory footprints were not measured. Any size above comes from a package manager or one stat call; everything else is unknown.",
    );
  }
  return lines;
}

/** The detectors that did not answer, with the reason, on stderr. */
export function providerLines(reports: readonly ProviderReport[]): string[] {
  return reports
    .filter((report) => !report.ran)
    .map((report) => `${report.providerId}: ${report.capability.status}: ${safeLine(report.capability.explanation)}`);
}

/**
 * A plan, read before anybody agrees to it.
 *
 * Scope, totals, reversibility, and every warning come before the command that
 * would carry it out, because somebody skimming this has to be able to stop.
 */
function operationVerb(operation: ActionPlan["operation"]): string {
  switch (operation) {
    case "trash":
      return "Move to Trash";
    case "empty-trash":
      return "Empty Trash";
    case "move":
      return "Copy to another disk";
    case "compress":
      return "Compress";
    case "dedup-hardlink":
      return "Replace with a hardlink";
    case "manager":
      return "Ask the package manager to clean up";
    default:
      return "Remove permanently";
  }
}

const SHOWN_COMMANDS = 5;

function managerLines(scope: ManagerScope, units: Units): string[] {
  const lines: string[] = [];
  const count =
    scope.count.kind === "unknown"
      ? "unknown: the manager decides what goes"
      : `${scope.count.kind === "exact" ? "exactly" : "about"} ${scope.count.value} item(s)`;
  lines.push(`  Items: ${count}`);
  lines.push(
    `  Estimated: ${scope.estimatedBytes === undefined ? "unknown" : formatBytes(scope.estimatedBytes, units)}`,
  );
  lines.push(
    scope.privilege === "root"
      ? "  Needs: administrator rights, asked for through sudo or pkexec for these commands only"
      : "  Needs: nothing beyond your own account",
  );
  for (const command of scope.commands.slice(0, SHOWN_COMMANDS)) {
    lines.push(`  Runs: ${describeCommand(command, scope.privilege)}`);
  }
  if (scope.commands.length > SHOWN_COMMANDS) {
    lines.push(`  Runs: and ${scope.commands.length - SHOWN_COMMANDS} more of the same, one per item`);
  }
  return lines;
}

export function planLines(plan: ActionPlan, units: Units): string[] {
  const lines = [
    `Plan ${plan.id}`,
    `  ${operationVerb(plan.operation)}: ${plan.scopeSummary}`,
    `  Selected: ${
      plan.selectedBytes === undefined ? "unknown until the manager runs" : formatBytes(plan.selectedBytes, units)
    }${plan.exactItemCount === undefined ? "" : ` across ${plan.exactItemCount} reviewed item(s)`}`,
    `  Reversible: ${plan.reversibility === "undo-from-trash" ? "yes, with 'disktop undo'" : "no"}`,
    `  Expires: ${plan.expiresAt}`,
  ];
  if (plan.manager !== undefined) {
    lines.push(...managerLines(plan.manager, units));
  }
  if (plan.keepPath !== undefined) {
    lines.push(`  Keeps: ${plan.keepPath.display}`);
    lines.push("  Every other file listed becomes a second name for that one.");
  }
  if (plan.destination !== undefined) {
    lines.push(`  Publishes into: ${plan.destination.display}`);
  }
  if (plan.sourceDisposition !== undefined) {
    lines.push(
      `  Then the source: ${
        plan.sourceDisposition === "trash"
          ? "goes to Trash, so it can be put back"
          : "is removed permanently, so it cannot"
      }`,
    );
  }
  if (plan.regenerationCost !== undefined) {
    lines.push(`  If you need it back: ${plan.regenerationCost}`);
  }
  for (const warning of plan.warnings) {
    lines.push(`  ! ${safeLine(warning)}`);
  }
  lines.push(
    "",
    `Apply it with: disktop clean apply ${plan.id} --yes${
      plan.reversibility === "irreversible" ? " --permanent" : ""
    }`,
  );
  return lines;
}

/**
 * What an action did, with the three numbers kept apart.
 *
 * Bytes moved to Trash is not space anybody got back, and the observed change
 * is not this action's doing alone. Printing them on one line as a single
 * figure would be the one lie this whole pipeline exists to avoid.
 */
export function resultLines(
  result: ActionResult,
  observedFreeSpaceChange: bigint | undefined,
  notes: readonly string[],
  units: Units,
): string[] {
  const lines = [
    `${result.completed} completed, ${result.skipped} skipped, ${result.failed} failed (${result.state})`,
    `  Selected:            ${result.selectedBytes === undefined ? "unknown" : formatBytes(result.selectedBytes, units)}`,
    `  Moved to Trash:      ${formatBytes(result.bytesMovedToTrash, units)}`,
    `  Free space changed:  ${
      observedFreeSpaceChange === undefined
        ? "not readable"
        : formatBytes(observedFreeSpaceChange, units)
    }`,
    `  Journal record:      ${result.journalId}`,
  ];
  if (result.undoAvailable) {
    lines.push(`  Undo it with: disktop undo ${result.journalId} --yes`);
  }
  // Only the checks that did not pass are printed. A reader does not need to
  // be told what was fine; they need to be told what was not, and what nobody
  // could tell either way.
  for (const check of result.verification) {
    if (check.outcome !== "passed") {
      lines.push(`  ${check.outcome === "failed" ? "!" : "?"} ${check.detail}`);
    }
  }
  for (const note of notes) {
    lines.push(`  note: ${note}`);
  }
  return lines;
}

export function historyLines(records: readonly JournalRecord[], units: Units): string[] {
  if (records.length === 0) {
    return ["Disktop has not changed anything on this machine."];
  }
  return records.map((record) => {
    // A move or a compress that trashed its source is undoable in exactly the
    // way a Trash action is; one that removed the source permanently left no
    // item with a destination, which is what says so.
    const restorable =
      ["trash", "copy-move", "compress"].includes(record.operation) &&
      record.items.some((item) => item.outcome === "completed" && item.destination !== undefined);
    const undo = restorable && record.state !== "uncertain" ? "  undo available" : "";
    return `${record.startedAt}  ${record.operation.padEnd(12)} ${record.state.padEnd(10)} ${formatBytes(
      record.bytesMovedToTrash,
      units,
    ).padStart(12)} to Trash  ${record.id}${undo}`;
  });
}
