import { findingSize, type Finding } from "../../domain/findings.js";
import type { IndexedEntry, RawPath, Warning } from "../../domain/models.js";
import { matchesRule, type CleanupRule } from "../../domain/rules.js";
import type { DiscoveryEnvironment, FindingProvider } from "../../ports/providers.js";
import { buildFinding } from "../support.js";

const ID = "rules";
const VERSION = 1;

/** Index rows one rule may consider. Its own limits narrow this further. */
const SEARCH_LIMIT = 1000;

/**
 * Cleanup somebody wrote down themselves, turned into findings.
 *
 * It has the same shape as every other detector and deliberately no more
 * power. It reads a stored scan's index — it never walks a tree, never runs a
 * command, and never removes anything — and what it produces goes through the
 * same preview, reviewed plan, and confirmation as a finding Disktop's own
 * detectors made.
 *
 * The rule's limits are enforced here, during selection, rather than at apply
 * time. A rule that says "at most twenty gigabytes" and is shown a plan for
 * two hundred has already failed at the thing somebody wrote the limit for.
 */
export function createRulesProvider(): FindingProvider {
  return {
    id: ID,
    version: VERSION,
    categories: ["temporary"],

    async probe(environment) {
      return environment.rules.length === 0
        ? { status: "available", explanation: "No cleanup rules are configured." }
        : {
            status: "available",
            explanation: `${environment.rules.length} cleanup rule(s) from config.toml.`,
          };
    },

    async discover(environment, signal) {
      const findings: Finding[] = [];
      const warnings: Warning[] = [];
      let complete = true;

      for (const rule of environment.rules) {
        if (signal.aborted) {
          complete = false;
          warnings.push({
            code: "cancelled",
            message: "The search stopped before every rule had been applied.",
          });
          break;
        }

        const selection = await select(environment, rule, warnings);
        if (!selection.searched) {
          complete = false;
          continue;
        }
        if (selection.paths.length === 0) {
          continue;
        }
        findings.push(toFinding(rule, selection));
      }

      return { findings, warnings, complete };
    },
  };
}

interface Selection {
  readonly paths: readonly RawPath[];
  readonly bytes: bigint;
  readonly searched: boolean;
  /** True when a limit stopped the selection short of everything that matched. */
  readonly truncated: boolean;
  /** True when a root's own scan did not reach everything under it. */
  readonly partialScan: boolean;
}

async function select(
  environment: DiscoveryEnvironment,
  rule: CleanupRule,
  warnings: Warning[],
): Promise<Selection> {
  const paths: RawPath[] = [];
  let bytes = 0n;
  let searched = true;
  let truncated = false;
  let partialScan = false;

  for (const root of rule.roots) {
    const reading = await environment.index.entriesUnder(root, SEARCH_LIMIT);
    if (!reading.searched) {
      searched = false;
      warnings.push({
        code: "no-scan",
        message: `Rule '${rule.name}' could not run: no stored scan covers ${root.display}. Run 'disktop scan ${root.display}' first.`,
        path: root,
      });
      continue;
    }
    partialScan ||= reading.truncated;

    for (const entry of reading.entries) {
      if (!matchesRule(rule, entry, environment.now)) {
        continue;
      }
      // Both limits stop the selection rather than capping a total afterwards:
      // a rule's limit is a statement about what it may act on, and a plan
      // built past it would be a plan nobody's limit described.
      if (paths.length >= rule.maximumCount) {
        truncated = true;
        break;
      }
      if (bytes + entry.allocatedBytes > rule.maximumBytes) {
        truncated = true;
        break;
      }
      paths.push(entry.path);
      bytes += entry.allocatedBytes;
    }
  }

  return { paths, bytes, searched, truncated, partialScan };
}

function toFinding(rule: CleanupRule, selection: Selection): Finding {
  const evidence = [
    `Selected by the cleanup rule '${rule.name}' in config.toml.`,
    `It covers ${describe(rule.globs)} under ${rule.roots.map((root) => root.display).join(", ")}, not modified for ${rule.minimumAgeDays} day(s).`,
  ];
  if (rule.excludes.length > 0) {
    evidence.push(`It leaves out ${describe(rule.excludes)}.`);
  }
  if (selection.truncated) {
    evidence.push(
      `The rule's own limit of ${rule.maximumCount} entries and ${rule.maximumBytes} bytes stopped the selection, so this is not everything the rule matches.`,
    );
  }
  if (selection.partialScan) {
    evidence.push("The scan this reads from did not reach everything under the rule's roots.");
  }

  return buildFinding({
    providerId: ID,
    providerVersion: VERSION,
    // The rule's name decides the slug, so the same rule keeps the same
    // finding id between runs and two rules never collide.
    slug: ruleSlug(rule.name),
    category: "temporary",
    title: `Cleanup rule: ${rule.name}`,
    evidence,
    paths: selection.paths,
    size: findingSize(
      selection.bytes,
      "measured-allocated",
      "Blocks on disk for the entries this rule selected, as the scan that covered them measured them.",
    ),
    actions: ["trash", "permanent"],
    regenerationCost: "Whatever these files were for. A rule describes paths, not what depends on them.",
    active: false,
  });
}

function describe(patterns: readonly string[]): string {
  return patterns.map((pattern) => `'${pattern}'`).join(", ");
}

/**
 * A stable, readable identifier from a rule's name.
 *
 * Exported because the composition root needs the same answer to key a rule's
 * hash by the finding id this provider will give it. Two definitions of it
 * would drift, and a drifted one makes every rule plan refuse at apply time.
 */
export function ruleSlug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned === "" ? "unnamed" : cleaned;
}

export type { IndexedEntry };
