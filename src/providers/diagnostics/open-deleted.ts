import { findingSize, type Finding } from "../../domain/findings.js";
import type { Warning } from "../../domain/models.js";
import type { FindingProvider } from "../../ports/providers.js";
import { absolutePath, buildFinding, safeSlug, safeText } from "../support.js";
import { parseOpenDeleted } from "./parsing.js";

const ID = "diagnostic.open-deleted";
const VERSION = 1;

/**
 * Files that were deleted while a process still had them open.
 *
 * This is the answer to the most confusing thing a full disk does: `du` says
 * the space is free and `df` says it is not. The kernel keeps the blocks until
 * the last descriptor closes, so the space comes back when that process
 * restarts, and not before.
 *
 * It is read-only, and an unprivileged user usually cannot see other people's
 * processes. That is reported as a denial rather than as an empty answer,
 * because an empty answer here would be read as "that is not what is wrong".
 */
export function createOpenDeletedProvider(): FindingProvider {
  return {
    id: ID,
    version: VERSION,
    categories: ["diagnostic"],

    async probe(environment) {
      const outcome = await environment.tools.run("lsof", ["-v"]);
      if (outcome.capability.status === "missing-tool") {
        return {
          status: "missing-tool",
          explanation: "lsof is not installed, so files deleted while still open cannot be counted.",
        };
      }
      return { status: "available", explanation: "lsof is installed." };
    },

    async discover(environment) {
      const outcome = await environment.tools.run("lsof", ["+L1", "-F", "pcnsk"]);
      if (outcome.capability.status === "permission-denied") {
        return {
          findings: [],
          warnings: [
            {
              code: "lsof-denied",
              message: `Files deleted while still open were not counted: ${outcome.capability.explanation}`,
            },
          ],
          complete: false,
        };
      }

      const files = parseOpenDeleted(outcome.stdout);
      if (files.length === 0) {
        return { findings: [], warnings: [], complete: true };
      }

      const total = files.reduce((sum, file) => sum + (file.bytes ?? 0n), 0n);
      const unmeasured = files.filter((file) => file.bytes === undefined).length;
      const warnings: Warning[] = [];
      const findings: Finding[] = [
        buildFinding({
          providerId: ID,
          providerVersion: VERSION,
          category: "diagnostic",
          slug: "summary",
          title: `${files.length} files are deleted but still open`,
          evidence: [
            "The kernel keeps a deleted file's blocks until the last process holding it open closes it, which is why du and df disagree.",
            `Held by: ${safeText(processSummary(files))}.`,
            unmeasured === 0
              ? "Every one of them reported a size."
              : `${unmeasured} of them reported no size, so they add nothing to the total.`,
            "Restarting the process holding a file is what returns its space; there is nothing here to delete.",
          ],
          size:
            total === 0n
              ? findingSize(undefined, "unknown", "lsof reported no usable size for these files.")
              : findingSize(total, "manager-reported", "The sizes lsof reported, added together."),
          confidence: "observed",
          active: true,
          actions: [],
        }),
      ];

      for (const file of files.slice(0, 10)) {
        const path = absolutePath(file.path);
        findings.push(
          buildFinding({
            providerId: ID,
            providerVersion: VERSION,
            category: "diagnostic",
            slug: `pid-${safeSlug(file.processId, 16)}-${safeSlug(file.path.slice(-48), 48)}`,
            title: `${safeText(file.command, 48)} is holding a deleted ${safeText(file.path)}`,
            evidence: [
              `Process ${safeText(file.processId, 16)} (${safeText(file.command, 48)}) still has this deleted file open.`,
              "Its space returns when that process closes the file or restarts.",
            ],
            ...(path === undefined ? {} : { paths: [path] }),
            size:
              file.bytes === undefined
                ? findingSize(undefined, "unknown", "lsof reported no size for this file.")
                : findingSize(file.bytes, "manager-reported", "The size lsof reported."),
            active: true,
            actions: [],
          }),
        );
      }

      return { findings, warnings, complete: true };
    },
  };
}

function processSummary(files: readonly { readonly command: string }[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    counts.set(file.command, (counts.get(file.command) ?? 0) + 1);
  }
  return [...counts]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([command, count]) => `${command} (${count})`)
    .join(", ");
}
