import type { Alert, Capability, Filesystem, RawPath, StorageDevice, Warning } from "../domain/models.js";
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
