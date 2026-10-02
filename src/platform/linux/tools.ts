import type { ToolOutput, ToolPort } from "../../ports/providers.js";
import { runFixedCommand } from "./process.js";

/** A literal word, or a pattern for the one word in a query that varies. */
export type QueryWord = string | RegExp;

const DEVICE = /^\/dev\/[A-Za-z0-9][A-Za-z0-9/_.:-]*$/;

/**
 * Every query a detector may ask, matched against the whole argument vector.
 *
 * A prefix would not do: `journalctl --disk-usage --vacuum-size=1` starts like
 * a question and deletes the journal. Changes go through the manager runner
 * after a reviewed plan, never through here.
 */
export const ALLOWED_QUERIES: Readonly<Record<string, readonly (readonly QueryWord[])[]>> = {
  btrfs: [["subvolume", "list", "/"]],
  docker: [
    ["image", "ls", "--filter", "dangling=true", "--no-trunc", "--format", "{{.ID}}\t{{.Size}}"],
    ["container", "ls", "--all", "--filter", "status=exited", "--filter", "status=created", "--no-trunc", "--format", "{{.ID}}\t{{.State}}"],
    ["volume", "ls", "--filter", "dangling=true", "--format", "{{.Name}}\t{{.Labels}}"],
    ["system", "df", "--format", "{{json .}}"],
  ],
  "dpkg-query": [["-W", "-f=${Package}\t${Installed-Size}\t${Status}\n"]],
  flatpak: [
    ["list", "--columns=application,size,origin"],
    ["list", "--user", "--columns=ref"],
    ["list", "--system", "--columns=ref"],
  ],
  journalctl: [["--disk-usage"]],
  lsof: [["-v"], ["+L1", "-F", "pcnsk"]],
  npm: [["ls", "-g", "--depth=0", "--json"]],
  pacman: [["-Qi"], ["-Q"]],
  pip: [["list", "--format=json"]],
  pip3: [["list", "--format=json"]],
  podman: [
    ["image", "ls", "--filter", "dangling=true", "--no-trunc", "--format", "{{.ID}}\t{{.Size}}"],
    ["container", "ls", "--all", "--filter", "status=exited", "--filter", "status=created", "--no-trunc", "--format", "{{.ID}}\t{{.State}}"],
    ["volume", "ls", "--filter", "dangling=true", "--format", "{{.Name}}\t{{.Anonymous}}"],
  ],
  rpm: [["-qa", "--qf", "%{NAME}\t%{SIZE}\n"]],
  smartctl: [["--scan", "-j"], ["-H", "-A", "-j", DEVICE]],
  snap: [["list"], ["list", "--all"]],
  zfs: [["list", "-H", "-p", "-t", "snapshot", "-o", "name,used"]],
};

export const ALLOWED_TOOLS: readonly string[] = Object.keys(ALLOWED_QUERIES);

export function isAllowedQuery(name: string, commandArguments: readonly string[]): boolean {
  const patterns = Object.hasOwn(ALLOWED_QUERIES, name) ? ALLOWED_QUERIES[name] : undefined;
  return (patterns ?? []).some(
    (pattern) =>
      pattern.length === commandArguments.length &&
      pattern.every((word, index) => {
        const actual = commandArguments[index] as string;
        return typeof word === "string" ? word === actual : word.test(actual);
      }),
  );
}

export type RunCommand = (name: string, commandArguments: readonly string[]) => Promise<ToolOutput>;

export function createToolPort(run: RunCommand = runFixedCommand): ToolPort {
  const allowed = new Set(ALLOWED_TOOLS);
  return {
    async run(name, commandArguments) {
      if (!allowed.has(name)) {
        return refused(
          `'${name}' is not a tool Disktop runs. Add it to the allowlist in src/platform/linux/tools.ts to change that.`,
        );
      }
      if (!isAllowedQuery(name, commandArguments)) {
        return refused(`'${[name, ...commandArguments.slice(0, 2)].join(" ")}' is not a query Disktop runs.`);
      }
      return run(name, commandArguments);
    },
  };
}

function refused(explanation: string): ToolOutput {
  return { capability: { status: "missing-tool", explanation }, stdout: "", stderr: "", exitCode: null };
}
