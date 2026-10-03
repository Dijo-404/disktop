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

export interface NativeDuplicateFile {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly apparentBytes: bigint;
  readonly modifiedNanoseconds: bigint;
  readonly ownerId: bigint;
  readonly groupId: bigint;
  readonly permissions: number;
}

export interface NativeDuplicateGroup {
  readonly apparentBytes: bigint;
  readonly digest: string;
  readonly files: readonly NativeDuplicateFile[];
}

export interface NativeDuplicateResult {
  readonly groups: readonly NativeDuplicateGroup[];
  readonly complete: boolean;
  readonly warnings: readonly string[];
  readonly candidatesRead: bigint;
  readonly filesHashed: bigint;
}

/**
 * Read a duplicate search's answer, refusing one that cannot be true.
 *
 * A group of fewer than two files is not a duplicate group, and an incomplete
 * answer that names nothing it missed is an answer that would be read as the
 * whole picture. Both are refused here rather than passed on, for the same
 * reason the schema refuses them: a listing is where somebody decides which
 * copy of something to remove.
 */
export function parseDuplicateResult(result: unknown): NativeDuplicateResult {
  if (!isRecord(result) || !Array.isArray(result.groups) || typeof result.complete !== "boolean") {
    throw new Error("The helper returned a duplicate result without groups");
  }
  const warnings = result.warnings;
  if (!Array.isArray(warnings) || warnings.some((entry: unknown) => typeof entry !== "string")) {
    throw new Error("The helper returned a duplicate result without a warning list");
  }
  if (!result.complete && warnings.length === 0) {
    throw new Error("The helper reported an incomplete duplicate search without saying what it missed");
  }
  return {
    groups: result.groups.map((group: unknown) => parseDuplicateGroup(group)),
    complete: result.complete,
    warnings: warnings as readonly string[],
    candidatesRead: decimal(result.candidatesRead, "candidatesRead"),
    filesHashed: decimal(result.filesHashed, "filesHashed"),
  };
}

function parseDuplicateGroup(value: unknown): NativeDuplicateGroup {
  if (!isRecord(value) || typeof value.digest !== "string" || !/^[0-9a-f]{64}$/.test(value.digest)) {
    throw new Error("The helper returned a duplicate group without a hexadecimal digest");
  }
  if (!Array.isArray(value.files) || value.files.length < 2) {
    throw new Error("The helper returned a duplicate group holding fewer than two files");
  }
  return {
    apparentBytes: decimal(value.apparentBytes, "apparentBytes"),
    digest: value.digest,
    files: value.files.map((file: unknown) => parseDuplicateFile(file)),
  };
}

function parseDuplicateFile(value: unknown): NativeDuplicateFile {
  if (!isRecord(value) || typeof value.path !== "string") {
    throw new Error("The helper returned a duplicate file without a byte path");
  }
  if (typeof value.permissions !== "number" || !Number.isInteger(value.permissions)) {
    throw new Error("The helper returned a duplicate file without its permission bits");
  }
  return {
    path: value.path,
    device: decimal(value.device, "device"),
    inode: decimal(value.inode, "inode"),
    apparentBytes: decimal(value.apparentBytes, "apparentBytes"),
    modifiedNanoseconds: decimal(value.modifiedNanoseconds, "modifiedNanoseconds"),
    ownerId: decimal(value.ownerId, "ownerId"),
    groupId: decimal(value.groupId, "groupId"),
    permissions: value.permissions,
  };
}

export interface NativeActionResult {
  readonly journalId: string;
  readonly state: "complete" | "partial" | "uncertain";
  readonly completed: bigint;
  readonly skipped: bigint;
  readonly failed: bigint;
  readonly selectedBytes?: bigint;
  readonly bytesMovedToTrash: bigint;
  readonly freeBytesBefore?: bigint;
  readonly freeBytesAfter?: bigint;
  readonly undoAvailable: boolean;
}

export interface NativeManagerCommand {
  readonly position: bigint;
  readonly tool: string;
  readonly arguments: readonly string[];
  readonly state: "pending" | "started" | "finished" | "uncertain";
  readonly exitCode?: bigint;
  readonly output?: string;
}

export interface NativeManagerRecord {
  readonly adapter: string;
  readonly action: string;
  readonly privilege: "user" | "root";
  readonly estimatedBytes?: bigint;
  readonly commands: readonly NativeManagerCommand[];
}

export interface NativeJournalItem {
  readonly position: bigint;
  readonly path: string;
  readonly destination?: string;
  readonly outcome: "in-progress" | "completed" | "skipped" | "failed" | "uncertain";
  readonly message?: string;
  readonly bytes: bigint;
}

export interface NativeJournalRecord {
  readonly id: string;
  readonly planId: string;
  readonly operation: string;
  readonly startedAtMilliseconds: bigint;
  readonly finishedAtMilliseconds?: bigint;
  readonly state: "in-progress" | "complete" | "partial" | "uncertain";
  readonly completed: bigint;
  readonly skipped: bigint;
  readonly failed: bigint;
  readonly selectedBytes?: bigint;
  readonly bytesMovedToTrash: bigint;
  readonly freeBytesBefore?: bigint;
  readonly freeBytesAfter?: bigint;
  readonly items: readonly NativeJournalItem[];
  /** Items a history page left out of `items`; absent when it holds them all. */
  readonly itemsOmitted?: bigint;
  readonly manager?: NativeManagerRecord;
}

export interface NativeJournalPage {
  readonly reconciled: bigint;
  readonly records: readonly NativeJournalRecord[];
  readonly nextCursor?: string;
}

const ACTION_STATES = new Set(["complete", "partial", "uncertain"]);
const ITEM_OUTCOMES = new Set(["in-progress", "completed", "skipped", "failed", "uncertain"]);

/**
 * Decode what one action did.
 *
 * A result that claims success without naming a durable journal record is
 * refused here rather than returned: `docs/native-protocol.md` calls that a
 * protocol violation, and the whole recovery story rests on every completed
 * action having a record behind it.
 */
export function parseActionResult(result: unknown): NativeActionResult {
  if (!isRecord(result)) {
    throw new Error("The helper returned an action result that is not an object");
  }
  if (typeof result.journalId !== "string" || result.journalId === "") {
    throw new Error("The helper reported an action with no durable journal record");
  }
  const state = result.state;
  if (typeof state !== "string" || !ACTION_STATES.has(state)) {
    throw new Error("The helper returned an action in a state this build does not know");
  }
  if (typeof result.undoAvailable !== "boolean") {
    throw new Error("The helper did not say whether this action can be undone");
  }
  return {
    journalId: result.journalId,
    state: state as NativeActionResult["state"],
    completed: decimal(result.completed, "completed"),
    skipped: decimal(result.skipped, "skipped"),
    failed: decimal(result.failed, "failed"),
    ...(result.selectedBytes === undefined
      ? {}
      : { selectedBytes: decimal(result.selectedBytes, "selectedBytes") }),
    bytesMovedToTrash: decimal(result.bytesMovedToTrash, "bytesMovedToTrash"),
    ...(result.freeBytesBefore === undefined
      ? {}
      : { freeBytesBefore: decimal(result.freeBytesBefore, "freeBytesBefore") }),
    ...(result.freeBytesAfter === undefined
      ? {}
      : { freeBytesAfter: decimal(result.freeBytesAfter, "freeBytesAfter") }),
    undoAvailable: result.undoAvailable,
  };
}

export function parseJournalPage(result: unknown): NativeJournalPage {
  if (!isRecord(result) || !Array.isArray(result.records)) {
    throw new Error("The helper returned a journal page without records");
  }
  return {
    reconciled: decimal(result.reconciled, "reconciled"),
    records: result.records.map((record: unknown) => parseJournalRecord(record)),
    ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
  };
}

function parseJournalRecord(value: unknown): NativeJournalRecord {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.planId !== "string") {
    throw new Error("The helper returned a journal record with no identity");
  }
  const state = value.state;
  if (typeof state !== "string" || !(ACTION_STATES.has(state) || state === "in-progress")) {
    throw new Error("The helper returned a journal record in an unknown state");
  }
  if (typeof value.operation !== "string" || !Array.isArray(value.items)) {
    throw new Error("The helper returned a journal record without its operation or items");
  }
  const manager = value.manager === undefined ? undefined : parseManagerRecord(value.manager);
  if ((value.operation === "manager") !== (manager !== undefined)) {
    throw new Error("The helper returned a journal record whose manager details do not match its operation");
  }
  if (manager === undefined && value.selectedBytes === undefined) {
    throw new Error("The helper returned a journal record without the bytes it selected");
  }
  return {
    id: value.id,
    planId: value.planId,
    operation: value.operation,
    startedAtMilliseconds: decimal(value.startedAtMilliseconds, "startedAtMilliseconds"),
    ...(value.finishedAtMilliseconds === undefined
      ? {}
      : { finishedAtMilliseconds: decimal(value.finishedAtMilliseconds, "finishedAtMilliseconds") }),
    state: state as NativeJournalRecord["state"],
    completed: decimal(value.completed, "completed"),
    skipped: decimal(value.skipped, "skipped"),
    failed: decimal(value.failed, "failed"),
    ...(value.selectedBytes === undefined
      ? {}
      : { selectedBytes: decimal(value.selectedBytes, "selectedBytes") }),
    bytesMovedToTrash: decimal(value.bytesMovedToTrash, "bytesMovedToTrash"),
    ...(value.freeBytesBefore === undefined
      ? {}
      : { freeBytesBefore: decimal(value.freeBytesBefore, "freeBytesBefore") }),
    ...(value.freeBytesAfter === undefined
      ? {}
      : { freeBytesAfter: decimal(value.freeBytesAfter, "freeBytesAfter") }),
    items: value.items.map((item: unknown) => parseJournalItem(item)),
    ...(value.itemsOmitted === undefined
      ? {}
      : { itemsOmitted: decimal(value.itemsOmitted, "itemsOmitted") }),
    ...(manager === undefined ? {} : { manager }),
  };
}

const COMMAND_STATES = new Set(["pending", "started", "finished", "uncertain"]);

function parseManagerRecord(value: unknown): NativeManagerRecord {
  if (
    !isRecord(value) ||
    typeof value.adapter !== "string" ||
    typeof value.action !== "string" ||
    (value.privilege !== "user" && value.privilege !== "root") ||
    !Array.isArray(value.commands)
  ) {
    throw new Error("The helper returned a manager record it could not have written");
  }
  return {
    adapter: value.adapter,
    action: value.action,
    privilege: value.privilege,
    ...(value.estimatedBytes === undefined
      ? {}
      : { estimatedBytes: decimal(value.estimatedBytes, "estimatedBytes") }),
    commands: value.commands.map((command: unknown) => {
      if (
        !isRecord(command) ||
        typeof command.tool !== "string" ||
        !Array.isArray(command.arguments) ||
        command.arguments.some((argument: unknown) => typeof argument !== "string") ||
        typeof command.state !== "string" ||
        !COMMAND_STATES.has(command.state)
      ) {
        throw new Error("The helper returned a manager command it could not have written");
      }
      const exitCode = command.exitCode;
      if (exitCode !== undefined && (typeof exitCode !== "string" || !/^-?(0|[1-9][0-9]{0,18})$/.test(exitCode))) {
        throw new Error("The helper returned an exit status that is not a decimal integer");
      }
      return {
        position: decimal(command.position, "position"),
        tool: command.tool,
        arguments: command.arguments as string[],
        state: command.state as NativeManagerCommand["state"],
        ...(exitCode === undefined ? {} : { exitCode: BigInt(exitCode) }),
        ...(typeof command.output === "string" ? { output: command.output } : {}),
      };
    }),
  };
}

function parseJournalItem(value: unknown): NativeJournalItem {
  if (!isRecord(value) || typeof value.path !== "string") {
    throw new Error("The helper returned a journal item without a byte path");
  }
  const outcome = value.outcome;
  if (typeof outcome !== "string" || !ITEM_OUTCOMES.has(outcome)) {
    throw new Error("The helper returned a journal item with an unknown outcome");
  }
  return {
    position: decimal(value.position, "position"),
    path: value.path,
    ...(typeof value.destination === "string" ? { destination: value.destination } : {}),
    outcome: outcome as NativeJournalItem["outcome"],
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    bytes: decimal(value.bytes, "bytes"),
  };
}
