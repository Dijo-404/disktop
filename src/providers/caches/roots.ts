import type { ActionOperation } from "../../domain/actions.js";
import type { Finding, FindingCategory } from "../../domain/findings.js";
import type { DiscoveryEnvironment, FindingProvider } from "../../ports/providers.js";
import { buildFinding, exists, underHome } from "../support.js";

/**
 * One fixed directory a tool is known to keep data in.
 *
 * The slug is written here rather than derived from the path, so a finding's
 * id is the same on every machine and a plan saved against `cache.language:npm`
 * still means the npm cache next year.
 */
export interface CacheRoot {
  readonly slug: string;
  /** Path segments below the home directory. */
  readonly segments: readonly string[];
  readonly title: string;
  readonly evidence: readonly string[];
  readonly regenerationCost: string;
  /**
   * True when the directory holds something that is not disposable: weights
   * somebody downloaded, an SDK, an emulator image, installed extensions.
   */
  readonly active?: boolean;
  readonly actions?: readonly ActionOperation[];
}

export interface RootsProviderSpec {
  readonly id: string;
  readonly version: number;
  readonly category: FindingCategory;
  /** What a reader should be told is absent when none of the roots exist. */
  readonly what: string;
  readonly roots: readonly CacheRoot[];
}

/**
 * A detector whose whole job is a list of known directories.
 *
 * Caches differ in what they hold and what losing them costs, and that is
 * exactly what the table carries. The code around it is the same every time,
 * so it is written once: a root that exists becomes one finding, a root that
 * does not exist becomes nothing at all, and no root is ever reported as zero
 * bytes because the size is left for the footprint port.
 */
export function createRootsProvider(spec: RootsProviderSpec): FindingProvider {
  return {
    id: spec.id,
    version: spec.version,
    categories: [spec.category],

    async probe(environment) {
      const present = await presentRoots(environment, spec);
      if (present.length > 0) {
        return { status: "available", explanation: `${present.length} ${spec.what} exist.` };
      }
      return { status: "missing-tool", explanation: `No ${spec.what} exist under this home directory.` };
    },

    async discover(environment) {
      const findings: Finding[] = [];
      for (const root of await presentRoots(environment, spec)) {
        findings.push(
          buildFinding({
            providerId: spec.id,
            providerVersion: spec.version,
            category: spec.category,
            slug: root.slug,
            title: root.title,
            evidence: root.evidence,
            paths: [underHome(environment, ...root.segments)],
            actions: root.actions ?? (root.active === true ? [] : ["trash"]),
            regenerationCost: root.regenerationCost,
            active: root.active ?? false,
          }),
        );
      }
      return { findings, warnings: [], complete: true };
    },
  };
}

async function presentRoots(
  environment: DiscoveryEnvironment,
  spec: RootsProviderSpec,
): Promise<readonly CacheRoot[]> {
  const present: CacheRoot[] = [];
  for (const root of spec.roots) {
    if (await exists(environment, underHome(environment, ...root.segments))) {
      present.push(root);
    }
  }
  return present;
}
