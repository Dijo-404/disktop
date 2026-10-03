import type { ActionOperation } from "./actions.js";
import type { Bytes, Capability, RawPath } from "./models.js";
import { isWithin, pathBytes } from "./paths.js";

const SLASH = 0x2f;

/**
 * What a finding is about. The set is closed so the public JSON can be, and so
 * a surface can group findings without parsing a free-text label.
 */
export type FindingCategory =
  | "dev-environment"
  | "project-artifact"
  | "language-cache"
  | "ai-cache"
  | "ide-cache"
  | "browser-cache"
  | "app-cache"
  | "game-data"
  | "vm-image"
  | "system-snapshot"
  | "installed-app"
  | "log"
  | "crash-dump"
  | "swap"
  | "temporary"
  | "diagnostic"
  | "per-user-usage"
  | "package-cache"
  | "container-data"
  | "old-kernel";

export const FINDING_CATEGORIES: readonly FindingCategory[] = [
  "dev-environment",
  "project-artifact",
  "language-cache",
  "ai-cache",
  "ide-cache",
  "browser-cache",
  "app-cache",
  "game-data",
  "vm-image",
  "system-snapshot",
  "installed-app",
  "log",
  "crash-dump",
  "swap",
  "temporary",
  "diagnostic",
  "per-user-usage",
  "package-cache",
  "container-data",
  "old-kernel",
];

/**
 * Where a byte count came from. There is no basis that means "zero because we
 * did not look": an unmeasured footprint is `unknown` and carries no number.
 */
export type SizeBasis =
  | "measured-allocated"
  | "measured-apparent"
  | "manager-reported"
  | "stat"
  | "unknown";

export interface FindingSize {
  readonly bytes?: Bytes;
  readonly basis: SizeBasis;
  /** What the number means and what it leaves out. Never empty. */
  readonly explanation: string;
}

export type FindingConfidence = "observed" | "likely" | "uncertain";

/**
 * One thing a provider noticed, with everything a reviewer needs to judge it.
 *
 * A finding is a suggestion. It names the bytes it is about, where its number
 * came from, how sure the provider is, and which operations a later phase
 * could offer; it never carries out any of them.
 */
export interface Finding {
  /** `<providerId>:<slug>`. Stable across releases, so a saved plan keeps its meaning. */
  readonly id: string;
  readonly providerId: string;
  /** Bumped when the rule changes, so an old plan cannot silently mean something new. */
  readonly providerVersion: number;
  readonly category: FindingCategory;
  readonly title: string;
  readonly evidence: readonly string[];
  /** The bytes this finding is about. Empty when the scope is a manager's. */
  readonly paths: readonly RawPath[];
  /** A bounded manager selection, never a shell line. */
  readonly managerScope?: string;
  /** The manager action a plan for this finding would fix. */
  readonly managerAction?: string;
  readonly size: FindingSize;
  readonly confidence: FindingConfidence;
  readonly capability: Capability;
  readonly availableActionIds: readonly ActionOperation[];
  /** What it would cost to get this data back, when it is reproducible. */
  readonly regenerationCost?: string;
  /** True when the data is in use: a profile, a model store, a running image. */
  readonly active: boolean;
}

export interface CategoryTotal {
  readonly category: FindingCategory;
  readonly findings: number;
  readonly bytes: Bytes;
  /** How many of those findings contributed nothing, because nothing measured them. */
  readonly unmeasured: number;
  /** How many sit inside another finding, so their bytes are already counted. */
  readonly nested: number;
}

export interface DroppedFinding {
  readonly id: string;
  readonly supersededBy: string;
}

/**
 * Build a size that cannot be read as a number without a source.
 *
 * A number with an `unknown` basis and a basis with no number are both
 * refused, because either one would let an unmeasured footprint reach a
 * surface looking like a measurement.
 */
export function findingSize(bytes: Bytes | undefined, basis: SizeBasis, explanation: string): FindingSize {
  if (explanation.trim() === "") {
    throw new RangeError("A size must explain what it measured");
  }
  if (basis === "unknown") {
    if (bytes !== undefined) {
      throw new RangeError("An unknown size cannot carry a byte count");
    }
    return { basis, explanation };
  }
  if (bytes === undefined) {
    throw new RangeError(`A ${basis} size must carry a byte count`);
  }
  if (bytes < 0n) {
    throw new RangeError("A byte count cannot be negative");
  }
  return { bytes, basis, explanation };
}

/**
 * Collapse findings that describe the same bytes.
 *
 * Two providers can legitimately reach the same directory: an Electron
 * detector and a browser detector both see `~/.config/Code/Cache`. Reporting
 * both would double the estimate a user reads. The broader scope wins, and the
 * narrower finding's id is recorded in the survivor's evidence so nothing
 * disappears silently.
 *
 * A provider is trusted about its own tree: `dev.conda` reporting a prefix and
 * the `pkgs` cache inside it is describing structure, not repeating itself.
 */
export function deduplicateFindings(findings: readonly Finding[]): {
  readonly kept: readonly Finding[];
  readonly dropped: readonly DroppedFinding[];
} {
  // Broadest first, so the finding that survives is the one that covers most.
  const ordered = [...findings].sort((left, right) => breadth(left) - breadth(right));
  const kept: Finding[] = [];
  const absorbed = new Map<string, string[]>();
  const dropped: DroppedFinding[] = [];
  const seenIds = new Map<string, string>();

  for (const candidate of ordered) {
    const duplicateOf = seenIds.get(candidate.id);
    if (duplicateOf !== undefined) {
      dropped.push({ id: candidate.id, supersededBy: duplicateOf });
      continue;
    }

    const cover = kept.find((survivor) => covers(survivor, candidate));
    if (cover !== undefined) {
      dropped.push({ id: candidate.id, supersededBy: cover.id });
      absorbed.set(cover.id, [...(absorbed.get(cover.id) ?? []), candidate.id]);
      continue;
    }

    seenIds.set(candidate.id, candidate.id);
    kept.push(candidate);
  }

  return {
    kept: kept.map((survivor) => {
      const names = absorbed.get(survivor.id);
      if (names === undefined) {
        return survivor;
      }
      return { ...survivor, evidence: [...survivor.evidence, `Also covers ${names.join(", ")}.`] };
    }),
    dropped,
  };
}

/** Largest first, with everything unmeasured last; total and stable. */
export function orderFindings(findings: readonly Finding[]): readonly Finding[] {
  return [...findings].sort((left, right) => {
    const leftBytes = left.size.bytes;
    const rightBytes = right.size.bytes;
    if (leftBytes !== undefined && rightBytes !== undefined && leftBytes !== rightBytes) {
      return leftBytes > rightBytes ? -1 : 1;
    }
    if ((leftBytes === undefined) !== (rightBytes === undefined)) {
      return leftBytes === undefined ? 1 : -1;
    }
    if (left.category !== right.category) {
      return left.category < right.category ? -1 : 1;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/**
 * Bytes per category, in the order the categories first appear.
 *
 * Two things never reach a total. An unmeasured finding adds nothing and is
 * counted separately, so a total cannot be read as covering findings whose
 * size nobody established. And a finding that sits inside another finding adds
 * nothing either: one provider may describe a tree and its parts — the browser
 * detector reports a profile and the caches inside it — and adding both would
 * say the category holds more bytes than the filesystem does.
 */
export function categoryTotals(findings: readonly Finding[]): readonly CategoryTotal[] {
  const nestedIds = nestedFindings(findings);
  const totals = new Map<FindingCategory, { findings: number; bytes: Bytes; unmeasured: number; nested: number }>();
  for (const entry of findings) {
    const current = totals.get(entry.category) ?? { findings: 0, bytes: 0n, unmeasured: 0, nested: 0 };
    const nested = nestedIds.has(entry);
    totals.set(entry.category, {
      findings: current.findings + 1,
      bytes: current.bytes + (nested ? 0n : entry.size.bytes ?? 0n),
      unmeasured: current.unmeasured + (entry.size.bytes === undefined ? 1 : 0),
      nested: current.nested + (nested ? 1 : 0),
    });
  }
  return [...totals].map(([category, total]) => ({ category, ...total }));
}

/** Path bytes as a string key, one character per byte, so prefixes compare as strings. */
function byteKey(bytes: Uint8Array): string {
  let key = "";
  for (const byte of bytes) {
    key += String.fromCharCode(byte);
  }
  return key;
}

/**
 * The findings every one of whose paths lies strictly under a path some other
 * finding claims.
 *
 * Asking each finding about every other one is quadratic, and discovery can
 * return over a thousand findings, so this indexes every claimed path once and
 * then looks up each path's proper ancestors: the bytes before each slash.
 * That is the same question `isWithin` answers, for the parents that a
 * normalized path can have.
 */
function nestedFindings(findings: readonly Finding[]): ReadonlySet<Finding> {
  const owners = new Map<string, Set<string>>();
  for (const finding of findings) {
    for (const path of finding.paths) {
      const bytes = pathBytes(path);
      // A claimed directory written with a trailing slash still contains what
      // is below it, as `isWithin` treats it.
      const trimmed = bytes.length > 1 && bytes[bytes.length - 1] === SLASH ? bytes.subarray(0, bytes.length - 1) : bytes;
      const key = byteKey(trimmed);
      const ids = owners.get(key) ?? new Set<string>();
      ids.add(finding.id);
      owners.set(key, ids);
    }
  }

  const nested = new Set<Finding>();
  for (const finding of findings) {
    if (finding.paths.length === 0) {
      continue;
    }
    const inside = finding.paths.every((path) => {
      const bytes = pathBytes(path);
      for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] !== SLASH) {
          continue;
        }
        // The root is the ancestor before the first slash; a path that is only
        // the root has no proper ancestor.
        if (index === 0 && bytes.length === 1) {
          break;
        }
        const ancestor = byteKey(index === 0 ? bytes.subarray(0, 1) : bytes.subarray(0, index));
        const ids = owners.get(ancestor);
        if (ids !== undefined && [...ids].some((id) => id !== finding.id)) {
          return true;
        }
      }
      return false;
    });
    if (inside) {
      nested.add(finding);
    }
  }
  return nested;
}

/** A finding covers another when it is from a different provider and holds every path. */
function covers(survivor: Finding, candidate: Finding): boolean {
  if (survivor.providerId === candidate.providerId || candidate.paths.length === 0) {
    return false;
  }
  return candidate.paths.every((path) =>
    survivor.paths.some((owned) => isWithin(pathBytes(owned), pathBytes(path))),
  );
}

/** The shortest path a finding claims; a manager scope claims none. */
function breadth(finding: Finding): number {
  if (finding.paths.length === 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.min(...finding.paths.map((path) => pathBytes(path).length));
}
