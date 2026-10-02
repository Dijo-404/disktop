import type { Bytes, IndexedEntry, RawPath } from "./models.js";
import { isAbsoluteNormalized, isWithin, pathBytes, rawPathFromUtf8 } from "./paths.js";
import { isRefusedAsAllowedRoot } from "./protected-paths.js";

/**
 * Cleanup somebody wrote down themselves.
 *
 * A rule is data and only data: roots, name patterns, a minimum age, a minimum
 * size, and hard limits. There is no field for a command, and no amount of
 * configuration turns one into a program Disktop runs — a configuration file
 * that could name a command is a configuration file that can be made to run
 * anything, and `config.toml` is a file other programs write to.
 *
 * What a rule produces is a finding, which goes through the same preview,
 * reviewed plan, and confirmation as anything a detector found. The rule's
 * hash travels into that plan so an apply can tell whether the rule it was
 * reviewed against is still the rule in the file.
 */
export interface CleanupRule {
  readonly name: string;
  /** Where the rule may look. Each is checked against the cleanup policy. */
  readonly roots: readonly RawPath[];
  /** Relative name patterns. `*` stops at a slash; `**` does not. */
  readonly globs: readonly string[];
  readonly excludes: readonly string[];
  readonly kinds: readonly ("file" | "directory")[];
  readonly minimumAgeDays: number;
  readonly minimumBytes: Bytes;
  /** The most entries one rule may select. Mandatory and bounded. */
  readonly maximumCount: number;
  /** The most bytes one rule may select. Mandatory and bounded. */
  readonly maximumBytes: Bytes;
}

const MAX_RULES_COUNT = 100_000;
const MAX_RULE_BYTES = 1024n ** 5n;
const MAX_AGE_DAYS = 3650;

/** Every key a rule block may hold. Anything else is a misspelling, and said so. */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "name",
  "roots",
  "globs",
  "excludes",
  "kinds",
  "minimum_age_days",
  "minimum_bytes",
  "maximum_count",
  "maximum_bytes",
]);

/**
 * Read one `[[rules]]` block, refusing anything that could not be acted on
 * safely.
 *
 * Everything is checked here rather than where the rule is used, because a
 * rule that is wrong is wrong before it has matched anything, and a
 * configuration error reported at apply time is one somebody finds out about
 * with a confirmation prompt already on screen.
 */
export function validateRule(input: unknown): CleanupRule {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RangeError("A [[rules]] block must be a table of settings");
  }
  const block = input as Record<string, unknown>;

  for (const key of Object.keys(block)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new RangeError(
        `A [[rules]] block has no '${key}' setting. Disktop rules name paths and sizes; they never name a command to run.`,
      );
    }
  }

  const name = block.name;
  if (typeof name !== "string" || name.trim() === "" || name.length > 200) {
    throw new RangeError("Every [[rules]] block needs a short 'name' so it can be reported");
  }

  const roots = textList(block.roots, "roots", `rule '${name}'`);
  if (roots.length === 0) {
    throw new RangeError(`Rule '${name}' needs at least one root; it will never search every root`);
  }
  for (const root of roots) {
    // The same check every other path goes through, over bytes rather than
    // over text, so a rule's roots are judged exactly as a target would be.
    if (!isAbsoluteNormalized(pathBytes(rawPathFromUtf8(root))) || (root !== "/" && root.endsWith("/"))) {
      throw new RangeError(`Rule '${name}': '${root}' must be an absolute, normalized path`);
    }
    if (isRefusedAsAllowedRoot(root)) {
      throw new RangeError(
        `Rule '${name}': '${root}' is a protected system root or a shared container root, and no rule may act inside one`,
      );
    }
  }

  const globs = textList(block.globs, "globs", `rule '${name}'`);
  if (globs.length === 0) {
    throw new RangeError(
      `Rule '${name}' needs at least one glob; without one it would select everything under its roots`,
    );
  }
  const excludes = block.excludes === undefined ? [] : textList(block.excludes, "excludes", `rule '${name}'`);
  for (const pattern of [...globs, ...excludes]) {
    checkPattern(name, pattern);
  }

  const kinds = readKinds(block.kinds, name);
  const minimumAgeDays = bounded(block.minimum_age_days, "minimum_age_days", name, 1, MAX_AGE_DAYS);
  const minimumBytes = BigInt(bounded(block.minimum_bytes, "minimum_bytes", name, 0, Number.MAX_SAFE_INTEGER));
  const maximumCount = bounded(block.maximum_count, "maximum_count", name, 1, MAX_RULES_COUNT);
  const maximumBytes = BigInt(bounded(block.maximum_bytes, "maximum_bytes", name, 1, Number.MAX_SAFE_INTEGER));
  if (maximumBytes > MAX_RULE_BYTES) {
    throw new RangeError(`Rule '${name}': 'maximum_bytes' is larger than any filesystem`);
  }

  return {
    name,
    roots: roots.map((root) => rawPathFromUtf8(root)),
    globs,
    excludes,
    kinds,
    minimumAgeDays,
    minimumBytes,
    maximumCount,
    maximumBytes,
  };
}

/**
 * Everything about a rule that decides what it would act on, in a fixed order.
 *
 * Hashing this is what gives a rule an identity a plan can carry: the same
 * rule written differently canonicalises the same, and a rule somebody edited
 * canonicalises differently. The hash itself is taken in `src/storage/rules.ts`,
 * because a digest needs `node:crypto` and this layer imports nothing.
 */
export function canonicalRule(rule: CleanupRule): string {
  return JSON.stringify([
    rule.name,
    rule.roots.map((root) => root.bytesBase64),
    [...rule.globs],
    [...rule.excludes],
    [...rule.kinds],
    rule.minimumAgeDays,
    rule.minimumBytes.toString(10),
    rule.maximumCount,
    rule.maximumBytes.toString(10),
  ]);
}

/**
 * Whether one indexed entry is something this rule selects.
 *
 * A root itself never matches: a rule describes what to clear out of a
 * directory, never the directory. A second hardlink never matches either,
 * because its bytes were attributed to another path and removing it frees
 * nothing the rule's byte limit could account for.
 */
export function matchesRule(rule: CleanupRule, entry: IndexedEntry, now: Date): boolean {
  if (entry.shared) {
    return false;
  }
  if (entry.kind !== "file" && entry.kind !== "directory") {
    return false;
  }
  if (!rule.kinds.includes(entry.kind)) {
    return false;
  }
  if (entry.allocatedBytes < rule.minimumBytes) {
    return false;
  }

  const cutoff = BigInt(now.getTime()) * 1_000_000n - BigInt(rule.minimumAgeDays) * 86_400_000_000_000n;
  if (entry.modifiedNanoseconds >= cutoff) {
    return false;
  }

  const relative = relativeTo(rule, entry.path);
  if (relative === undefined || relative === "") {
    return false;
  }
  if (rule.excludes.some((pattern) => globMatches(pattern, relative))) {
    return false;
  }
  return rule.globs.some((pattern) => globMatches(pattern, relative));
}

/** The entry's path below whichever root holds it, or `undefined`. */
function relativeTo(rule: CleanupRule, path: RawPath): string | undefined {
  const bytes = pathBytes(path);
  for (const root of rule.roots) {
    const rootBytes = pathBytes(root);
    if (!isWithin(rootBytes, bytes)) {
      continue;
    }
    // Matching is over display text, never over the bytes an operation
    // resolves. A name that does not decode cleanly cannot be matched by a
    // pattern somebody typed, and leaving it unmatched is the safe direction.
    const whole = path.utf8;
    if (whole === undefined) {
      return undefined;
    }
    return whole.slice(root.display.length).replace(/^\/+/, "");
  }
  return undefined;
}

/**
 * `*` matches within one path segment, `**` across segments, `?` one
 * character. Nothing else is special, and in particular there is no
 * alternation or character class: a pattern language with more in it is a
 * pattern language somebody can be surprised by.
 */
function globMatches(pattern: string, candidate: string): boolean {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?");
  return new RegExp(`^${expression}$`).test(candidate);
}

function checkPattern(rule: string, pattern: string): void {
  if (pattern === "" || pattern.length > 512) {
    throw new RangeError(`Rule '${rule}': a pattern must be between 1 and 512 characters`);
  }
  if (pattern.startsWith("/")) {
    throw new RangeError(
      `Rule '${rule}': '${pattern}' is absolute. A pattern is relative to the rule's roots.`,
    );
  }
  if (pattern.split("/").includes("..")) {
    throw new RangeError(
      `Rule '${rule}': '${pattern}' can leave its root, and a rule may not reach outside the roots it declares.`,
    );
  }
  if (pattern.includes("\0")) {
    throw new RangeError(`Rule '${rule}': a pattern may not hold a NUL byte`);
  }
}

function readKinds(value: unknown, rule: string): readonly ("file" | "directory")[] {
  if (value === undefined) {
    return ["file"];
  }
  const kinds = textList(value, "kinds", `rule '${rule}'`);
  if (kinds.length === 0 || kinds.some((kind) => kind !== "file" && kind !== "directory")) {
    throw new RangeError(`Rule '${rule}': 'kinds' takes 'file', 'directory', or both`);
  }
  return [...new Set(kinds)] as readonly ("file" | "directory")[];
}

function textList(value: unknown, key: string, where: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new RangeError(`${where}: '${key}' must be an array of quoted strings`);
  }
  return value as readonly string[];
}

function bounded(value: unknown, key: string, rule: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new RangeError(`Rule '${rule}': '${key}' must be a whole number`);
  }
  if (value < minimum || value > maximum) {
    throw new RangeError(`Rule '${rule}': '${key}' must be between ${minimum} and ${maximum}`);
  }
  return value;
}
