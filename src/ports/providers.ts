import type { ActionPlan } from "../domain/actions.js";
import type { Finding, FindingCategory, SizeBasis } from "../domain/findings.js";
import type { Bytes, Capability, RawPath, Warning } from "../domain/models.js";

export interface PathFacts {
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly apparentBytes: Bytes;
  readonly allocatedBytes: Bytes;
  readonly ownerId: bigint;
  readonly modifiedNanoseconds: bigint;
}

/**
 * Read-only questions about paths a provider already knows the names of.
 *
 * There is no recursive call here on purpose: arbitrary traversal belongs to
 * the helper, and a provider that could walk a tree would be measuring rather
 * than detecting.
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
  run(name: string, commandArguments: readonly string[]): Promise<ToolOutput>;
}

export interface IndexSearch {
  readonly paths: readonly RawPath[];
  /** False when no stored scan covers the root, which is not the same as finding nothing. */
  readonly searched: boolean;
}

export interface IndexSearchPort {
  directoriesNamed(names: readonly string[], limit: number): Promise<IndexSearch>;
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
  probe(environment: DiscoveryEnvironment): Promise<Capability>;
  discover(environment: DiscoveryEnvironment, signal: AbortSignal): Promise<DiscoveryResult>;
}

export interface ManagedActionProvider {
  readonly id: string;
  preview(findingId: string, operation: string): Promise<ActionPlan>;
}
