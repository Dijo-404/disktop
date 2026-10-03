import { olderThanNanoseconds, parseSize } from "../application/explore.js";
import type { EntryFilter, EntryKindFilter } from "../ports/scan.js";

/**
 * The filter a person types after `/`.
 *
 * Plain words match names; a few prefixed terms narrow by extension, size,
 * age, and kind. It is parsed into the same `EntryFilter` the CLI builds from
 * flags, so the TUI cannot ask the index anything the CLI cannot.
 *
 *   report            names containing "report"
 *   ext:log  .log     files with that extension
 *   >1GiB  <10MB      at least / at most this large on disk
 *   age>30            not modified for 30 days (age>30d also works)
 *   type:dir          file, dir, link, or other
 */
export interface SearchQuery {
  readonly text: string;
  readonly nameContains?: string;
  readonly extension?: string;
  readonly minBytes?: bigint;
  readonly maxBytes?: bigint;
  readonly olderThanDays?: number;
  readonly kinds?: readonly EntryKindFilter[];
}

export type SearchParse = { readonly ok: true; readonly query: SearchQuery } | { readonly ok: false; readonly message: string };

const KINDS: Readonly<Record<string, EntryKindFilter>> = {
  file: "file",
  f: "file",
  dir: "directory",
  directory: "directory",
  d: "directory",
  link: "symlink",
  symlink: "symlink",
  l: "symlink",
  other: "other",
};

export function parseSearch(input: string): SearchParse {
  const text = input.trim();
  const words: string[] = [];
  let query: { -readonly [Key in keyof SearchQuery]: SearchQuery[Key] } = { text };

  for (const term of text.split(/\s+/).filter((part) => part !== "")) {
    const lower = term.toLowerCase();
    if (lower.startsWith("ext:") || (lower.startsWith(".") && lower.length > 1 && !lower.includes("/"))) {
      const extension = lower.startsWith("ext:") ? lower.slice(4).replace(/^\./, "") : lower.slice(1);
      if (extension === "" || /[\s/]/.test(extension)) {
        return { ok: false, message: `'${term}' is not an extension. Try ext:log.` };
      }
      query = { ...query, extension };
      continue;
    }
    const size = /^(?:size)?(>=|<=|>|<)(.+)$/i.exec(term);
    if (size !== null && !/^age/i.test(term)) {
      const bytes = parseSize(size[2] as string);
      if (bytes === undefined) {
        return { ok: false, message: `'${term}' needs a size such as >1GiB or <500MB.` };
      }
      query = size[1]?.startsWith(">") === true ? { ...query, minBytes: bytes } : { ...query, maxBytes: bytes };
      continue;
    }
    const age = /^(?:age>=?|older:)(\d+)d?$/i.exec(term);
    if (age !== null) {
      query = { ...query, olderThanDays: Number(age[1]) };
      continue;
    }
    if (/^(age|older)/i.test(term)) {
      return { ok: false, message: `'${term}' needs a number of days, such as age>30.` };
    }
    if (lower.startsWith("type:")) {
      const kind = KINDS[lower.slice(5)];
      if (kind === undefined) {
        return { ok: false, message: `'${term}' is not a kind. Use type:file, type:dir, type:link, or type:other.` };
      }
      query = { ...query, kinds: [...(query.kinds ?? []), kind] };
      continue;
    }
    words.push(term);
  }

  if (words.length > 0) {
    query = { ...query, nameContains: words.join(" ") };
  }
  return { ok: true, query };
}

export function searchFilter(query: SearchQuery, now: Date): EntryFilter {
  return {
    ...(query.nameContains === undefined ? {} : { nameContains: query.nameContains }),
    ...(query.extension === undefined ? {} : { extension: query.extension, kinds: ["file"] as const }),
    ...(query.kinds === undefined ? {} : { kinds: query.kinds }),
    ...(query.minBytes === undefined ? {} : { minAllocatedBytes: query.minBytes }),
    ...(query.maxBytes === undefined ? {} : { maxAllocatedBytes: query.maxBytes }),
    ...(query.olderThanDays === undefined ? {} : { modifiedBeforeNanoseconds: olderThanNanoseconds(now, query.olderThanDays) }),
  };
}
