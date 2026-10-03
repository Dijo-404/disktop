import { boundedLimit, olderThanNanoseconds, parseSize } from "../../application/explore.js";
import type { EntryFilter, EntrySort, SortOrder } from "../../ports/scan.js";
import type { SnapshotSummary } from "../../ports/snapshots.js";
import type { RawPath } from "../../domain/models.js";
import { isWithin, pathBytes, rawPathFromUtf8, sanitizeText } from "../../domain/paths.js";
import type { CliContext } from "../context.js";
import {
  EXIT,
  buildEnvelope,
  encodeCapability,
  encodeCompleteness,
  encodeIndexedEntry,
  encodeTypeTotal,
  writeEnvelope,
} from "../output.js";
import { entryLines, ownerLines, typeTotalLines, warningLines } from "../text.js";
import type { Warning } from "../../domain/models.js";
import { StaleScanIndex } from "../../domain/errors.js";

export interface ExploreOptions {
  readonly asJson: boolean;
  readonly path?: string;
  readonly sort?: EntrySort;
  readonly order?: SortOrder;
  readonly kind?: "file" | "directory" | "symlink" | "other";
  readonly minSize?: string;
  readonly maxSize?: string;
  readonly extension?: string;
  readonly name?: string;
  readonly olderThanDays?: string;
  readonly limit?: string;
  readonly cursor?: string;
  readonly typeTotals: boolean;
  readonly owners?: boolean;
}

const AVAILABLE = { status: "available", explanation: "The index answered from a stored scan." } as const;

/**
 * One page of the most recent scan that covered the requested path.
 *
 * Explore never scans. If no stored scan covers the path, it says so and names
 * the command that would produce one, rather than quietly reporting an empty
 * directory.
 */
export async function runExplore(context: CliContext, options: ExploreOptions): Promise<number> {
  const wanted = rawPathFromUtf8(context.resolvePath(options.path ?? "."));
  const snapshot = await newestCovering(context, wanted);
  if (snapshot === undefined) {
    return refuse(
      context,
      options.asJson,
      "invalid-input",
      `No stored scan covers ${wanted.display}. Run 'disktop scan ${wanted.display}' first.`,
    );
  }

  if (options.cursor !== undefined && !/^[A-Za-z0-9._~-]{1,512}$/.test(options.cursor)) {
    return refuse(
      context,
      options.asJson,
      "invalid-input",
      "'--cursor' takes a cursor Disktop printed. Run the command without it to start again.",
    );
  }
  if (options.limit !== undefined && (!/^[1-9][0-9]{0,3}$/.test(options.limit) || Number(options.limit) > 1000)) {
    return refuse(context, options.asJson, "invalid-input", "'--limit' accepts a whole number of entries from 1 to 1000.");
  }

  const filter = buildFilter(options, context.now());
  if (filter === "invalid-size") {
    return refuse(context, options.asJson, "invalid-input", "'--min-size' and '--max-size' accept a size such as 1GiB or 4096.");
  }
  if (filter === "invalid-age") {
    return refuse(context, options.asJson, "invalid-input", "'--older-than' accepts a whole number of days.");
  }

  // The index keeps only the newest scans, so a snapshot can outlive its rows.
  // That is a reason to scan again, and it is said as one.
  let outcome: Awaited<ReturnType<typeof context.storage.explore.page>>;
  try {
    outcome = await context.storage.explore.page({
      scanId: snapshot.scanId,
      // The path narrows the listing to that subtree. Using it only to choose a
      // snapshot would answer with the largest entries in the whole scan while
      // appearing to answer about this directory.
      filter: { ...filter, underPath: wanted },
      sort: options.sort ?? "allocated",
      order: options.order ?? "descending",
      limit: boundedLimit(options.limit === undefined ? undefined : Number(options.limit)),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      includeTypeTotals: options.typeTotals,
      ...(options.owners === true ? { includeOwnerTotals: true } : {}),
    });
  } catch (error) {
    if (error instanceof StaleScanIndex) {
      return refuse(
        context,
        options.asJson,
        "invalid-input",
        `The index no longer holds the scan that covered ${wanted.display}. Run 'disktop scan ${wanted.display}' and explore again.`,
      );
    }
    throw error;
  }

  if (outcome.kind === "unavailable") {
    return refuse(
      context,
      options.asJson,
      "unsupported",
      `Disktop cannot read the index on this machine: ${outcome.capability.explanation}`,
    );
  }

  // A page of a partial scan is not a picture of the whole tree, and says so.
  const complete = snapshot.completeness.complete;
  const status = complete ? "complete" : "incomplete";
  const exitCode = complete ? EXIT.complete : EXIT.incomplete;
  const warnings = [
    ...(complete ? [] : snapshot.completeness.warnings),
    ...(outcome.page.owners === undefined ? [] : ownerWarnings(snapshot, outcome.page.namesRead === true)),
  ];

  if (options.asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: "explore",
        generatedAt: context.now(),
        status,
        exitCode,
        warnings,
        data: {
          capability: encodeCapability(AVAILABLE),
          scanId: snapshot.scanId,
          snapshotId: snapshot.id,
          sort: options.sort ?? "allocated",
          order: options.order ?? "descending",
          entries: outcome.page.entries.map(encodeIndexedEntry),
          ...(outcome.page.nextCursor === undefined ? {} : { nextCursor: outcome.page.nextCursor }),
          ...(outcome.page.typeTotals === undefined ? {} : { typeTotals: outcome.page.typeTotals.map(encodeTypeTotal) }),
          ...(outcome.page.owners === undefined
            ? {}
            : {
                owners: outcome.page.owners.map((owner) => ({
                  ownerId: owner.ownerId.toString(10),
                  ...(owner.name === undefined ? {} : { name: owner.name }),
                  entries: owner.entries.toString(10),
                  allocatedBytes: owner.allocatedBytes.toString(10),
                  apparentBytes: owner.apparentBytes.toString(10),
                })),
              }),
          completeness: encodeCompleteness(snapshot.completeness),
        },
      }),
    );
    return exitCode;
  }

  const accounting = options.sort === "apparent" ? "apparent" : snapshot.scope.accounting;
  for (const line of entryLines(outcome.page.entries, context.settings.units, accounting)) {
    context.output.stdout(`${line}\n`);
  }
  if (outcome.page.typeTotals !== undefined) {
    context.output.stdout("\n");
    for (const line of typeTotalLines(outcome.page.typeTotals, context.settings.units)) {
      context.output.stdout(`${line}\n`);
    }
  }
  if (outcome.page.owners !== undefined) {
    context.output.stdout("\n");
    for (const line of ownerLines(outcome.page.owners, context.settings.units)) {
      context.output.stdout(`${line}\n`);
    }
  }
  if (outcome.page.nextCursor !== undefined) {
    context.output.stderr(`More entries remain. Continue with --cursor ${outcome.page.nextCursor}\n`);
  }
  for (const line of warningLines(warnings)) {
    context.output.stderr(`${line}\n`);
  }
  return exitCode;
}

/** The newest snapshot one of whose roots is the path or an ancestor of it. */
function ownerWarnings(snapshot: SnapshotSummary, namesRead: boolean): Warning[] {
  const warnings: Warning[] = [];
  if (snapshot.completeness.inaccessibleDirectories > 0n || !snapshot.completeness.complete) {
    warnings.push({
      code: "owners-floor",
      message: `The scan could not read ${snapshot.completeness.inaccessibleDirectories} director${snapshot.completeness.inaccessibleDirectories === 1n ? "y" : "ies"}, so each owner's total is a floor. Reading them needs an administrator scan: a read-only 'disktop scan' run as root from a root-owned install.`,
    });
  }
  if (!namesRead) {
    warnings.push({ code: "passwd-unreadable", message: "Account names could not be read, so owners are listed by their numeric id." });
  }
  return warnings;
}

export async function newestCovering(
  context: CliContext,
  wanted: RawPath,
): Promise<SnapshotSummary | undefined> {
  const target = pathBytes(wanted);
  const snapshots = await context.storage.snapshots.list();
  return snapshots.find((snapshot) => snapshot.scope.roots.some((root) => isWithin(pathBytes(root), target)));
}

function buildFilter(options: ExploreOptions, now: Date): EntryFilter | "invalid-size" | "invalid-age" {
  const minimum = options.minSize === undefined ? undefined : parseSize(options.minSize);
  if (options.minSize !== undefined && minimum === undefined) {
    return "invalid-size";
  }
  const maximum = options.maxSize === undefined ? undefined : parseSize(options.maxSize);
  if (options.maxSize !== undefined && maximum === undefined) {
    return "invalid-size";
  }
  let olderThan: bigint | undefined;
  if (options.olderThanDays !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(options.olderThanDays)) {
      return "invalid-age";
    }
    olderThan = olderThanNanoseconds(now, Number(options.olderThanDays));
  }

  return {
    ...(minimum === undefined ? {} : { minAllocatedBytes: minimum }),
    ...(maximum === undefined ? {} : { maxAllocatedBytes: maximum }),
    ...(options.extension === undefined ? {} : { extension: options.extension.replace(/^\./, "") }),
    ...(options.name === undefined ? {} : { nameContains: options.name }),
    ...(olderThan === undefined ? {} : { modifiedBeforeNanoseconds: olderThan }),
    ...(options.kind === undefined ? {} : { kinds: [options.kind] }),
  };
}

function refuse(context: CliContext, asJson: boolean, code: "invalid-input" | "unsupported", message: string): number {
  if (asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: "explore",
        generatedAt: context.now(),
        status: "error",
        exitCode: EXIT.operationalError,
        warnings: [],
        failure: { code, message },
      }),
    );
  } else {
    context.output.stderr(`${sanitizeText(message)}\n`);
  }
  return EXIT.operationalError;
}
