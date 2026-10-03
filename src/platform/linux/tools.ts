import type { ToolOutput, ToolPort } from "../../ports/providers.js";
import { runFixedCommand } from "./process.js";

/** A literal word, a pattern for one word, or a pattern every remaining word must match. */
export type QueryWord = string | RegExp | { readonly rest: RegExp };

const rest = (pattern: RegExp): { readonly rest: RegExp } => ({ rest: pattern });
const KERNEL_PACKAGE = /^linux-[a-z0-9][a-z0-9.+-]{0,127}$/;
const KERNEL_RPM = /^kernel[a-z0-9-]*-[0-9][A-Za-z0-9._+-]{0,127}$/;

/**
 * A node under `/dev`, one segment at a time. No segment may start with a dot,
 * so `..` cannot climb out of `/dev` and point a query at some other file.
 */
const DEVICE = /^\/dev(?:\/[A-Za-z0-9_][A-Za-z0-9_.:+-]*)+$/;

/**
 * Every query a detector may ask, matched against the whole argument vector.
 *
 * A prefix would not do: `journalctl --disk-usage --vacuum-size=1` starts like
 * a question and deletes the journal. Changes go through the manager runner
 * after a reviewed plan, never through here.
 */
export const ALLOWED_QUERIES: Readonly<Record<string, readonly (readonly QueryWord[])[]>> = {
  "apt-get": [["-s", "purge", rest(KERNEL_PACKAGE)]],
  btrfs: [["subvolume", "list", "/"]],
  docker: [
    ["image", "ls", "--filter", "dangling=true", "--no-trunc", "--format", "{{.ID}}\t{{.Size}}"],
    ["container", "ls", "--all", "--filter", "status=exited", "--filter", "status=created", "--no-trunc", "--format", "{{.ID}}\t{{.State}}"],
    ["volume", "ls", "--filter", "dangling=true", "--format", "{{.Name}}"],
    ["volume", "ls", "--filter", "dangling=true", "--filter", "label=com.docker.volume.anonymous", "--format", "{{.Name}}"],
    ["system", "df", "--format", "{{json .}}"],
  ],
  "dpkg-query": [
    ["-W", "-f=${Package}\t${Installed-Size}\t${Status}\n"],
    ["-W", "-f=${Package}\t${Status}\t${Installed-Size}\n"],
  ],
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
  rpm: [
    ["-qa", "--qf", "%{NAME}\t%{SIZE}\n"],
    ["-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}.%{ARCH}\t%{SIZE}\n"],
    ["-e", "--test", "--", rest(KERNEL_RPM)],
  ],
  smartctl: [["--scan", "-j"], ["-H", "-A", "-j", DEVICE]],
  snap: [["list"], ["list", "--all"]],
  "systemd-tmpfiles": [
    ["--user", "--clean", "--dry-run"],
    ["--clean", "--dry-run"],
    ["--clean", "--dry-run", "--prefix=/var/crash", "--prefix=/var/lib/systemd/coredump"],
  ],
  zfs: [["list", "-H", "-p", "-t", "snapshot", "-o", "name,used"]],
};

export const ALLOWED_TOOLS: readonly string[] = Object.keys(ALLOWED_QUERIES);

export function isAllowedQuery(name: string, commandArguments: readonly string[]): boolean {
  const patterns = Object.hasOwn(ALLOWED_QUERIES, name) ? ALLOWED_QUERIES[name] : undefined;
  return (patterns ?? []).some((pattern) => {
    const last = pattern[pattern.length - 1];
    const open = last !== undefined && typeof last === "object" && "rest" in last;
    const fixed = open ? pattern.slice(0, -1) : pattern;
    if (open ? commandArguments.length <= fixed.length : commandArguments.length !== fixed.length) {
      return false;
    }
    const head = fixed.every((word, index) => {
      const actual = commandArguments[index] as string;
      return typeof word === "string" ? word === actual : (word as RegExp).test(actual);
    });
    return head && (!open || commandArguments.slice(fixed.length).every((actual) => last.rest.test(actual)));
  });
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
