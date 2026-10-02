import type { VerificationCheck } from "../../../domain/actions.js";
import { MANAGER_ACTIONS, type ManagerActionId, type ManagerItem, type ManagerScope } from "../../../domain/managers.js";
import type { Capability, RawPath, Warning } from "../../../domain/models.js";
import { rawPathFromUtf8, sanitizeText } from "../../../domain/paths.js";
import type { ManagerAdapter, ManagerDiscovery, ManagerProposal } from "../../../ports/managers.js";
import type { PathProbe, ToolPort } from "../../../ports/providers.js";

export interface PackageCachePorts {
  readonly tools: ToolPort;
  readonly paths: PathProbe;
  readonly installed: (tool: string) => Promise<boolean>;
  readonly roots?: {
    readonly apt?: string;
    readonly dnf?: readonly string[];
    readonly pacman?: string;
  };
}

interface Listing {
  readonly items: readonly ManagerItem[];
  readonly warnings: readonly Warning[];
}

interface CacheSpec {
  readonly id: "apt" | "dnf" | "pacman";
  readonly tool: string;
  readonly action: ManagerActionId;
  readonly title: string;
  readonly spacePath: string;
  readonly list: () => Promise<Listing>;
  readonly select: (listing: Listing) => Promise<{ readonly items: readonly ManagerItem[]; readonly capability?: Capability; readonly evidence: readonly string[] }>;
  readonly count: "exact" | "estimated";
}

export function createPackageCacheAdapters(ports: PackageCachePorts): readonly ManagerAdapter[] {
  const apt = ports.roots?.apt ?? "/var/cache/apt/archives";
  const dnf = ports.roots?.dnf ?? ["/var/cache/dnf", "/var/cache/libdnf5"];
  const pacman = ports.roots?.pacman ?? "/var/cache/pacman/pkg";

  const specs: readonly CacheSpec[] = [
    {
      id: "apt",
      tool: "apt-get",
      action: "apt.clean",
      title: "Package files apt downloaded",
      spacePath: apt,
      count: "exact",
      list: () => listFiles(ports.paths, [apt], "apt.clean"),
      select: async (listing) => ({
        items: listing.items,
        evidence: [
          `${listing.items.length} package file(s) in ${sanitizeText(apt)}.`,
          "apt-get clean removes every downloaded package file, including any that arrive after this review.",
        ],
      }),
    },
    {
      id: "dnf",
      tool: "dnf",
      action: "dnf.clean-packages",
      title: "Package files dnf keeps in its cache",
      spacePath: "/var/cache",
      count: "exact",
      list: async () => listFiles(ports.paths, await packageDirectories(ports.paths, dnf), "dnf.clean-packages"),
      select: async (listing) => ({
        items: listing.items,
        evidence: [`${listing.items.length} package file(s) in dnf's cache.`],
      }),
    },
    {
      id: "pacman",
      tool: "pacman",
      action: "pacman.clean-uninstalled",
      title: "Cached pacman packages that are not installed",
      spacePath: pacman,
      count: "estimated",
      list: () => listFiles(ports.paths, [pacman], "pacman.clean-uninstalled"),
      select: async (listing) => {
        const answer = await ports.tools.run("pacman", ["-Q"]);
        if (answer.capability.status !== "available") {
          return { items: [], capability: answer.capability, evidence: [] };
        }
        const installed = new Set(
          answer.stdout
            .split("\n")
            .map((line) => line.trim().split(/\s+/))
            .filter((fields) => fields.length === 2)
            .map(([name, version]) => `${name}-${version}`),
        );
        const items = listing.items.filter((item) => {
          const key = packageKey(item.id);
          return key !== undefined && !installed.has(key);
        });
        return {
          items,
          evidence: [
            `${items.length} of ${listing.items.length} cached package(s) are versions that are not installed.`,
            "pacman makes the final choice and also drops the sync databases of repositories no longer configured.",
          ],
        };
      },
    },
  ];

  return specs.map((spec) => createAdapter(spec, ports));
}

function createAdapter(spec: CacheSpec, ports: PackageCachePorts): ManagerAdapter {
  async function discover(): Promise<ManagerDiscovery> {
    if (!(await ports.installed(spec.tool))) {
      return {
        adapter: spec.id,
        capability: { status: "missing-tool", explanation: `${spec.tool} is not installed on this machine.` },
        proposals: [],
        warnings: [],
      };
    }
    const listing = await spec.list();
    const selected = await spec.select(listing);
    if (selected.capability !== undefined) {
      return { adapter: spec.id, capability: selected.capability, proposals: [], warnings: listing.warnings };
    }
    const bytes = selected.items.reduce((total, item) => total + (item.bytes ?? 0n), 0n);
    const proposal: ManagerProposal = {
      action: spec.action,
      title: spec.title,
      evidence: [...selected.evidence],
      items: selected.items,
      count: { kind: selected.items.length === 0 ? "exact" : spec.count, value: BigInt(selected.items.length) },
      estimatedBytes: bytes,
      bytesBasis: "stat",
      preview: "listed",
      offered: selected.items.length > 0,
      parameters: {},
    };
    return {
      adapter: spec.id,
      capability: { status: "available", explanation: `${spec.tool} is installed.` },
      proposals: listing.items.length === 0 && spec.id === "dnf" ? [] : [proposal],
      warnings: listing.warnings,
    };
  }

  async function present(): Promise<ReadonlySet<string>> {
    return new Set((await spec.list()).items.map((item) => item.id));
  }

  return {
    id: spec.id,
    discover,
    async preview(action) {
      const discovery = await discover();
      const proposal = discovery.proposals.find((candidate) => candidate.action === action);
      return proposal === undefined
        ? { kind: "refused", message: discovery.capability.explanation, capability: discovery.capability }
        : { kind: "proposal", proposal };
    },
    async preflight(scope) {
      const there = await present();
      const skipped = new Map<number, string>();
      scope.items.forEach((item, position) => {
        if (!there.has(item.id)) {
          skipped.set(position, "It is no longer in the cache.");
        }
      });
      return { skipped };
    },
    async verify(scope, attempted) {
      const there = await present();
      return cacheVerification(scope, attempted, there);
    },
    async spacePath() {
      return spec.spacePath;
    },
  };
}

function cacheVerification(scope: ManagerScope, attempted: ReadonlySet<number>, there: ReadonlySet<string>) {
  const verdicts = new Map<number, { readonly outcome: "completed" | "failed"; readonly message?: string }>();
  let left = 0;
  for (const position of attempted) {
    const item = scope.items[position];
    if (item === undefined) {
      continue;
    }
    if (there.has(item.id)) {
      left += 1;
      verdicts.set(position, { outcome: "failed", message: "It is still in the cache." });
    } else {
      verdicts.set(position, { outcome: "completed" });
    }
  }
  const check: VerificationCheck =
    left === 0
      ? { check: "manager-verified", outcome: "passed", detail: "The cache was listed again and no reviewed file remains." }
      : { check: "manager-verified", outcome: "failed", detail: `${left} reviewed file(s) are still in the cache.` };
  return { verdicts, observed: [], checks: [check] };
}

async function packageDirectories(paths: PathProbe, roots: readonly string[]): Promise<readonly string[]> {
  const found: string[] = [];
  for (const root of roots) {
    for (const repository of await paths.list(rawPathFromUtf8(root))) {
      const packages = `${repository.display}/packages`;
      if ((await paths.facts(rawPathFromUtf8(packages)))?.kind === "directory") {
        found.push(packages);
      }
    }
  }
  return found;
}

async function listFiles(paths: PathProbe, directories: readonly string[], action: ManagerActionId): Promise<Listing> {
  const pattern = MANAGER_ACTIONS[action].itemPattern;
  const items: ManagerItem[] = [];
  const warnings: Warning[] = [];
  const seen = new Set<string>();
  for (const directory of directories) {
    for (const entry of await paths.list(rawPathFromUtf8(directory))) {
      const name = baseName(entry);
      if (name === undefined || name.endsWith(".sig") || !/\.(deb|rpm)$|\.pkg\.tar/.test(name)) {
        continue;
      }
      const facts = await paths.facts(entry);
      if (facts?.kind !== "file") {
        continue;
      }
      if (pattern === undefined || !pattern.test(name) || seen.has(name)) {
        warnings.push({
          code: "manager-item-skipped",
          message: `${sanitizeText(name)} was left out: it is not a name Disktop will hand to a package manager.`,
        });
        continue;
      }
      seen.add(name);
      items.push({ id: name, bytes: facts.allocatedBytes });
    }
  }
  return { items: items.slice(0, MANAGER_ACTIONS[action].maxItems), warnings };
}

function baseName(path: RawPath): string | undefined {
  const text = path.utf8;
  return text === undefined ? undefined : text.slice(text.lastIndexOf("/") + 1);
}

/** `name-pkgver-pkgrel` from `name-pkgver-pkgrel-arch.pkg.tar.*`. */
export function packageKey(file: string): string | undefined {
  const stem = file.replace(/\.pkg\.tar(\.[a-z0-9]+)?$/, "");
  const fields = stem.split("-");
  if (fields.length < 4) {
    return undefined;
  }
  return fields.slice(0, -1).join("-");
}
