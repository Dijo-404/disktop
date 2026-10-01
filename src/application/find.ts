import type { OperationFailure } from "../domain/errors.js";
import type { Capability, IndexedEntry, RawPath } from "../domain/models.js";
import type { EntryFilter } from "../ports/scan.js";
import { DEFAULT_PAGE, boundedLimit, type ExploreService } from "./explore.js";

/** What `disktop find` can be asked for. Duplicates and stale belong to Phase 5. */
export type FindKind = "empty" | "broken" | "duplicates" | "stale";

export const FIND_KINDS: readonly FindKind[] = ["duplicates", "stale", "empty", "broken"];

export interface FindRequest {
  readonly kind: FindKind;
  readonly scanId: string;
  readonly path: RawPath;
  readonly limit?: number;
  readonly cursor?: string;
}

export type FindOutcome =
  | {
      readonly kind: "found";
      readonly entries: readonly IndexedEntry[];
      readonly nextCursor?: string;
    }
  | { readonly kind: "refused"; readonly failure: OperationFailure }
  | { readonly kind: "unavailable"; readonly capability: Capability };

export interface FindService {
  find(request: FindRequest): Promise<FindOutcome>;
}

/**
 * Empty directories and broken links, answered from a stored scan.
 *
 * Both are facts the walk already established: it counted each directory's
 * entries as it read them and asked once per symlink whether the target
 * resolved. Walking the tree again to rediscover either would cost what the
 * scan cost, so this is a filter over the index and never a traversal.
 *
 * A directory the scan could not open carries no child count at all, so it can
 * never answer a search for empty ones.
 */
export function createFindService(index: Pick<ExploreService, "page">): FindService {
  return {
    async find(request) {
      const filter = filterFor(request.kind);
      if (filter === undefined) {
        return {
          kind: "refused",
          failure: {
            code: "not-implemented",
            message: `'disktop find ${request.kind}' is declared but not implemented yet. 'empty' and 'broken' work today.`,
          },
        };
      }

      const outcome = await index.page({
        scanId: request.scanId,
        filter: { ...filter, underPath: request.path },
        sort: "allocated",
        order: "descending",
        limit: boundedLimit(request.limit ?? DEFAULT_PAGE),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      });

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

function filterFor(kind: FindKind): EntryFilter | undefined {
  if (kind === "empty") {
    return { kinds: ["directory"], maxChildEntries: 0n };
  }
  if (kind === "broken") {
    return { kinds: ["symlink"], broken: true };
  }
  return undefined;
}
