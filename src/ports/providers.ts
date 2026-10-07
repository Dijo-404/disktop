import type { ActionPlan } from "../domain/actions.js";
import type { Finding, FindingCategory, SizeBasis } from "../domain/findings.js";
import type { CleanupRule } from "../domain/rules.js";
import type { Bytes, Capability, IndexedEntry, RawPath, Warning } from "../domain/models.js";

export interface PathFacts {
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly apparentBytes: Bytes;
  readonly allocatedBytes: Bytes;
  readonly ownerId: bigint;
  readonly modifiedNanoseconds: bigint;
  /**
   * The identity a reviewed plan records, so that what is applied later is the
   * same entry and not merely the same name. `mountId` is the device number
   * here: Node has no cheap way to read `stx_mnt_id`, and the helper compares
   * what it was given rather than deriving one of its own.
   */
  readonly device: bigint;
  readonly inode: bigint;
  readonly mountId: string;
}

/**
 * Read-only questions about paths a provider already knows the names of.
 *
 * There is no recursive call here on purpose: arbitrary traversal belongs to
 * the helper, and a provider that could walk a tree would be measuring rather
 * than detecting. Missing paths and non-directories are absent answers;
 * permission denials and failed reads throw, so the service marks the detector
 * incomplete and explains what it could not inspect.
 */
export interface PathProbe {
  facts(path: RawPath): Promise<PathFacts | undefined>;
  /** One level, bounded and sorted. A non-directory lists empty. */
  list(path: RawPath): Promise<readonly RawPath[]>;
  readText(path: RawPath, maxBytes: number): Promise<string | undefined>;
}

export interface FootprintMeasurement {
  readonly path: RawPath;
  readonly bytes?: Bytes;
  readonly basis: SizeBasis;
  readonly explanation: string;
}

export interface FootprintReading {
  readonly measurements: readonly FootprintMeasurement[];
  readonly warnings: readonly Warning[];
}

/** How many bytes some known directories occupy, according to the scan index. */
export interface FootprintPort {
  measure(paths: readonly RawPath[], signal: AbortSignal): Promise<FootprintReading>;
}

export interface ToolOutput {
  readonly capability: Capability;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

/** A fixed argument vector against an allowlisted system tool. Never a shell. */
export interface ToolPort {
  run(name: string, commandArguments: readonly string[], signal?: AbortSignal): Promise<ToolOutput>;
}

export interface IndexSearch {
  readonly paths: readonly RawPath[];
  /** False when no stored scan covers the root, which is not the same as finding nothing. */
  readonly searched: boolean;
  /** True when more matched than the budget allowed, so the caller can say so. */
  readonly truncated: boolean;
}

/** One owner's share of a stored scan, with how complete that scan was. */
export interface OwnerUsage {
  readonly ownerId: bigint;
  readonly entries: bigint;
  readonly allocatedBytes: Bytes;
  readonly apparentBytes: Bytes;
}

export interface OwnerUsageReading {
  readonly owners: readonly OwnerUsage[];
  /** True when more owners exist than the index returned. */
  readonly truncated: boolean;
  /** False when no stored scan covers the root, which is not "nobody owns anything". */
  readonly searched: boolean;
  /** False when the scan these totals come from did not reach everything. */
  readonly complete: boolean;
}

/** Entries under one path, as a stored scan recorded them. */
export interface IndexEntries {
  readonly entries: readonly IndexedEntry[];
  /** False when no stored scan covers the root, which is not "nothing is there". */
  readonly searched: boolean;
  /** True when more matched than the budget allowed. */
  readonly truncated: boolean;
}

export interface IndexSearchPort {
  directoriesNamed(names: readonly string[], limit: number, signal?: AbortSignal): Promise<IndexSearch>;
  ownerTotals(limit: number, signal?: AbortSignal): Promise<OwnerUsageReading>;
  /**
   * Everything a stored scan recorded under one path.
   *
   * A declarative rule needs this: it matches on names, ages, and sizes that
   * no fixed detector knows in advance. It is still a page of an index and
   * never a traversal — a provider that could walk a tree would be measuring
   * rather than detecting.
   */
  entriesUnder(root: RawPath, limit: number, signal?: AbortSignal): Promise<IndexEntries>;
}

/**
 * Everything a provider may reach. Each field is a port or a plain value, so a
 * provider can be driven from a test without a Linux host or a helper process.
 */
export interface DiscoveryEnvironment {
  readonly home: RawPath;
  readonly variables: Readonly<Record<string, string | undefined>>;
  readonly userId: bigint;
  readonly now: Date;
  readonly staleAfterDays: number;
  readonly appImageRoots: readonly RawPath[];
  /** Directory names that mark regenerable build output. */
  readonly artifactDirectories: readonly string[];
  /** The size above which a log file is worth reporting. */
  readonly largeLogBytes: Bytes;
  /** The cap that keeps one noisy detector from flooding the list. */
  readonly maxFindingsPerProvider: number;
  /** Cleanup somebody wrote down themselves, already validated. */
  readonly rules: readonly CleanupRule[];
  readonly paths: PathProbe;
  readonly tools: ToolPort;
  readonly index: IndexSearchPort;
}

export interface DiscoveryResult {
  readonly findings: readonly Finding[];
  readonly warnings: readonly Warning[];
  /** False when something the provider should have seen could not be read. */
  readonly complete: boolean;
}

export interface FindingProvider {
  readonly id: string;
  readonly version: number;
  readonly categories: readonly FindingCategory[];
  probe(environment: DiscoveryEnvironment, signal?: AbortSignal): Promise<Capability>;
  discover(environment: DiscoveryEnvironment, signal: AbortSignal): Promise<DiscoveryResult>;
}

export interface ManagedActionProvider {
  readonly id: string;
  preview(findingId: string, operation: string): Promise<ActionPlan>;
}
