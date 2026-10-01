import { findingSize, type Finding } from "../../domain/findings.js";
import type { RawPath, Warning } from "../../domain/models.js";
import type { DiscoveryEnvironment, FindingProvider } from "../../ports/providers.js";
import { absolutePath, basename, buildFinding, exists, slugForPath } from "../support.js";
import { parseJournalUsage } from "../../platform/linux/diagnostics/parsers.js";

const ID = "diagnostic.logs";
const VERSION = 1;

const LOG_ROOT = "/var/log";
const LOGROTATE_DIRECTORY = "/etc/logrotate.d";

export interface LogOptions {
  readonly logRoot?: RawPath;
  readonly logrotateDirectory?: RawPath;
}

/**
 * Log files that have grown past the configured size, and the journal's own
 * footprint.
 *
 * Nothing here offers an action. A log is being written to right now;
 * truncating one from underneath the process holding it open frees nothing
 * until that process closes the file, and emptying a journal is `journalctl
 * --vacuum-size`'s job because it knows which files are sealed. What this
 * detector adds is the cause: whether anything under /etc/logrotate.d is
 * supposed to be rotating the file that grew.
 */
export function createLogProvider(options: LogOptions = {}): FindingProvider {
  const logRoot = options.logRoot ?? (absolutePath(LOG_ROOT) as RawPath);
  const logrotate = options.logrotateDirectory ?? (absolutePath(LOGROTATE_DIRECTORY) as RawPath);

  return {
    id: ID,
    version: VERSION,
    categories: ["log"],

    async probe(environment) {
      return (await exists(environment, logRoot))
        ? { status: "available", explanation: `${logRoot.display} is readable.` }
        : { status: "permission-denied", explanation: `${logRoot.display} could not be read.` };
    },

    async discover(environment) {
      const findings: Finding[] = [];
      const warnings: Warning[] = [];
      const rules = await logrotateRules(environment, logrotate);

      const entries = await environment.paths.list(logRoot);
      if (entries.length === 0) {
        warnings.push({
          code: "log-directory-unreadable",
          message: `${logRoot.display} listed nothing, which usually means this user cannot read it.`,
          path: logRoot,
        });
      }

      for (const entry of entries) {
        const facts = await environment.paths.facts(entry);
        if (facts === undefined || facts.kind !== "file" || facts.allocatedBytes < environment.largeLogBytes) {
          continue;
        }
        findings.push(logFinding(entry, facts.allocatedBytes, rules));
      }

      const usage = await environment.tools.run("journalctl", ["--disk-usage"]);
      if (usage.capability.status === "available") {
        const bytes = parseJournalUsage(usage.stdout);
        findings.push(journalFinding(bytes));
      } else if (usage.capability.status === "permission-denied") {
        warnings.push({
          code: "journal-unreadable",
          message: `The journal's size was not read: ${usage.capability.explanation}`,
        });
      }

      return { findings, warnings, complete: warnings.length === 0 };
    },
  };
}

function logFinding(path: RawPath, bytes: bigint, rules: ReadonlySet<string>): Finding {
  const name = basename(path);
  const rotated = [...rules].some((rule) => name.startsWith(rule) || rule.startsWith(name.split(".")[0] as string));
  return buildFinding({
    providerId: ID,
    providerVersion: VERSION,
    category: "log",
    slug: slugForPath(path),
    title: `Large log file ${name}`,
    evidence: [
      rotated
        ? "A logrotate rule names it, so it should be being rotated; if it is this large anyway, the rule's size or interval is not keeping up."
        : "Nothing under /etc/logrotate.d names it, so nothing is set up to rotate it.",
      "Truncating a log a process still holds open frees nothing until that process closes it.",
    ],
    paths: [path],
    size: findingSize(bytes, "stat", "Blocks on disk from one stat call."),
    confidence: "observed",
    active: true,
    actions: [],
  });
}

function journalFinding(bytes: bigint | undefined): Finding {
  return buildFinding({
    providerId: ID,
    providerVersion: VERSION,
    category: "log",
    slug: "systemd-journal",
    title: "systemd journal",
    evidence: [
      "journalctl --disk-usage reports what archived and active journals occupy.",
      "`journalctl --vacuum-size` is how this shrinks: it knows which files are sealed and which one is still being written.",
    ],
    managerScope: "journalctl --vacuum-size",
    size:
      bytes === undefined
        ? findingSize(undefined, "unknown", "journalctl answered in a form Disktop could not read a size from.")
        : findingSize(bytes, "manager-reported", "The figure journalctl --disk-usage printed."),
    confidence: "likely",
    active: true,
    actions: ["manager"],
  });
}

/** The base names /etc/logrotate.d mentions, as weak evidence of intent. */
async function logrotateRules(
  environment: DiscoveryEnvironment,
  directory: RawPath,
): Promise<ReadonlySet<string>> {
  const rules = new Set<string>();
  for (const entry of await environment.paths.list(directory)) {
    rules.add(basename(entry));
    const text = await environment.paths.readText(entry, 32 * 1024);
    if (text === undefined) {
      continue;
    }
    for (const match of text.matchAll(/^\s*(\/var\/log\/\S+)/gm)) {
      rules.add(fileNameOf(match[1] as string));
    }
  }
  return rules;
}

function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
