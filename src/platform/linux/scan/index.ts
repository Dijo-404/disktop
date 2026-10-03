import { CapabilityUnavailable, StaleScanIndex } from "../../../domain/errors.js";
import type { IndexedEntry, RawPath, Warning } from "../../../domain/models.js";
import { rawPathFromBytes, rawPathFromUtf8 } from "../../../domain/paths.js";
import type { DuplicatePort, DuplicateQuery, DuplicateReading } from "../../../ports/duplicates.js";
import type { DuplicateFile, DuplicateGroup } from "../../../domain/duplicates.js";
import type {
  EntryPage,
  EntryQuery,
  FileIndexPort,
  ScanEvent,
  ScanPort,
  ScanRequest,
  OwnerTotal,
  TypeTotal,
} from "../../../ports/scan.js";
import type { HelperEvent, HelperStart, NativeHelperClient } from "../../../native/client.js";
import {
  parseDuplicateResult,
  parseIndexPage,
  parseProgress,
  parseScanResult,
  type NativeDuplicateFile,
  type NativeDuplicateGroup,
  type NativeIndexEntry,
  type NativeScanResult,
  type NativeWarning,
} from "../../../native/protocol.js";

export interface NativeScannerOptions {
  /** Where the helper keeps its index. Node owns the location, not the helper. */
  readonly indexDirectory: string;
  readonly maxIndexBytes?: bigint;
  readonly keepScans?: number;
  readonly start: () => Promise<HelperStart>;
}

/**
 * The scan and index ports, backed by the `disktop-fs` child process.
 *
 * One helper is started per operation and shut down after it, so nothing is
 * left running between commands. Each operation's raw path bytes cross as
 * base64 and come back the same way: this adapter never builds a path from
 * display text, and never touches the filesystem itself.
 */
export function createNativeScanner(
  options: NativeScannerOptions,
): ScanPort & FileIndexPort & DuplicatePort {
  const indexDirectory = rawPathFromUtf8(options.indexDirectory).bytesBase64;

  return {
    async groups(query: DuplicateQuery, signal: AbortSignal): Promise<DuplicateReading> {
      const client = await connect(options.start);
      try {
        const event = await client.request(
          "hash-candidates",
          {
            scanId: query.scanId,
            indexDirectory,
            underPath: query.underPath.bytesBase64,
            minimumBytes: query.minimumBytes.toString(10),
            ...(query.maximumGroups === undefined ? {} : { maximumGroups: query.maximumGroups }),
            ...(query.maximumFilesPerGroup === undefined
              ? {}
              : { maximumFilesPerGroup: query.maximumFilesPerGroup }),
          },
          signal,
        );
        refuseError(event, client, query.scanId);
        const result = parseDuplicateResult(event.result);
        return {
          groups: result.groups.map(toDuplicateGroup),
          complete: result.complete,
          // The helper's warnings are sentences about one search, not codes
          // from the scanner's fixed set, so they arrive as text and are
          // labelled here rather than being squeezed into a scan warning code.
          warnings: result.warnings.map((message) => ({ code: "incomplete-search", message })),
          candidatesRead: result.candidatesRead,
          filesHashed: result.filesHashed,
        };
      } finally {
        await client.close();
      }
    },

    async *run(request: ScanRequest, signal: AbortSignal): AsyncIterable<ScanEvent> {
      const client = await connect(options.start);
      try {
        const scanArguments: Record<string, unknown> = {
          roots: request.roots.map((root) => root.bytesBase64),
          crossFilesystems: request.crossFilesystems,
          excludes: request.excludes.map((exclude) => exclude.bytesBase64),
          accounting: request.accounting,
          indexDirectory,
          ...(request.throttleBytesPerSecond === undefined
            ? {}
            : { throttleBytesPerSecond: request.throttleBytesPerSecond.toString(10) }),
          ...(request.maxDepth === undefined ? {} : { maxDepth: request.maxDepth.toString(10) }),
          ...(options.maxIndexBytes === undefined ? {} : { maxIndexBytes: options.maxIndexBytes.toString(10) }),
          ...(options.keepScans === undefined ? {} : { keepScans: String(options.keepScans) }),
        };

        for await (const event of client.stream("scan", scanArguments, signal)) {
          const translated = translateScanEvent(event, client);
          if (translated !== undefined) {
            yield translated;
          }
        }
      } finally {
        await client.close();
      }
    },

    async query(query: EntryQuery): Promise<EntryPage> {
      const client = await connect(options.start);
      try {
        const event = await client.request("query-index", {
          scanId: query.scanId,
          indexDirectory,
          filter: encodeFilter(query),
          sort: query.sort,
          order: query.order,
          limit: String(Math.max(1, Math.trunc(query.limit))),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.includeTypeTotals === undefined ? {} : { includeTypeTotals: query.includeTypeTotals }),
          ...(query.includeOwnerTotals === undefined ? {} : { includeOwnerTotals: query.includeOwnerTotals }),
        });
        refuseError(event, client);
        const page = parseIndexPage(event.result);
        return {
          entries: page.entries.map(toIndexedEntry),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          ...(page.typeTotals === undefined ? {} : { typeTotals: page.typeTotals.map(toTypeTotal) }),
          ...(page.ownerTotals === undefined ? {} : { ownerTotals: page.ownerTotals.map(toOwnerTotal) }),
        };
      } finally {
        await client.close();
      }
    },
  };
}

async function connect(start: () => Promise<HelperStart>): Promise<NativeHelperClient> {
  const started = await start();
  if (!started.started) {
    throw new CapabilityUnavailable(started.capability);
  }
  return started.client;
}

/**
 * `accepted` says the helper took the request; it carries no result and needs
 * no equivalent on the application side.
 */
function translateScanEvent(event: HelperEvent, client: NativeHelperClient): ScanEvent | undefined {
  if (event.event === "accepted") {
    return undefined;
  }
  if (event.event === "progress") {
    const progress = parseProgress(event.progress);
    return {
      kind: "progress",
      scannedEntries: progress.scannedEntries,
      processedBytes: progress.processedBytes,
      inaccessibleDirectories: progress.inaccessibleDirectories,
      ...(progress.currentPath === undefined ? {} : { currentPath: decodePath(progress.currentPath) }),
    };
  }
  refuseError(event, client);
  const result = parseScanResult(event.result);
  return toCompleteEvent(result);
}

function toCompleteEvent(result: NativeScanResult): ScanEvent {
  return {
    kind: "complete",
    scanId: result.scanId,
    accounting: result.accounting,
    roots: result.roots.map(decodePath),
    completeness: {
      complete: result.complete,
      scannedEntries: result.scannedEntries,
      inaccessibleDirectories: result.inaccessibleDirectories,
      excludedMounts: result.excludedMounts.map(decodePath),
      warnings: result.warnings.map(toWarning),
    },
    totals: {
      allocatedBytes: result.allocatedBytes,
      apparentBytes: result.apparentBytes,
      sharedBytes: result.sharedBytes,
    },
    filesystems: result.filesystems,
  };
}

/**
 * Turn the helper's own refusal into a capability failure where it is one, so
 * a kernel or permission problem reads as a missing capability rather than a
 * crash.
 */
function refuseError(event: HelperEvent, client: NativeHelperClient, scanId?: string): void {
  if (event.event !== "error") {
    return;
  }
  const failure = event.error as { code?: unknown; message?: unknown } | undefined;
  const code = typeof failure?.code === "string" ? failure.code : "internal-error";
  const message = typeof failure?.message === "string" ? failure.message : "The helper refused the request.";
  const diagnostics = client.diagnostics();
  const explanation = diagnostics === "" ? message : `${message} (${diagnostics})`;

  if (code === "unsupported-kernel") {
    throw new CapabilityUnavailable({ status: "unsupported-kernel", explanation });
  }
  if (code === "permission-denied") {
    throw new CapabilityUnavailable({ status: "permission-denied", explanation });
  }
  if (code === "unsupported-filesystem") {
    throw new CapabilityUnavailable({ status: "unsupported-filesystem", explanation });
  }
  // The index prunes whole scans to stay inside its budget, so a scan it no
  // longer holds is routine. Letting it through as a generic failure would
  // tell somebody Disktop broke when their cache simply rolled over.
  if (code === "unknown-request" && scanId !== undefined) {
    throw new StaleScanIndex(scanId, message);
  }
  throw new Error(explanation);
}

function encodeFilter(query: EntryQuery): Record<string, unknown> {
  const filter = query.filter;
  return {
    ...(filter.underPath === undefined ? {} : { underPath: filter.underPath.bytesBase64 }),
    ...(filter.atPath === undefined ? {} : { atPath: filter.atPath.bytesBase64 }),
    ...(filter.parentId === undefined ? {} : { parentId: filter.parentId }),
    ...(filter.nameContains === undefined ? {} : { nameContains: filter.nameContains }),
    ...(filter.extension === undefined ? {} : { extension: filter.extension }),
    ...(filter.minAllocatedBytes === undefined ? {} : { minAllocatedBytes: filter.minAllocatedBytes.toString(10) }),
    ...(filter.maxAllocatedBytes === undefined ? {} : { maxAllocatedBytes: filter.maxAllocatedBytes.toString(10) }),
    ...(filter.modifiedBeforeNanoseconds === undefined
      ? {}
      : { modifiedBeforeNanoseconds: filter.modifiedBeforeNanoseconds.toString(10) }),
    ...(filter.ownerId === undefined ? {} : { ownerId: filter.ownerId.toString(10) }),
    ...(filter.kinds === undefined ? {} : { kinds: [...filter.kinds] }),
    ...(filter.maxChildEntries === undefined ? {} : { maxChildEntries: filter.maxChildEntries.toString(10) }),
    ...(filter.broken === undefined ? {} : { broken: filter.broken }),
  };
}

function toIndexedEntry(entry: NativeIndexEntry): IndexedEntry {
  return {
    id: entry.id,
    ...(entry.parentId === undefined ? {} : { parentId: entry.parentId }),
    path: decodePath(entry.path),
    kind: entry.kind,
    device: entry.device,
    inode: entry.inode,
    mountId: entry.mountId,
    linkCount: entry.linkCount,
    apparentBytes: entry.apparentBytes,
    allocatedBytes: entry.allocatedBytes,
    ownerId: entry.ownerId,
    modifiedNanoseconds: entry.modifiedNanoseconds,
    shared: entry.shared,
    ...(entry.childEntries === undefined ? {} : { childEntries: entry.childEntries }),
    ...(entry.broken === undefined ? {} : { broken: entry.broken }),
  };
}

function toDuplicateGroup(group: NativeDuplicateGroup): DuplicateGroup {
  return {
    apparentBytes: group.apparentBytes,
    digest: group.digest,
    files: group.files.map(toDuplicateFile),
  };
}

function toDuplicateFile(file: NativeDuplicateFile): DuplicateFile {
  return {
    path: decodePath(file.path),
    device: file.device,
    inode: file.inode,
    apparentBytes: file.apparentBytes,
    modifiedNanoseconds: file.modifiedNanoseconds,
    ownerId: file.ownerId,
    groupId: file.groupId,
    permissions: file.permissions,
  };
}

function toOwnerTotal(total: {
  ownerId: bigint;
  entries: bigint;
  allocatedBytes: bigint;
  apparentBytes: bigint;
}): OwnerTotal {
  return total;
}

function toTypeTotal(total: { extension: string; entries: bigint; allocatedBytes: bigint; apparentBytes: bigint }): TypeTotal {
  return {
    extension: total.extension,
    entries: total.entries,
    allocatedBytes: total.allocatedBytes,
    apparentBytes: total.apparentBytes,
  };
}

function toWarning(warning: NativeWarning): Warning {
  return {
    code: warning.code,
    message: warning.message,
    ...(warning.path === undefined ? {} : { path: decodePath(warning.path) }),
  };
}

function decodePath(encoded: string): RawPath {
  return rawPathFromBytes(new Uint8Array(Buffer.from(encoded, "base64")));
}
