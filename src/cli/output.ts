import type { Alert, Capability, Filesystem, IndexedEntry, RawPath, ScanCompleteness, StorageDevice, Warning } from "../domain/models.js";
import type { ScanTotals, TypeTotal } from "../ports/scan.js";
import type { SnapshotSummary } from "../ports/snapshots.js";
import type { DirectoryChange } from "../application/snapshots.js";
import type { ProviderReport } from "../application/footprint.js";
import type { CategoryTotal, Finding, FindingSize } from "../domain/findings.js";
import { decimalBytes } from "../domain/sizes.js";
import type { OperationFailure } from "../domain/errors.js";

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
  };
}

export function encodeCategoryTotal(total: CategoryTotal): Record<string, unknown> {
  return {
    category: total.category,
    findings: total.findings,
    bytes: decimalBytes(total.bytes),
    unmeasured: total.unmeasured,
  };
}
