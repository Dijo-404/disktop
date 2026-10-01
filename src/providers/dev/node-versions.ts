import type { Finding } from "../../domain/findings.js";
import type { RawPath } from "../../domain/models.js";
import type { DiscoveryEnvironment, FindingProvider } from "../../ports/providers.js";
import {
  basename,
  buildFinding,
  childDirectories,
  exists,
  rootsCapability,
  slugForPath,
  underHome,
} from "../support.js";

const ID = "dev.node-versions";
const VERSION = 1;

interface Manager {
  readonly name: string;
  readonly versions: readonly string[];
  /** The file naming the default version, when the manager keeps one. */
  readonly defaultFile?: readonly string[];
}

const MANAGERS: readonly Manager[] = [
  { name: "nvm", versions: [".nvm", "versions", "node"], defaultFile: [".nvm", "alias", "default"] },
  { name: "fnm", versions: [".local", "share", "fnm", "node-versions"] },
  { name: "fnm", versions: [".fnm", "node-versions"] },
  { name: "Volta", versions: [".volta", "tools", "image", "node"] },
  { name: "asdf", versions: [".asdf", "installs", "nodejs"] },
];

/**
 * The Node versions a version manager keeps installed.
 *
 * Each one is a complete runtime with its own global packages. The version an
 * alias points at is marked in use, because removing the default is how a
 * shell stops having a `node` at all.
 */
export function createNodeVersionsProvider(): FindingProvider {
  return {
    id: ID,
    version: VERSION,
    categories: ["dev-environment"],

    async probe(environment) {
      return rootsCapability(await presentManagers(environment), "Node version managers");
    },

    async discover(environment) {
      const findings: Finding[] = [];

      for (const manager of MANAGERS) {
        const root = underHome(environment, ...manager.versions);
        if (!(await exists(environment, root))) {
          continue;
        }
        const selected =
          manager.defaultFile === undefined
            ? undefined
            : (await environment.paths.readText(underHome(environment, ...manager.defaultFile), 256))
                ?.trim()
                .split("\n")[0];

        for (const version of await childDirectories(environment, root)) {
          const name = basename(version);
          const active = selected !== undefined && name === selected;
          findings.push(versionFinding(version, manager.name, name, active));
        }
      }

      return { findings, warnings: [], complete: true };
    },
  };
}

function versionFinding(path: RawPath, manager: string, name: string, active: boolean): Finding {
  return buildFinding({
    providerId: ID,
    providerVersion: VERSION,
    category: "dev-environment",
    slug: slugForPath(path),
    title: `Node ${name} installed by ${manager}`,
    evidence: [
      "A complete runtime, with whatever global packages were installed into it.",
      active
        ? `${manager}'s default alias points at it, so removing it would leave this shell without node.`
        : `Nothing in ${manager}'s configuration names it as the default.`,
    ],
    paths: [path],
    active,
    actions: active ? [] : ["trash"],
    regenerationCost: "Reinstalled by the version manager, with its global packages installed again by hand.",
  });
}

async function presentManagers(environment: DiscoveryEnvironment): Promise<readonly RawPath[]> {
  const found: RawPath[] = [];
  for (const manager of MANAGERS) {
    const root = underHome(environment, ...manager.versions);
    if (await exists(environment, root)) {
      found.push(root);
    }
  }
  return found;
}
