import type { ActionOperation } from "../domain/actions.js";
import {
  findingSize,
  type Finding,
  type FindingCategory,
  type FindingConfidence,
} from "../domain/findings.js";
import type { Capability, RawPath, Warning } from "../domain/models.js";
import { pathBytes, rawPathFromBytes, rawPathFromUtf8, sanitizeForDisplay } from "../domain/paths.js";
import type { DiscoveryEnvironment, PathFacts } from "../ports/providers.js";

const SLASH = 0x2f;

/** Why a size is absent from a provider: one port measures all of them later. */
export const UNMEASURED = "Not measured yet; footprints are measured in one pass after discovery.";

export function unmeasured(): ReturnType<typeof findingSize> {
  return findingSize(undefined, "unknown", UNMEASURED);
}

/** A path below the home directory, built from bytes so an odd home survives. */
export function underHome(environment: DiscoveryEnvironment, ...segments: readonly string[]): RawPath {
  return joinPath(environment.home, ...segments);
}

export function joinPath(base: RawPath, ...segments: readonly string[]): RawPath {
  let bytes = Buffer.from(pathBytes(base));
  for (const segment of segments) {
    if (segment === "") {
      continue;
    }
    if (bytes.length > 0 && bytes[bytes.length - 1] !== SLASH) {
      bytes = Buffer.concat([bytes, Buffer.from([SLASH])]);
    }
    bytes = Buffer.concat([bytes, Buffer.from(segment, "utf8")]);
  }
  return rawPathFromBytes(new Uint8Array(bytes));
}

/**
 * The last segment of a path, safe to print.
 *
 * Detectors build titles out of this, and titles are written to a terminal
 * unescaped. A directory named with an escape sequence would otherwise colour
 * the output, and one with a newline in it would split a row in two and could
 * scroll a real finding off the screen. The sanitized form is the only form a
 * detector ever sees, so no detector can forget.
 */
export function basename(path: RawPath): string {
  const text = path.display;
  return text.slice(text.lastIndexOf("/") + 1);
}

/**
 * Text that came from outside Disktop, made safe to print.
 *
 * A package name, a Steam manifest, a ZFS dataset, a drive model: all of them
 * reach a title, and a title reaches a terminal.
 */
export function safeText(value: string, maximumLength = 120): string {
  return sanitizeForDisplay(new Uint8Array(Buffer.from(value, "utf8"))).slice(0, maximumLength);
}

/** A slug fragment built from text Disktop did not write. */
export function safeSlug(value: string, maximumLength = 64): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maximumLength);
  return cleaned === "" ? "unnamed" : cleaned;
}

export function parentOf(path: RawPath): RawPath {
  const bytes = pathBytes(path);
  let end = bytes.length;
  while (end > 1 && bytes[end - 1] !== SLASH) {
    end -= 1;
  }
  return rawPathFromBytes(bytes.slice(0, Math.max(1, end - 1)));
}

/**
 * A stable, printable id fragment for a path.
 *
 * The readable part is the last two segments, which is what a person
 * recognizes; the hash is of the whole byte sequence, which is what keeps two
 * environments called `base` under different prefixes apart and keeps the id
 * the same on the next run. A name that is not valid UTF-8 contributes only
 * its hash rather than a mangled transliteration.
 */
export function slugForPath(path: RawPath): string {
  const text = path.utf8;
  const readable =
    text === undefined
      ? "path"
      : safeSlug(
          text
            .split("/")
            .filter((segment) => segment !== "")
            .slice(-2)
            .join("-"),
          48,
        );
  return `${readable === "unnamed" ? "path" : readable}-${hash(pathBytes(path))}`;
}

/** FNV-1a over the path's bytes, printed base-36; short, stable, and total. */
function hash(bytes: Uint8Array): string {
  let value = 0x811c9dc5;
  for (const byte of bytes) {
    value = Math.imul(value ^ byte, 0x01000193) >>> 0;
  }
  return value.toString(36).padStart(7, "0");
}

export interface FindingInput {
  readonly providerId: string;
  readonly providerVersion: number;
  readonly category: FindingCategory;
  readonly slug: string;
  readonly title: string;
  readonly evidence: readonly string[];
  readonly paths?: readonly RawPath[];
  readonly managerScope?: string;
  readonly size?: Finding["size"];
  readonly confidence?: FindingConfidence;
  readonly capability?: Capability;
  readonly actions?: readonly ActionOperation[];
  readonly regenerationCost?: string;
  readonly active?: boolean;
}

/** Operations that act on paths, as against going through a package manager. */
const GENERIC_ACTIONS: readonly ActionOperation[] = [
  "trash",
  "permanent",
  "move",
  "compress",
  "dedup-hardlink",
];

/**
 * Build a finding with the defaults a read-only detector wants.
 *
 * Two rules are applied here rather than left to each detector to remember.
 * Data that is in use offers no generic action: a browser profile and a model
 * store are findings worth reporting and not things to move to Trash behind
 * somebody's back. And a finding that names no path offers nothing generic,
 * because there is nothing for a generic action to act on; only a manager can
 * reach a manager's own state.
 *
 * A detector can still narrow this further, and `clean plan` re-checks the
 * path against the protected-path policy afterwards. This is the floor.
 */
export function buildFinding(input: FindingInput): Finding {
  const requested = input.actions ?? [];
  const active = input.active ?? false;
  const paths = input.paths ?? [];
  const actions =
    active || paths.length === 0
      ? requested.filter((action) => !GENERIC_ACTIONS.includes(action))
      : requested;

  return {
    id: `${input.providerId}:${input.slug}`,
    providerId: input.providerId,
    providerVersion: input.providerVersion,
    category: input.category,
    title: input.title,
    evidence: [...input.evidence],
    paths: [...(input.paths ?? [])],
    ...(input.managerScope === undefined ? {} : { managerScope: input.managerScope }),
    size: input.size ?? unmeasured(),
    confidence: input.confidence ?? "observed",
    capability: input.capability ?? { status: "available", explanation: "The path was read." },
    availableActionIds: [...actions],
    ...(input.regenerationCost === undefined ? {} : { regenerationCost: input.regenerationCost }),
    active: input.active ?? false,
  };
}

export async function factsOf(
  environment: DiscoveryEnvironment,
  path: RawPath,
): Promise<PathFacts | undefined> {
  return environment.paths.facts(path);
}

export async function isDirectory(environment: DiscoveryEnvironment, path: RawPath): Promise<boolean> {
  return (await environment.paths.facts(path))?.kind === "directory";
}

export async function exists(environment: DiscoveryEnvironment, path: RawPath): Promise<boolean> {
  return (await environment.paths.facts(path)) !== undefined;
}

/** The directories directly inside a path, skipping anything that is not one. */
export async function childDirectories(
  environment: DiscoveryEnvironment,
  path: RawPath,
): Promise<readonly RawPath[]> {
  const children = await environment.paths.list(path);
  const directories: RawPath[] = [];
  for (const child of children) {
    if (await isDirectory(environment, child)) {
      directories.push(child);
    }
  }
  return directories;
}

/** The candidate roots that are really there, in the order they were offered. */
export async function existingPaths(
  environment: DiscoveryEnvironment,
  candidates: readonly RawPath[],
): Promise<readonly RawPath[]> {
  const found: RawPath[] = [];
  for (const candidate of candidates) {
    if (await exists(environment, candidate)) {
      found.push(candidate);
    }
  }
  return found;
}

/**
 * The capability for a detector whose subject is a set of directories.
 *
 * An absent tool and an absent directory are the same fact to a reader: this
 * machine has nothing of that kind. Saying so beats reporting zero bytes.
 */
export function rootsCapability(found: readonly RawPath[], what: string): Capability {
  if (found.length > 0) {
    return { status: "available", explanation: `${found.length} ${what} exist.` };
  }
  return { status: "missing-tool", explanation: `No ${what} exist under this home directory.` };
}

export function noStoredScan(what: string): Warning {
  return {
    code: "no-stored-scan",
    message: `No stored scan covers the home directory, so ${what} were not looked for. Run 'disktop scan ~' first.`,
  };
}

/** An absolute path from a configuration or environment value, or nothing. */
export function absolutePath(value: string | undefined): RawPath | undefined {
  if (value === undefined || !value.startsWith("/")) {
    return undefined;
  }
  return rawPathFromUtf8(value);
}
