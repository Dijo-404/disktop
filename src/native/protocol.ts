/** Current scaffold request shape. Future operations need versioned schemas. */
export const PROTOCOL_VERSION = 1;

export interface NativeRequest {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly requestId: string;
  readonly operation: "hello" | "probe";
  readonly arguments: Readonly<Record<string, never>>;
}

export interface NativeCapabilityProbe {
  readonly available: boolean;
  readonly reason: string | null;
}

export interface NativeHelloResult {
  readonly helperVersion: string;
  readonly buildChecksum: string | null;
  readonly platform: string;
  readonly architecture: string;
  readonly kernelCapabilities: { readonly openat2: NativeCapabilityProbe };
  readonly supportedOperations: readonly string[];
}

export type NativeResponse =
  | {
      readonly protocolVersion: number;
      readonly requestId: string;
      readonly eventId: string;
      readonly event: "complete";
      readonly result: NativeHelloResult;
    }
  | {
      readonly protocolVersion: number;
      readonly requestId: string | null;
      readonly eventId: string;
      readonly event: "error";
      readonly error: { readonly code: string; readonly message: string };
    };

export function handshakeRequest(requestId: string): NativeRequest {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(requestId)) {
    throw new RangeError("Invalid native request ID");
  }
  return { protocolVersion: PROTOCOL_VERSION, requestId, operation: "hello", arguments: {} };
}

/** A narrow decoder for the implemented handshake, not the eventual scan protocol. */
export function parseHandshakeResponse(line: string, expectedRequestId: string): NativeHelloResult {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION || value.requestId !== expectedRequestId || typeof value.eventId !== "string" || value.event !== "complete" || !isRecord(value.result)) {
    throw new Error("Invalid native handshake response");
  }
  const result = value.result;
  if (
    typeof result.helperVersion !== "string" ||
    !(result.buildChecksum === null || typeof result.buildChecksum === "string") ||
    typeof result.platform !== "string" ||
    typeof result.architecture !== "string" ||
    !isRecord(result.kernelCapabilities) ||
    !isRecord(result.kernelCapabilities.openat2) ||
    typeof result.kernelCapabilities.openat2.available !== "boolean" ||
    !(result.kernelCapabilities.openat2.reason === null || typeof result.kernelCapabilities.openat2.reason === "string") ||
    !Array.isArray(result.supportedOperations) ||
    !result.supportedOperations.every((operation: unknown) => typeof operation === "string")
  ) {
    throw new Error("Invalid native helper capabilities");
  }
  return result as unknown as NativeHelloResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A warning code the helper is allowed to emit; anything else is a protocol fault. */
const WARNING_CODES = new Set([
  "inaccessible-directory",
  "excluded-mount",
  "nested-mount",
  "crossed-filesystem-skipped",
  "changed-during-scan",
  "unsupported-filesystem",
  "symlink-not-followed",
  "depth-limit-reached",
  "cancelled",
  "warnings-truncated",
]);

const ENTRY_KINDS = new Set(["file", "directory", "symlink", "other"]);

export interface NativeWarning {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface NativeScanResult {
  readonly scanId: string;
  readonly complete: boolean;
  readonly roots: readonly string[];
  readonly accounting: "allocated" | "apparent";
  readonly scannedEntries: bigint;
  readonly inaccessibleDirectories: bigint;
  readonly allocatedBytes: bigint;
  readonly apparentBytes: bigint;
  readonly sharedBytes: bigint;
  readonly excludedMounts: readonly string[];
  readonly warnings: readonly NativeWarning[];
  readonly filesystems: readonly string[];
}

export interface NativeProgress {
  readonly scannedEntries: bigint;
  readonly processedBytes: bigint;
  readonly inaccessibleDirectories: bigint;
  readonly currentPath?: string;
}

export interface NativeIndexEntry {
  readonly id: string;
  readonly parentId?: string;
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly device: bigint;
  readonly inode: bigint;
  readonly mountId: string;
  readonly linkCount: bigint;
  readonly apparentBytes: bigint;
  readonly allocatedBytes: bigint;
  readonly ownerId: bigint;
  readonly modifiedNanoseconds: bigint;
  readonly shared: boolean;
  readonly childEntries?: bigint;
  readonly broken?: boolean;
}

export interface NativeTypeTotal {
  readonly extension: string;
  readonly entries: bigint;
  readonly allocatedBytes: bigint;
  readonly apparentBytes: bigint;
}

export interface NativeOwnerTotal {
  readonly ownerId: bigint;
  readonly entries: bigint;
  readonly allocatedBytes: bigint;
  readonly apparentBytes: bigint;
}

export interface NativeIndexPage {
  readonly scanId: string;
  readonly entries: readonly NativeIndexEntry[];
  readonly nextCursor?: string;
  readonly typeTotals?: readonly NativeTypeTotal[];
  readonly ownerTotals?: readonly NativeOwnerTotal[];
}

/**
 * Decode a scan completion.
 *
 * Every filesystem integer arrives as a decimal string and becomes a `bigint`
 * here; nothing on this path passes through `Number`, where a byte total or an
 * inode above 2^53 would quietly change value. A partial result without a
 * warning is rejected rather than presented as a short answer.
 */
export function parseScanResult(result: unknown): NativeScanResult {
  if (!isRecord(result)) {
    throw new Error("The helper returned a scan result that is not an object");
  }
  const complete = result.complete;
  const accounting = result.accounting;
  if (typeof result.scanId !== "string" || typeof complete !== "boolean") {
    throw new Error("The helper returned a scan result without an identity");
  }
  if (accounting !== "allocated" && accounting !== "apparent") {
    throw new Error("The helper returned an unknown accounting mode");
  }
  const warnings = parseWarnings(result.warnings);
  if (!complete && warnings.length === 0) {
    throw new Error("The helper reported a partial scan without saying what it missed");
  }
  return {
    scanId: result.scanId,
    complete,
    accounting,
    roots: parsePathList(result.roots, "roots"),
    scannedEntries: decimal(result.scannedEntries, "scannedEntries"),
    inaccessibleDirectories: decimal(result.inaccessibleDirectories, "inaccessibleDirectories"),
    allocatedBytes: decimal(result.allocatedBytes, "allocatedBytes"),
    apparentBytes: decimal(result.apparentBytes, "apparentBytes"),
    sharedBytes: decimal(result.sharedBytes, "sharedBytes"),
    excludedMounts: parsePathList(result.excludedMounts, "excludedMounts"),
    warnings,
    filesystems: parseDecimalList(result.filesystems, "filesystems"),
  };
}

export function parseProgress(progress: unknown): NativeProgress {
  if (!isRecord(progress)) {
    throw new Error("The helper returned a progress event that is not an object");
  }
  return {
    scannedEntries: decimal(progress.scannedEntries, "scannedEntries"),
    processedBytes: progress.processedBytes === undefined ? 0n : decimal(progress.processedBytes, "processedBytes"),
    inaccessibleDirectories:
      progress.inaccessibleDirectories === undefined ? 0n : decimal(progress.inaccessibleDirectories, "inaccessibleDirectories"),
    ...(typeof progress.currentPath === "string" ? { currentPath: progress.currentPath } : {}),
  };
}

export function parseIndexPage(result: unknown): NativeIndexPage {
  if (!isRecord(result) || typeof result.scanId !== "string" || !Array.isArray(result.entries)) {
    throw new Error("The helper returned an index page without entries");
  }
  const entries = result.entries.map((entry: unknown) => parseIndexEntry(entry));
  const totals = result.typeTotals;
  const owners = result.ownerTotals;
  return {
    scanId: result.scanId,
    entries,
    ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
    ...(Array.isArray(totals) ? { typeTotals: totals.map((total: unknown) => parseTypeTotal(total)) } : {}),
    ...(Array.isArray(owners) ? { ownerTotals: owners.map((total: unknown) => parseOwnerTotal(total)) } : {}),
  };
}

function parseIndexEntry(value: unknown): NativeIndexEntry {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.id !== "string") {
    throw new Error("The helper returned an index entry without a byte path");
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !ENTRY_KINDS.has(kind)) {
    throw new Error("The helper returned an index entry with an unknown kind");
  }
  if (typeof value.shared !== "boolean" || typeof value.mountId !== "string") {
    throw new Error("The helper returned an index entry without a hardlink or mount identity");
  }
  return {
    id: value.id,
    ...(typeof value.parentId === "string" ? { parentId: value.parentId } : {}),
    path: value.path,
    kind: kind as NativeIndexEntry["kind"],
    device: decimal(value.device, "device"),
    inode: decimal(value.inode, "inode"),
    mountId: value.mountId,
    linkCount: decimal(value.linkCount, "linkCount"),
    apparentBytes: decimal(value.apparentBytes, "apparentBytes"),
    allocatedBytes: decimal(value.allocatedBytes, "allocatedBytes"),
    ownerId: decimal(value.ownerId, "ownerId"),
    modifiedNanoseconds: decimal(value.modifiedNanoseconds, "modifiedNanoseconds"),
    shared: value.shared,
    ...(value.childEntries === undefined ? {} : { childEntries: decimal(value.childEntries, "childEntries") }),
    ...(typeof value.broken === "boolean" ? { broken: value.broken } : {}),
  };
}

function parseTypeTotal(value: unknown): NativeTypeTotal {
  if (!isRecord(value) || typeof value.extension !== "string") {
    throw new Error("The helper returned a type total without an extension");
  }
  return {
    extension: value.extension,
    entries: decimal(value.entries, "entries"),
    allocatedBytes: decimal(value.allocatedBytes, "allocatedBytes"),
    apparentBytes: decimal(value.apparentBytes, "apparentBytes"),
  };
}

function parseOwnerTotal(value: unknown): NativeOwnerTotal {
  if (!isRecord(value)) {
    throw new Error("The helper returned an owner total that is not an object");
  }
  return {
    ownerId: decimal(value.ownerId, "ownerId"),
    entries: decimal(value.entries, "entries"),
    allocatedBytes: decimal(value.allocatedBytes, "allocatedBytes"),
    apparentBytes: decimal(value.apparentBytes, "apparentBytes"),
  };
}

function parseWarnings(value: unknown): readonly NativeWarning[] {
  if (!Array.isArray(value)) {
    throw new Error("The helper returned a scan result without a warning list");
  }
  return value.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.code !== "string" || typeof entry.message !== "string") {
      throw new Error("The helper returned a malformed scan warning");
    }
    if (!WARNING_CODES.has(entry.code)) {
      throw new Error(`The helper returned an unknown warning code '${entry.code}'`);
    }
    return {
      code: entry.code,
      message: entry.message,
      ...(typeof entry.path === "string" ? { path: entry.path } : {}),
    };
  });
}

/**
 * A list of decimal strings, kept as strings: these are identities to compare,
 * never numbers to do arithmetic on.
 */
function parseDecimalList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry: unknown) => typeof entry !== "string" || !/^(0|[1-9][0-9]*)$/.test(entry))) {
    throw new Error(`The helper returned '${field}' without decimal identities`);
  }
  return value as readonly string[];
}

function parsePathList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry: unknown) => typeof entry !== "string")) {
    throw new Error(`The helper returned '${field}' without base64 byte paths`);
  }
  return value as readonly string[];
}

function decimal(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`The helper returned '${field}' as something other than a decimal string`);
  }
  return BigInt(value);
}
