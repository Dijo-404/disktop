import { describeCommand, type ManagerScope } from "../domain/managers.js";
import type { Alert, Capability, Filesystem, IndexedEntry, RawPath, ScanCompleteness, StorageDevice, UnmountedVolume, Warning } from "../domain/models.js";
import type { ScanTotals, TypeTotal } from "../ports/scan.js";
import type { SnapshotSummary } from "../ports/snapshots.js";
import type { DirectoryChange } from "../application/snapshots.js";
import type { ElevatedOutcome } from "../application/elevated.js";
import type { ProviderReport } from "../application/footprint.js";
import type { CategoryTotal, Finding, FindingSize } from "../domain/findings.js";
import { decimalBytes } from "../domain/sizes.js";
import type { OperationFailure } from "../domain/errors.js";
import type { ActionPlan, ActionResult } from "../domain/actions.js";
import type { JournalRecord } from "../ports/actions.js";

export const SCHEMA_VERSION = "1";

export type EnvelopeStatus = "complete" | "incomplete" | "error";

/** Exit status, fixed by `docs/cli.md` and the CLI v1 envelope schema. */
export const EXIT = {
  complete: 0,
  alertThresholdReached: 1,
  operationalError: 2,
  incomplete: 3,
  interrupted: 130,
} as const;

export interface Envelope {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly command: string;
  readonly generatedAt: string;
  readonly status: EnvelopeStatus;
  readonly exitCode: number;
  readonly warnings?: readonly unknown[];
  readonly data?: Readonly<Record<string, unknown>>;
  readonly error?: Readonly<Record<string, unknown>>;
}

export interface EnvelopeInput {
  readonly command: string;
  readonly generatedAt: Date;
  readonly status: EnvelopeStatus;
  readonly exitCode: number;
  readonly warnings: readonly Warning[];
  readonly data?: Readonly<Record<string, unknown>>;
  readonly failure?: OperationFailure;
}

/**
 * Build the one object a `--json` command writes to stdout.
 *
 * An incomplete result must carry at least one warning: a short answer that
 * does not say what it missed is indistinguishable from a complete one.
 */
export function buildEnvelope(input: EnvelopeInput): Envelope {
  const warnings = input.warnings.map(encodeWarning);
  const base = {
    schemaVersion: SCHEMA_VERSION,
    command: input.command,
    generatedAt: input.generatedAt.toISOString(),
    status: input.status,
    exitCode: input.exitCode,
    ...(warnings.length > 0 ? { warnings } : {}),
  } as const;

  if (input.status === "error") {
    return { ...base, error: encodeFailure(input.failure ?? { code: "internal-error", message: "The command failed without a reason." }) };
  }
  return { ...base, data: input.data ?? {} };
}

export function encodeRawPath(path: RawPath): Record<string, unknown> {
  return {
    bytesBase64: path.bytesBase64,
    display: path.display,
    ...(path.utf8 === undefined ? {} : { utf8: path.utf8 }),
  };
}

export function encodeWarning(warning: Warning): Record<string, unknown> {
  return {
    code: warning.code,
    message: warning.message,
    ...(warning.path === undefined ? {} : { path: encodeRawPath(warning.path) }),
  };
}

export function encodeCapability(capability: Capability): Record<string, unknown> {
  return { status: capability.status, explanation: capability.explanation };
}

export function encodeFailure(failure: OperationFailure): Record<string, unknown> {
  return {
    code: failure.code,
    message: failure.message,
    ...(failure.details === undefined ? {} : { details: failure.details }),
  };
}

export function encodeFilesystem(filesystem: Filesystem): Record<string, unknown> {
  return {
    id: filesystem.id,
    type: filesystem.type,
    source: filesystem.source,
    mounts: filesystem.mounts.map(encodeRawPath),
    totalBytes: decimalBytes(filesystem.totalBytes),
    freeBytes: decimalBytes(filesystem.freeBytes),
    availableBytes: decimalBytes(filesystem.availableBytes),
    ...(filesystem.totalInodes === undefined ? {} : { totalInodes: decimalBytes(filesystem.totalInodes) }),
    ...(filesystem.freeInodes === undefined ? {} : { freeInodes: decimalBytes(filesystem.freeInodes) }),
    network: filesystem.network,
    removable: filesystem.removable,
    ...(filesystem.readOnly === undefined ? {} : { readOnly: filesystem.readOnly }),
    ...(filesystem.deviceId === undefined ? {} : { deviceId: filesystem.deviceId }),
  };
}

export function encodeDevice(device: StorageDevice): Record<string, unknown> {
  return {
    id: device.id,
    name: device.name,
    kind: device.kind,
    removable: device.removable,
    sizeBytes: decimalBytes(device.sizeBytes),
    ...(device.model === undefined ? {} : { model: device.model }),
    ...(device.transport === undefined ? {} : { transport: device.transport }),
    partitions: [...device.partitions],
  };
}

/** What `--sudo` found, in the shape `common.json#/$defs/elevatedMeasurement` describes. */
export function encodeElevated(outcome: ElevatedOutcome): Record<string, unknown> {
  switch (outcome.kind) {
    case "nothing-unreadable":
      return { status: "nothing-unreadable", explanation: "The scan read every directory it reached." };
    case "denied":
      return { status: "denied", explanation: outcome.explanation };
    case "unavailable":
      return { status: "unavailable", explanation: outcome.capability.explanation };
    case "measured": {
      const record = outcome.record;
      const largest = [...record.measurements].sort((left, right) => (left.bytes === right.bytes ? 0 : left.bytes > right.bytes ? -1 : 1));
      return {
        status: "measured",
        accounting: record.accounting,
        measuredAt: record.measuredAt,
        directories: String(record.measurements.length),
        bytes: decimalBytes(outcome.totalBytes),
        skipped: String(record.skipped.length),
        more: outcome.more,
        largest: largest.slice(0, 20).map((measurement) => ({ path: encodeRawPath(measurement.path), bytes: decimalBytes(measurement.bytes) })),
      };
    }
  }
}

export function encodeUnmountedVolume(volume: UnmountedVolume): Record<string, unknown> {
  return {
    id: volume.id,
    devicePath: volume.devicePath,
    deviceId: volume.deviceId,
    sizeBytes: decimalBytes(volume.sizeBytes),
    filesystemType: volume.filesystemType,
    ...(volume.label === undefined ? {} : { label: volume.label }),
    state: volume.state,
  };
}

export function encodeAlert(alert: Alert): Record<string, unknown> {
  return {
    filesystemId: alert.filesystemId,
    kind: alert.kind,
    usedPercent: alert.usedPercent,
    thresholdPercent: alert.thresholdPercent,
    message: alert.message,
  };
}

/** Structured output is one line on stdout; progress and diagnostics are stderr's job. */
export function writeEnvelope(write: (message: string) => void, envelope: Envelope): void {
  write(`${JSON.stringify(envelope, null, 2)}\n`);
}

export function encodeCompleteness(completeness: ScanCompleteness): Record<string, unknown> {
  return {
    complete: completeness.complete,
    scannedEntries: decimalBytes(completeness.scannedEntries),
    inaccessibleDirectories: decimalBytes(completeness.inaccessibleDirectories),
    excludedMounts: completeness.excludedMounts.map(encodeRawPath),
  };
}

export function encodeScanTotals(totals: ScanTotals): Record<string, unknown> {
  return {
    allocatedBytes: decimalBytes(totals.allocatedBytes),
    apparentBytes: decimalBytes(totals.apparentBytes),
    sharedBytes: decimalBytes(totals.sharedBytes),
  };
}

export function encodeIndexedEntry(entry: IndexedEntry): Record<string, unknown> {
  return {
    id: entry.id,
    ...(entry.parentId === undefined ? {} : { parentId: entry.parentId }),
    path: encodeRawPath(entry.path),
    kind: entry.kind,
    device: decimalBytes(entry.device),
    inode: decimalBytes(entry.inode),
    mountId: entry.mountId,
    linkCount: decimalBytes(entry.linkCount),
    apparentBytes: decimalBytes(entry.apparentBytes),
    allocatedBytes: decimalBytes(entry.allocatedBytes),
    ownerId: decimalBytes(entry.ownerId),
    modifiedNanoseconds: decimalBytes(entry.modifiedNanoseconds),
    shared: entry.shared,
    ...(entry.childEntries === undefined ? {} : { childEntries: decimalBytes(entry.childEntries) }),
    ...(entry.broken === undefined ? {} : { broken: entry.broken }),
  };
}

export function encodeTypeTotal(total: TypeTotal): Record<string, unknown> {
  return {
    extension: total.extension,
    entries: decimalBytes(total.entries),
    allocatedBytes: decimalBytes(total.allocatedBytes),
    apparentBytes: decimalBytes(total.apparentBytes),
  };
}

export function encodeSnapshot(snapshot: SnapshotSummary): Record<string, unknown> {
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
    },
    totals: encodeScanTotals(snapshot.totals),
    completeness: encodeCompleteness(snapshot.completeness),
    directories: snapshot.directories.map((entry) => ({
      path: encodeRawPath(entry.path),
      allocatedBytes: decimalBytes(entry.allocatedBytes),
      apparentBytes: decimalBytes(entry.apparentBytes),
    })),
  };
}

/** A signed delta: the caller never has to infer direction from two totals. */
export function encodeDirectoryChange(change: DirectoryChange): Record<string, unknown> {
  return {
    path: encodeRawPath(change.path),
    kind: change.kind,
    earlierBytes: decimalBytes(change.earlierBytes),
    laterBytes: decimalBytes(change.laterBytes),
    deltaBytes: change.deltaBytes.toString(10),
  };
}

export function encodeFindingSize(size: FindingSize): Record<string, unknown> {
  return {
    ...(size.bytes === undefined ? {} : { bytes: decimalBytes(size.bytes) }),
    basis: size.basis,
    explanation: size.explanation,
  };
}

export function encodeFinding(finding: Finding): Record<string, unknown> {
  return {
    id: finding.id,
    providerId: finding.providerId,
    providerVersion: finding.providerVersion,
    category: finding.category,
    title: finding.title,
    evidence: [...finding.evidence],
    paths: finding.paths.map(encodeRawPath),
    ...(finding.managerScope === undefined ? {} : { managerScope: finding.managerScope }),
    ...(finding.managerAction === undefined ? {} : { managerAction: finding.managerAction }),
    size: encodeFindingSize(finding.size),
    confidence: finding.confidence,
    capability: encodeCapability(finding.capability),
    availableActionIds: [...finding.availableActionIds],
    ...(finding.regenerationCost === undefined ? {} : { regenerationCost: finding.regenerationCost }),
    active: finding.active,
  };
}

export function encodeProviderReport(report: ProviderReport): Record<string, unknown> {
  return {
    providerId: report.providerId,
    version: report.version,
    capability: encodeCapability(report.capability),
    findings: report.findings,
    complete: report.complete,
    ran: report.ran,
  };
}

export function encodeCategoryTotal(total: CategoryTotal): Record<string, unknown> {
  return {
    category: total.category,
    findings: total.findings,
    bytes: decimalBytes(total.bytes),
    unmeasured: total.unmeasured,
    nested: total.nested,
  };
}

export function encodeManagerScope(scope: ManagerScope): Record<string, unknown> {
  return {
    action: scope.action,
    adapter: scope.adapter,
    privilege: scope.privilege,
    parameters: { ...scope.parameters },
    items: scope.items.map((item) => ({
      id: item.id,
      ...(item.bytes === undefined ? {} : { bytes: decimalBytes(item.bytes) }),
    })),
    commands: scope.commands.map((command) => ({
      tool: command.tool,
      arguments: [...command.arguments],
      display: describeCommand(command, scope.privilege),
    })),
    perItem: scope.perItem,
    count:
      scope.count.kind === "unknown"
        ? { kind: "unknown" }
        : { kind: scope.count.kind, value: decimalBytes(scope.count.value) },
    ...(scope.estimatedBytes === undefined ? {} : { estimatedBytes: decimalBytes(scope.estimatedBytes) }),
    preview: scope.preview,
  };
}

export function encodeActionPlan(plan: ActionPlan): Record<string, unknown> {
  return {
    id: plan.id,
    operation: plan.operation,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    providerId: plan.providerId,
    ...(plan.findingId === undefined ? {} : { findingId: plan.findingId }),
    scopeSummary: plan.scopeSummary,
    reversibility: plan.reversibility,
    permission: plan.permission,
    ...(plan.exactItemCount === undefined ? {} : { exactItemCount: decimalBytes(plan.exactItemCount) }),
    ...(plan.selectedBytes === undefined ? {} : { selectedBytes: decimalBytes(plan.selectedBytes) }),
    ...(plan.entries === undefined
      ? {}
      : {
          entries: plan.entries.map((entry) => ({
            path: encodeRawPath(entry.path),
            expected: {
              device: decimalBytes(entry.expected.device),
              inode: decimalBytes(entry.expected.inode),
              mountId: entry.expected.mountId,
              kind: entry.expected.kind,
              apparentBytes: decimalBytes(entry.expected.apparentBytes),
              modifiedNanoseconds: decimalBytes(entry.expected.modifiedNanoseconds),
            },
            reviewedBytes: decimalBytes(entry.reviewedBytes),
            ...(entry.subtree === undefined
              ? {}
              : { subtree: { entries: decimalBytes(entry.subtree.entries), digest: entry.subtree.digest } }),
          })),
        }),
    ...(plan.managerScope === undefined ? {} : { managerScope: plan.managerScope }),
    ...(plan.manager === undefined ? {} : { manager: encodeManagerScope(plan.manager) }),
    ...(plan.regenerationCost === undefined ? {} : { regenerationCost: plan.regenerationCost }),
    ...(plan.destination === undefined ? {} : { destination: encodeRawPath(plan.destination) }),
    ...(plan.sourceDisposition === undefined
      ? {}
      : { sourceDisposition: plan.sourceDisposition }),
    ...(plan.keepPath === undefined ? {} : { keepPath: encodeRawPath(plan.keepPath) }),
    ...(plan.ruleHash === undefined ? {} : { ruleHash: plan.ruleHash }),
    warnings: [...plan.warnings],
  };
}

/**
 * Three numbers, never folded into one: what the plan selected, what actually
 * moved into Trash, and what the filesystem's own reading changed by. A Trash
 * move on one filesystem makes the first two large and the third zero.
 */
export function encodeActionResult(
  result: ActionResult,
  observedFreeSpaceChange?: bigint,
  notes: readonly string[] = [],
): Record<string, unknown> {
  return {
    planId: result.planId,
    journalId: result.journalId,
    state: result.state,
    completed: decimalBytes(result.completed),
    skipped: decimalBytes(result.skipped),
    failed: decimalBytes(result.failed),
    ...(result.selectedBytes === undefined ? {} : { selectedBytes: decimalBytes(result.selectedBytes) }),
    bytesMovedToTrash: decimalBytes(result.bytesMovedToTrash),
    ...(result.freeBytesBefore === undefined ? {} : { freeBytesBefore: decimalBytes(result.freeBytesBefore) }),
    ...(result.freeBytesAfter === undefined ? {} : { freeBytesAfter: decimalBytes(result.freeBytesAfter) }),
    ...(observedFreeSpaceChange === undefined
      ? {}
      : { observedFreeSpaceChange: observedFreeSpaceChange.toString(10) }),
    undoAvailable: result.undoAvailable,
    // What the apply checked once the helper had finished. A check that could
    // not run is listed as unavailable rather than left out, so a reader can
    // tell "it was fine" from "nobody could tell".
    verification: result.verification.map((check) => ({
      check: check.check,
      outcome: check.outcome,
      detail: check.detail,
    })),
    ...(notes.length === 0 ? {} : { notes: [...notes] }),
  };
}

export function encodeJournalRecord(record: JournalRecord): Record<string, unknown> {
  return {
    id: record.id,
    planId: record.planId,
    operation: record.operation,
    startedAt: record.startedAt,
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    state: record.state,
    completed: decimalBytes(record.completed),
    skipped: decimalBytes(record.skipped),
    failed: decimalBytes(record.failed),
    ...(record.selectedBytes === undefined ? {} : { selectedBytes: decimalBytes(record.selectedBytes) }),
    bytesMovedToTrash: decimalBytes(record.bytesMovedToTrash),
    ...(record.manager === undefined
      ? {}
      : {
          manager: {
            adapter: record.manager.adapter,
            action: record.manager.action,
            privilege: record.manager.privilege,
            ...(record.manager.estimatedBytes === undefined
              ? {}
              : { estimatedBytes: decimalBytes(record.manager.estimatedBytes) }),
            commands: record.manager.commands.map((command) => ({
              tool: command.tool,
              arguments: [...command.arguments],
              state: command.state,
              ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode.toString(10) }),
              ...(command.output === undefined ? {} : { output: command.output }),
            })),
          },
        }),
    ...(record.freeBytesBefore === undefined ? {} : { freeBytesBefore: decimalBytes(record.freeBytesBefore) }),
    ...(record.freeBytesAfter === undefined ? {} : { freeBytesAfter: decimalBytes(record.freeBytesAfter) }),
    items: record.items.map((item) => ({
      path: encodeRawPath(item.path),
      ...(item.destination === undefined ? {} : { destination: encodeRawPath(item.destination) }),
      outcome: item.outcome,
      ...(item.message === undefined ? {} : { message: item.message }),
      bytes: decimalBytes(item.bytes),
    })),
    ...(record.itemsOmitted === undefined || record.itemsOmitted === 0n ? {} : { itemsOmitted: decimalBytes(record.itemsOmitted) }),
  };
}
