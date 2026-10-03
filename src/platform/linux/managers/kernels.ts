import { MANAGER_ACTIONS, type ManagerActionId, type ManagerItem, type ManagerScope } from "../../../domain/managers.js";
import { sanitizeText } from "../../../domain/paths.js";
import type { ManagerAdapter, ManagerDiscovery, ManagerProposal, PreflightResult } from "../../../ports/managers.js";
import type { ToolPort } from "../../../ports/providers.js";
import { listedAgain, previewFrom } from "./support.js";

export interface KernelPorts {
  readonly tools: ToolPort;
  readonly runningRelease: () => string;
  readonly installed: (tool: string) => Promise<boolean>;
  /** Releases with modules installed under /lib/modules: what is really a kernel here. */
  readonly kernelReleases: () => Promise<ReadonlySet<string>>;
}

/** `-unsigned`, `-dbg`, and `-dbgsym` packages belong to the release they name. */
export function normalizeRelease(release: string): string {
  return release.replace(/(-unsigned|-dbgsym|-dbg)+$/, "");
}

interface Installed {
  readonly name: string;
  readonly release: string;
  readonly bytes?: bigint;
}

interface Family {
  readonly action: ManagerActionId;
  readonly list: () => Promise<readonly Installed[] | undefined>;
  /** What else would go, or undefined when the simulation could not run. */
  readonly simulate: (names: readonly string[]) => Promise<{ readonly extra: readonly string[] } | undefined>;
}

const DPKG_FORMAT = "-f=${Package}\t${Status}\t${Installed-Size}\n";
const RPM_FORMAT = "%{NAME}\t%{VERSION}-%{RELEASE}.%{ARCH}\t%{SIZE}\n";
const DEBIAN_PREFIXES = ["linux-image-unsigned-", "linux-image-", "linux-modules-extra-", "linux-modules-", "linux-headers-"];
const FEDORA_NAMES = new Set([
  "kernel",
  "kernel-core",
  "kernel-modules",
  "kernel-modules-core",
  "kernel-modules-extra",
  "kernel-modules-internal",
  "kernel-devel",
  "kernel-devel-matched",
]);

export function compareReleases(left: string, right: string): number {
  const numbers = (release: string) => release.split(/[^0-9]+/).filter((part) => part !== "").map(Number);
  const a = numbers(left);
  const b = numbers(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? -1) - (b[index] ?? -1);
    if (difference !== 0) {
      return difference;
    }
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createKernelAdapter(ports: KernelPorts): ManagerAdapter {
  const debian: Family = {
    action: "kernels.dpkg-purge",
    async list() {
      const answer = await ports.tools.run("dpkg-query", ["-W", DPKG_FORMAT]);
      if (answer.capability.status !== "available") {
        return undefined;
      }
      const packages: Installed[] = [];
      for (const line of answer.stdout.split("\n")) {
        const [name, status, size] = line.split("\t");
        if (name === undefined || status !== "install ok installed") {
          continue;
        }
        const prefix = DEBIAN_PREFIXES.find((candidate) => name.startsWith(candidate) && /^[0-9]/.test(name.slice(candidate.length)));
        if (prefix === undefined) {
          continue;
        }
        packages.push({
          name,
          release: normalizeRelease(name.slice(prefix.length)),
          ...(size !== undefined && /^[0-9]+$/.test(size) ? { bytes: BigInt(size) * 1024n } : {}),
        });
      }
      return packages;
    },
    async simulate(names) {
      const answer = await ports.tools.run("apt-get", ["-s", "purge", ...names]);
      if (answer.capability.status !== "available") {
        return undefined;
      }
      const removed = [...answer.stdout.matchAll(/^(?:Purg|Remv) (\S+)/gm)].map((match) => match[1] as string);
      return { extra: removed.filter((name) => !names.includes(name)) };
    },
  };

  const fedora: Family = {
    action: "kernels.rpm-erase",
    async list() {
      const answer = await ports.tools.run("rpm", ["-qa", "--qf", RPM_FORMAT]);
      if (answer.capability.status !== "available") {
        return undefined;
      }
      const packages: Installed[] = [];
      for (const line of answer.stdout.split("\n")) {
        const [name, release, size] = line.split("\t");
        if (name === undefined || release === undefined || !FEDORA_NAMES.has(name)) {
          continue;
        }
        packages.push({
          name: `${name}-${release}`,
          release,
          ...(size !== undefined && /^[0-9]+$/.test(size) ? { bytes: BigInt(size) } : {}),
        });
      }
      return packages;
    },
    async simulate(names) {
      const answer = await ports.tools.run("rpm", ["-e", "--test", "--", ...names]);
      if (answer.capability.status === "available" && answer.stderr.trim() === "") {
        return { extra: [] };
      }
      return /Failed dependencies/.test(answer.stderr) ? { extra: ["something that depends on them"] } : undefined;
    },
  };

  async function family(): Promise<Family | ManagerDiscovery> {
    if ((await ports.installed("dpkg-query")) && (await ports.installed("dpkg"))) {
      return debian;
    }
    if (await ports.installed("rpm")) {
      return fedora;
    }
    return {
      adapter: "kernels",
      capability: {
        status: "missing-tool",
        explanation: (await ports.installed("pacman"))
          ? "pacman keeps one version of each kernel package, so there are no old kernels to remove."
          : "Neither dpkg nor rpm is installed, so Disktop cannot tell which kernels are packaged here.",
      },
      proposals: [],
      warnings: [],
    };
  }

  function select(packages: readonly Installed[], running: string, verified: ReadonlySet<string>): readonly Installed[] {
    const releases = [
      ...new Set(
        packages
          .filter((entry) => !entry.name.startsWith("linux-headers-") && verified.has(entry.release))
          .map((entry) => entry.release),
      ),
    ];
    if (releases.length < 2) {
      return [];
    }
    const newest = [...releases].sort(compareReleases).at(-1) as string;
    const kept = new Set([running, newest]);
    const base = (release: string) => release.replace(/-[a-z][a-z0-9]*$/, "");
    const keptBases = new Set([...kept].map(base));
    return packages
      .filter((entry) => {
        if (kept.has(entry.release)) {
          return false;
        }
        if (entry.name.startsWith("linux-headers-") && !releases.includes(entry.release)) {
          return !keptBases.has(entry.release) && releases.some((release) => base(release) === entry.release);
        }
        return releases.includes(entry.release);
      })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  }

  async function discover(): Promise<ManagerDiscovery> {
    const chosen = await family();
    if ("adapter" in chosen) {
      return chosen;
    }
    const packages = await chosen.list();
    if (packages === undefined) {
      return {
        adapter: "kernels",
        capability: { status: "missing-tool", explanation: "The package database could not be read." },
        proposals: [],
        warnings: [],
      };
    }
    const running = ports.runningRelease();
    const pattern = MANAGER_ACTIONS[chosen.action].itemPattern as RegExp;
    const candidates = select(packages, running, await ports.kernelReleases()).filter((entry) => pattern.test(entry.name));
    if (candidates.length === 0) {
      return { adapter: "kernels", capability: { status: "available", explanation: "Only the running and the newest kernel are installed." }, proposals: [], warnings: [] };
    }
    const names = candidates.map((entry) => entry.name);
    const simulation = await chosen.simulate(names);
    const items: ManagerItem[] = candidates.map((entry) => (entry.bytes === undefined ? { id: entry.name } : { id: entry.name, bytes: entry.bytes }));
    const measured = items.every((item) => item.bytes !== undefined);
    const bounded = simulation !== undefined && simulation.extra.length === 0;
    const proposal: ManagerProposal = {
      action: chosen.action,
      title: "Old kernels",
      evidence: [
        `The running kernel is ${sanitizeText(running)}; it and the newest installed one are kept.`,
        simulation === undefined
          ? "The package manager could not simulate the removal, so it is not offered."
          : simulation.extra.length === 0
            ? "A simulated removal takes exactly these packages and nothing else."
            : `Removing these would also take ${sanitizeText(simulation.extra.join(", "))}, so it is not offered.`,
      ],
      items,
      count: { kind: "exact", value: BigInt(items.length) },
      ...(measured ? { estimatedBytes: items.reduce((total, item) => total + (item.bytes ?? 0n), 0n) } : {}),
      bytesBasis: measured ? "manager-reported" : "unknown",
      preview: "simulated",
      offered: bounded,
      parameters: {},
    };
    return { adapter: "kernels", capability: { status: "available", explanation: "The package database was read." }, proposals: [proposal], warnings: [] };
  }

  async function installedNames(): Promise<ReadonlySet<string> | undefined> {
    const chosen = await family();
    if ("adapter" in chosen) {
      return undefined;
    }
    const packages = await chosen.list();
    return packages === undefined ? undefined : new Set(packages.map((entry) => entry.name));
  }

  return {
    id: "kernels",
    discover,
    preview: (action) => previewFrom(discover, action),
    async preflight(scope: ManagerScope): Promise<PreflightResult> {
      const running = ports.runningRelease();
      const names = scope.items.map((item) => item.id);
      if (names.some((name) => name.endsWith(`-${running}`) || name === `linux-image-${running}`)) {
        return { refusal: `The running kernel, ${sanitizeText(running)}, is one of the reviewed packages now.`, skipped: new Map() };
      }
      const chosen = await family();
      if ("adapter" in chosen) {
        return { refusal: chosen.capability.explanation, skipped: new Map() };
      }
      const packages = await chosen.list();
      if (packages === undefined) {
        return { refusal: "The package database could not be read, so nothing was run.", skipped: new Map() };
      }
      const current = new Set(select(packages, running, await ports.kernelReleases()).map((entry) => entry.name));
      const stale = names.find((name) => !current.has(name));
      if (stale !== undefined) {
        return {
          refusal: `${sanitizeText(stale)} is no longer an old kernel here: it may be the running or the newest one now. Nothing was run.`,
          skipped: new Map(),
        };
      }
      const simulation = await chosen.simulate(names);
      if (simulation === undefined || simulation.extra.length > 0) {
        return { refusal: "What removing these would take has changed since review, so nothing was run.", skipped: new Map() };
      }
      return { skipped: new Map() };
    },
    async verify(scope, attempted) {
      return listedAgain(scope, attempted, await installedNames(), "the package database");
    },
    async spacePath() {
      return "/boot";
    },
  };
}
