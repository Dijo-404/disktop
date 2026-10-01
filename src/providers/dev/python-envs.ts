import type { Finding } from "../../domain/findings.js";
import type { RawPath, Warning } from "../../domain/models.js";
import type { DiscoveryEnvironment, FindingProvider } from "../../ports/providers.js";
import {
  basename,
  buildFinding,
  childDirectories,
  exists,
  joinPath,
  noStoredScan,
  parentOf,
  rootsCapability,
  slugForPath,
  underHome,
} from "../support.js";

const ID = "dev.python-envs";
const VERSION = 1;
const MARKER = "pyvenv.cfg";

/** The directories a tool collects virtual environments in. */
const COLLECTIONS: readonly (readonly string[])[] = [
  [".virtualenvs"],
  [".local", "share", "virtualenvs"],
  [".cache", "pypoetry", "virtualenvs"],
  [".cache", "pipenv", "venvs"],
];

/** The names a project gives its own environment, looked for in the index. */
const PROJECT_NAMES: readonly string[] = [".venv", "venv", "env"];

/**
 * Python virtual environments, wherever a tool or a project put them.
 *
 * `pyvenv.cfg` is the proof. A directory called `venv` is a name; the file is
 * what the interpreter itself writes, and without it there is nothing to say
 * the directory can be rebuilt from a requirements file.
 *
 * Project environments are found through a stored scan rather than by walking,
 * so a machine with no scan is told its projects were not looked at instead of
 * being told it has none.
 */
export function createPythonEnvsProvider(): FindingProvider {
  return {
    id: ID,
    version: VERSION,
    categories: ["dev-environment"],

    async probe(environment) {
      const collections = await presentCollections(environment);
      if (collections.length > 0) {
        return { status: "available", explanation: `${collections.length} virtual environment directories exist.` };
      }
      // Projects may still hold environments the index can find.
      return rootsCapability([underHome(environment)], "home directories");
    },

    async discover(environment) {
      const findings: Finding[] = [];
      const warnings: Warning[] = [];
      const seen = new Set<string>();

      for (const collection of await presentCollections(environment)) {
        for (const candidate of await childDirectories(environment, collection)) {
          if (await exists(environment, joinPath(candidate, MARKER))) {
            seen.add(candidate.bytesBase64);
            findings.push(finding(candidate, "observed"));
          }
        }
      }

      const search = await environment.index.directoriesNamed(PROJECT_NAMES, environment.maxFindingsPerProvider);
      if (!search.searched) {
        warnings.push(noStoredScan("virtual environments inside projects"));
      } else if (search.truncated) {
        warnings.push({
          code: "findings-truncated",
          message:
            "More project directories matched than this run looked at. Raise providers.max_findings_per_provider to see the rest.",
        });
      }
      for (const candidate of search.paths) {
        if (seen.has(candidate.bytesBase64) || !(await exists(environment, joinPath(candidate, MARKER)))) {
          continue;
        }
        seen.add(candidate.bytesBase64);
        findings.push(finding(candidate, "observed"));
      }

      return { findings, warnings, complete: search.searched && !search.truncated };
    },
  };
}

function finding(path: RawPath, confidence: "observed" | "likely"): Finding {
  return buildFinding({
    providerId: ID,
    providerVersion: VERSION,
    category: "dev-environment",
    slug: slugForPath(path),
    title: `Python environment ${basename(path)} in ${basename(parentOf(path))}`,
    evidence: [
      `A ${MARKER} file written by the interpreter proves this is an environment.`,
      "Rebuilding it needs the requirements file the project keeps, and the network.",
    ],
    paths: [path],
    confidence,
    actions: ["trash"],
    regenerationCost: "Recreated by the project's own setup step, if its requirements are pinned.",
  });
}

async function presentCollections(environment: DiscoveryEnvironment): Promise<readonly RawPath[]> {
  const found: RawPath[] = [];
  for (const segments of COLLECTIONS) {
    const path = underHome(environment, ...segments);
    if (await exists(environment, path)) {
      found.push(path);
    }
  }
  return found;
}
