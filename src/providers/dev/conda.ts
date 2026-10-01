import type { Finding } from "../../domain/findings.js";
import type { RawPath } from "../../domain/models.js";
import type { DiscoveryEnvironment, FindingProvider } from "../../ports/providers.js";
import {
  absolutePath,
  basename,
  buildFinding,
  childDirectories,
  exists,
  existingPaths,
  joinPath,
  rootsCapability,
  slugForPath,
  underHome,
} from "../support.js";

const ID = "dev.conda";
const VERSION = 1;

/**
 * Where a conda or mamba installation puts itself when nobody chose, plus the
 * one the shell is using.
 *
 * `CONDA_PREFIX` names the active *environment*, which lives under the
 * installation's `envs` directory, so the installation is the part before it.
 */
function prefixCandidates(environment: DiscoveryEnvironment): readonly RawPath[] {
  const roots = ["miniconda3", "anaconda3", "miniforge3", "mambaforge", "micromamba"].map((name) =>
    underHome(environment, name),
  );
  const active = absolutePath(environment.variables["CONDA_PREFIX"]);
  if (active === undefined) {
    return roots;
  }
  const marker = (active.utf8 ?? "").lastIndexOf("/envs/");
  const installation = marker < 0 ? active : absolutePath((active.utf8 as string).slice(0, marker));
  return installation === undefined ? [...roots, active] : [...roots, installation];
}

/**
 * Conda installations, their environments, and the package cache.
 *
 * An installation is proved by its `conda-meta` directory, and so is each
 * environment; a directory sitting under `envs` with no `conda-meta` is
 * somebody's notes, not an environment, and removing it would be removing
 * their notes.
 */
export function createCondaProvider(): FindingProvider {
  return {
    id: ID,
    version: VERSION,
    categories: ["dev-environment"],

    async probe(environment) {
      return rootsCapability(await installations(environment), "conda installations");
    },

    async discover(environment) {
      const activePrefix = environment.variables["CONDA_PREFIX"];
      const findings: Finding[] = [];

      for (const prefix of await installations(environment)) {
        const packages = joinPath(prefix, "pkgs");
        if (await exists(environment, packages)) {
          findings.push(
            buildFinding({
              providerId: ID,
              providerVersion: VERSION,
              category: "dev-environment",
              slug: slugForPath(packages),
              title: `conda package cache in ${basename(prefix)}`,
              evidence: [
                "Downloaded and unpacked packages conda keeps so a later environment can be built without the network.",
                "conda clean --packages removes it through conda itself.",
              ],
              paths: [packages],
              actions: ["manager"],
              regenerationCost: "Re-downloaded the next time an environment needs one of these packages.",
            }),
          );
        }

        for (const candidate of await childDirectories(environment, joinPath(prefix, "envs"))) {
          if (!(await exists(environment, joinPath(candidate, "conda-meta")))) {
            continue;
          }
          const active = activePrefix !== undefined && candidate.utf8 === activePrefix;
          findings.push(environmentFinding(candidate, prefix, active));
        }
      }

      return { findings, warnings: [], complete: true };
    },
  };
}

function environmentFinding(path: RawPath, prefix: RawPath, active: boolean): Finding {
  return buildFinding({
    providerId: ID,
    providerVersion: VERSION,
    category: "dev-environment",
    slug: slugForPath(path),
    title: `conda environment ${basename(path)} in ${basename(prefix)}`,
    evidence: [
      "A conda-meta directory proves this is an environment rather than a directory beside one.",
      active
        ? "CONDA_PREFIX points at it, so it is the environment this shell is using."
        : "Rebuilding it needs its environment file and the packages it names.",
    ],
    paths: [path],
    active,
    actions: active ? [] : ["trash"],
    regenerationCost: "Recreated from an environment file, if one was kept.",
  });
}

async function installations(environment: DiscoveryEnvironment): Promise<readonly RawPath[]> {
  const candidates = prefixCandidates(environment);
  const present = await existingPaths(environment, candidates);
  const installs: RawPath[] = [];
  const seen = new Set<string>();
  for (const candidate of present) {
    if (seen.has(candidate.bytesBase64)) {
      continue;
    }
    seen.add(candidate.bytesBase64);
    if (await exists(environment, joinPath(candidate, "conda-meta"))) {
      installs.push(candidate);
    }
  }
  return installs;
}
