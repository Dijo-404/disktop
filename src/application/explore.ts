import { CapabilityUnavailable } from "../domain/errors.js";
import type { Capability, IndexedEntry } from "../domain/models.js";
import type { AccountNamesPort } from "../ports/accounts.js";
import type {
  EntryFilter,
  EntryQuery,
  EntrySort,
  FileIndexPort,
  SortOrder,
  TypeTotal,
} from "../ports/scan.js";

/** The page size the index will return at most, fixed by the wire contract. */
export const MAX_PAGE = 1000;
export const DEFAULT_PAGE = 50;

export interface ExploreRequest {
  readonly scanId: string;
  readonly filter?: EntryFilter;
  readonly sort?: EntrySort;
  readonly order?: SortOrder;
  readonly limit?: number;
  readonly cursor?: string;
  readonly includeTypeTotals?: boolean;
  readonly includeOwnerTotals?: boolean;
}

export interface OwnerShare {
  readonly ownerId: bigint;
  readonly name?: string;
  readonly entries: bigint;
  readonly allocatedBytes: bigint;
  readonly apparentBytes: bigint;
}

export interface ExplorePage {
  readonly entries: readonly IndexedEntry[];
  readonly nextCursor?: string;
  readonly typeTotals?: readonly TypeTotal[];
  readonly owners?: readonly OwnerShare[];
  /** False when account names could not be read, so owners are ids only. */
  readonly namesRead?: boolean;
}

export type ExploreOutcome =
  | { readonly kind: "page"; readonly page: ExplorePage }
  | { readonly kind: "unavailable"; readonly capability: Capability };

export interface ExploreService {
  page(request: ExploreRequest): Promise<ExploreOutcome>;
}

/**
 * Sorted, filtered pages of one scan's index.
 *
 * Everything is asked for a page at a time. A directory's row already carries
 * the totals for its whole subtree, so ranking by size needs no second pass
 * and nothing here ever holds the tree.
 */
export function createExploreService(index: FileIndexPort, accounts?: AccountNamesPort): ExploreService {
  return {
    async page(request) {
      const query: EntryQuery = {
        scanId: request.scanId,
        filter: request.filter ?? {},
        sort: request.sort ?? "allocated",
        order: request.order ?? "descending",
        limit: boundedLimit(request.limit),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.includeTypeTotals === undefined ? {} : { includeTypeTotals: request.includeTypeTotals }),
        ...(request.includeOwnerTotals === undefined ? {} : { includeOwnerTotals: request.includeOwnerTotals }),
      };

      try {
        const page = await index.query(query);
        const names = page.ownerTotals === undefined ? undefined : await (accounts?.names() ?? new Map<bigint, string>());
        return {
          kind: "page",
          page: {
            entries: page.entries,
            ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
            ...(page.typeTotals === undefined ? {} : { typeTotals: page.typeTotals }),
            ...(page.ownerTotals === undefined || names === undefined
              ? {}
              : {
                  owners: page.ownerTotals.map((owner) => {
                    const name = names.get(owner.ownerId);
                    return { ownerId: owner.ownerId, ...(name === undefined ? {} : { name }), entries: owner.entries, allocatedBytes: owner.allocatedBytes, apparentBytes: owner.apparentBytes };
                  }),
                  namesRead: names.size > 0,
                }),
          },
        };
      } catch (error) {
        if (error instanceof CapabilityUnavailable) {
          return { kind: "unavailable", capability: error.capability };
        }
        throw error;
      }
    },
  };
}

export function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_PAGE;
  }
  return Math.min(MAX_PAGE, Math.max(1, Math.trunc(limit)));
}

/**
 * Parse a size written the way a person writes one: `1GiB`, `500MB`, `4096`.
 *
 * IEC suffixes are powers of 1024 and SI suffixes powers of 1000, and the
 * result is a `bigint`, so a filter threshold above 2^53 is still exact.
 */
export function parseSize(text: string): bigint | undefined {
  const match = /^(\d+)\s*(|B|[KMGTPE](?:i?B)?)$/i.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const digits = match[1] as string;
  const suffix = (match[2] as string).toUpperCase();
  if (suffix === "" || suffix === "B") {
    return BigInt(digits);
  }
  const base = suffix.includes("I") ? 1024n : 1000n;
  const exponent = "KMGTPE".indexOf(suffix[0] as string) + 1;
  return BigInt(digits) * base ** BigInt(exponent);
}

/** The nanosecond timestamp a file must be older than to count as stale. */
export function olderThanNanoseconds(now: Date, days: number): bigint {
  if (!Number.isFinite(days) || days < 0) {
    throw new RangeError("An age threshold is a non-negative number of days");
  }
  const milliseconds = BigInt(now.getTime()) - BigInt(Math.round(days * 86_400_000));
  return milliseconds <= 0n ? 0n : milliseconds * 1_000_000n;
}
