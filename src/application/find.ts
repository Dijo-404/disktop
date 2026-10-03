import type { KeepRule } from "../domain/duplicates.js";
import { StaleScanIndex, type OperationFailure } from "../domain/errors.js";
import type { Capability, IndexedEntry, RawPath } from "../domain/models.js";
import { stalenessBasis, type StalenessBasis } from "../domain/staleness.js";
import type { InventoryPort } from "../ports/inventory.js";
import type { EntryFilter } from "../ports/scan.js";
import type { DuplicateOutcome, DuplicateService } from "./duplicates.js";
import { DEFAULT_PAGE, boundedLimit, type ExploreOutcome, type ExploreService } from "./explore.js";

/** What `disktop find` can be asked for. */
export type FindKind = "empty" | "broken" | "duplicates" | "stale";

export const FIND_KINDS: readonly FindKind[] = ["duplicates", "stale", "empty", "broken"];

export interface FindRequest {
  readonly kind: FindKind;
  readonly scanId: string;
  readonly path: RawPath;
  readonly limit?: number;
  readonly cursor?: string;
  /** Duplicates only: which copy of each group survives. */
  readonly rule?: KeepRule;
  /** Duplicates only, and required by the `in-path` rule. */
  readonly keepUnder?: RawPath;
  /** Duplicates only: files smaller than this are not candidates. */
  readonly minimumBytes?: bigint;
  /** Stale only: the cutoff, in nanoseconds since the epoch. */
  readonly staleBeforeNanoseconds?: bigint;
}

export type FindOutcome =
  | {
      readonly kind: "found";
      readonly entries: readonly IndexedEntry[];
      readonly nextCursor?: string;
    }
  | { readonly kind: "duplicates"; readonly result: DuplicateOutcome }
  | {
      readonly kind: "stale";
      readonly entries: readonly IndexedEntry[];
      readonly nextCursor?: string;
      /** What the dates mean, and what the mount lets Disktop say about them. */
      readonly basis: StalenessBasis;
    }
  | { readonly kind: "refused"; readonly failure: OperationFailure }
  | { readonly kind: "unavailable"; readonly capability: Capability };

export interface FindService {
  find(request: FindRequest, signal?: AbortSignal): Promise<FindOutcome>;
}

/** Files smaller than this are not offered as duplicates unless asked for. */
export const DEFAULT_DUPLICATE_MINIMUM_BYTES = 1024n * 1024n;

/**
 * Empty directories, broken links, and duplicates, answered from a stored scan.
 *
 * The first two are facts the walk already established: it counted each
 * directory's entries as it read them and asked once per symlink whether the
 * target resolved. Walking the tree again to rediscover either would cost what
 * the scan cost, so they are a filter over the index and never a traversal.
 *
 * Duplicates are different in kind: no column in the index can answer them,
 * because the answer depends on content. They go to the helper, which reads as
 * little of that content as it can, and come back as groups rather than as a
 * page of rows — so they travel in their own outcome rather than being flattened
 * into a list that would lose which file pairs with which.
 *
 * A directory the scan could not open carries no child count at all, so it can
 * never answer a search for empty ones.
 */
export function createFindService(
  index: Pick<ExploreService, "page">,
  duplicates?: Pick<DuplicateService, "find">,
  inventory?: Pick<InventoryPort, "mountOptionsFor">,
): FindService {
  return {
    async find(request, signal = new AbortController().signal) {
      if (request.kind === "duplicates") {
        if (duplicates === undefined) {
          return {
            kind: "refused",
            failure: {
              code: "unsupported",
              message:
                "Finding duplicates needs the Disktop helper, which is not available on this machine.",
            },
          };
        }
        const result = await duplicates.find(
          {
            scanId: request.scanId,
            path: request.path,
            rule: request.rule ?? "oldest",
            ...(request.keepUnder === undefined ? {} : { keepUnder: request.keepUnder }),
            minimumBytes: request.minimumBytes ?? DEFAULT_DUPLICATE_MINIMUM_BYTES,
            ...(request.limit === undefined ? {} : { maximumGroups: boundedLimit(request.limit) }),
          },
          signal,
        );
        return { kind: "duplicates", result };
      }

      if (request.kind === "stale") {
        if (request.staleBeforeNanoseconds === undefined) {
          return {
            kind: "refused",
            failure: {
              code: "invalid-input",
              message:
                "A stale search needs a cutoff. Pass '--older-than DAYS' or set find.stale_after_days.",
            },
          };
        }

        // The mount's options change the sentence, never the measurement. A
        // mount nobody could read reads as unknown rather than as maintained,
        // because a reading that did not happen is not a reassuring one.
        const options = inventory === undefined
          ? undefined
          : await inventory.mountOptionsFor(request.path);
        const basis = stalenessBasis(options);

        const page = await pageOf(index, request, {
          scanId: request.scanId,
          filter: {
            kinds: ["file"],
            underPath: request.path,
            modifiedBeforeNanoseconds: request.staleBeforeNanoseconds,
          },
          sort: "allocated",
          order: "descending",
          limit: boundedLimit(request.limit ?? DEFAULT_PAGE),
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        });
        if (page.kind === "refused") {
          return page;
        }
        if (page.kind === "unavailable") {
          return { kind: "unavailable", capability: page.capability };
        }
        return {
          kind: "stale",
          entries: page.page.entries,
          ...(page.page.nextCursor === undefined ? {} : { nextCursor: page.page.nextCursor }),
          basis,
        };
      }

      const filter = filterFor(request.kind);
      if (filter === undefined) {
        return {
          kind: "refused",
          failure: {
            code: "not-implemented",
            message: `'disktop find ${request.kind}' is not something Disktop can search for.`,
          },
        };
      }

      const outcome = await pageOf(index, request, {
        scanId: request.scanId,
        filter: { ...filter, underPath: request.path },
        sort: "allocated",
        order: "descending",
        limit: boundedLimit(request.limit ?? DEFAULT_PAGE),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      });

      if (outcome.kind === "refused") {
        return outcome;
      }
      if (outcome.kind === "unavailable") {
        return { kind: "unavailable", capability: outcome.capability };
      }
      return {
        kind: "found",
        entries: outcome.page.entries,
        ...(outcome.page.nextCursor === undefined ? {} : { nextCursor: outcome.page.nextCursor }),
      };
    },
  };
}

/**
 * One page from the index, with a pruned scan turned into a refusal that says
 * what to run. The index keeps only the newest scans, so a snapshot can
 * outlive its rows; that is routine, not a fault.
 */
async function pageOf(
  index: Pick<ExploreService, "page">,
  request: FindRequest,
  query: Parameters<ExploreService["page"]>[0],
): Promise<ExploreOutcome | { readonly kind: "refused"; readonly failure: OperationFailure }> {
  try {
    return await index.page(query);
  } catch (error) {
    if (error instanceof StaleScanIndex) {
      return {
        kind: "refused",
        failure: {
          code: "invalid-input",
          message: `${error.message} Run 'disktop scan ${request.path.display}' and search again.`,
        },
      };
    }
    throw error;
  }
}

function filterFor(kind: FindKind): EntryFilter | undefined {
  if (kind === "empty") {
    return { kinds: ["directory"], maxChildEntries: 0n };
  }
  if (kind === "broken") {
    return { kinds: ["symlink"], broken: true };
  }
  return undefined;
}
