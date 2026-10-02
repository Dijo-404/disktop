import type { Bytes, RawPath } from "./models.js";
import { isWithin, pathBytes } from "./paths.js";

/**
 * Which copy of a set of identical files survives.
 *
 * Every rule here is a rule about *which* file to keep, never about whether to
 * keep one: a group always keeps exactly one member, so no rule can be read as
 * an instruction to remove every copy of something.
 */
export type KeepRule = "oldest" | "newest" | "in-path";

export const KEEP_RULES: readonly KeepRule[] = ["oldest", "newest", "in-path"];

/**
 * One file in a duplicate group, as the helper found it live.
 *
 * `modifiedNanoseconds` is the only timestamp here, and it is deliberately the
 * only one: the index holds no access time, and on a `relatime` or `noatime`
 * mount an access time would not mean what a reader would take it to mean. See
 * `domain/staleness.ts` for the same rule stated for `find stale`.
 */
export interface DuplicateFile {
  readonly path: RawPath;
  readonly device: bigint;
  readonly inode: bigint;
  readonly apparentBytes: Bytes;
  readonly modifiedNanoseconds: bigint;
  readonly ownerId: bigint;
  readonly groupId: bigint;
  /** Permission bits only, without the file-type bits. */
  readonly permissions: number;
}

export interface DuplicateGroup {
  readonly apparentBytes: Bytes;
  /** Lowercase hexadecimal. It identifies this group within one result. */
  readonly digest: string;
  readonly files: readonly DuplicateFile[];
}

export type KeepDecision =
  | {
      readonly kind: "decided";
      readonly kept: DuplicateFile;
      readonly others: readonly DuplicateFile[];
      /** What the choice rests on, including which timestamp it read. */
      readonly basis: string;
      /** True when the rule could not separate them and order decided. */
      readonly arbitrary: boolean;
    }
  | { readonly kind: "undecidable"; readonly reason: string };

const MODIFIED_BASIS = "modification time, which is when the file's contents last changed";

/**
 * Choose which copy survives, or refuse to choose.
 *
 * A rule that cannot separate the members says so rather than falling through
 * to another rule. Somebody who asked to keep whatever is under `~/Pictures`
 * and has no copy there is not asking to keep the oldest instead; answering
 * that question with a different question's answer is how the wrong file goes.
 */
export function applyKeepRule(
  group: DuplicateGroup,
  rule: KeepRule,
  keepUnder?: RawPath,
): KeepDecision {
  if (group.files.length < 2) {
    throw new RangeError("A keep rule needs a group of at least two files");
  }
  if (rule === "in-path" && keepUnder === undefined) {
    throw new RangeError("'in-path' needs the directory to keep under");
  }

  if (rule === "in-path") {
    const under = keepUnder as RawPath;
    const underBytes = pathBytes(under);
    const inside = group.files.filter((file) => isWithin(underBytes, pathBytes(file.path)));
    if (inside.length === 0) {
      return {
        kind: "undecidable",
        reason: `No copy of this file is under ${under.display}, so there is nothing there to keep.`,
      };
    }
    if (inside.length > 1) {
      return {
        kind: "undecidable",
        reason: `${inside.length} copies are under ${under.display}, so the rule does not say which one to keep.`,
      };
    }
    const kept = inside[0] as DuplicateFile;
    return {
      kind: "decided",
      kept,
      others: group.files.filter((file) => file !== kept),
      basis: `the only copy under ${under.display}`,
      arbitrary: false,
    };
  }

  // Ordering is total and stable: timestamp first, then the path bytes. Without
  // the second key two files sharing a timestamp would be separated by whatever
  // order the helper happened to report, and the same group would keep a
  // different file on the next run.
  const sorted = [...group.files].sort((left, right) => {
    if (left.modifiedNanoseconds !== right.modifiedNanoseconds) {
      const earlierFirst = left.modifiedNanoseconds < right.modifiedNanoseconds ? -1 : 1;
      return rule === "oldest" ? earlierFirst : -earlierFirst;
    }
    return left.path.bytesBase64 < right.path.bytesBase64 ? -1 : 1;
  });

  const kept = sorted[0] as DuplicateFile;
  const tied = sorted.filter((file) => file.modifiedNanoseconds === kept.modifiedNanoseconds);
  const arbitrary = tied.length > 1;

  return {
    kind: "decided",
    kept,
    others: sorted.slice(1),
    basis: arbitrary
      ? `${tied.length} copies share the same modification time, so the first path in order was kept; the choice between them was arbitrary`
      : `${rule === "oldest" ? "the earliest" : "the latest"} ${MODIFIED_BASIS}`,
    arbitrary,
  };
}

/**
 * What removing every copy but one would free.
 *
 * One copy always stays, so this is the group's size times one fewer than its
 * members. A group of two reclaims one copy's worth, never two.
 */
export function reclaimableBytes(group: DuplicateGroup): Bytes {
  if (group.files.length < 2) {
    return 0n;
  }
  return group.apparentBytes * BigInt(group.files.length - 1);
}
