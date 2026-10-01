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
  /** Where an alias that names another alias is resolved from. */
  readonly aliasDirectory?: readonly string[];
}

const MANAGERS: readonly Manager[] = [
  {
    name: "nvm",
    versions: [".nvm", "versions", "node"],
    defaultFile: [".nvm", "alias", "default"],
    aliasDirectory: [".nvm", "alias"],
  },
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
        const versions = await childDirectories(environment, root);
        const selected =
          manager.defaultFile === undefined
            ? undefined
            : await resolveDefault(environment, manager, versions);

        for (const version of versions) {
          const name = basename(version);
          // A manager with no default file never claims one; a manager whose
          // default could not be resolved does not get to call every version
          // inactive, because the one it names may be among them.
          const state: ActiveState =
            manager.defaultFile === undefined
              ? "no-default-recorded"
              : selected === undefined
                ? "unresolved"
                : name === selected
                  ? "default"
                  : "not-default";
          findings.push(versionFinding(version, manager.name, name, state));
        }
      }

      return { findings, warnings: [], complete: true };
    },
  };
}

/**
 * What is known about whether a version is the default.
 *
 * `unresolved` is the one that matters: nvm writes `lts/iron` or `20` into its
 * alias file, and an alias can point at another alias. When the chain cannot be
 * followed, the honest answer is that Disktop does not know which version is
 * the default — not that none of them is. Calling them all inactive would
 * offer somebody's only Node runtime for removal.
 */
type ActiveState = "default" | "not-default" | "unresolved" | "no-default-recorded";

function versionFinding(path: RawPath, manager: string, name: string, state: ActiveState): Finding {
  const known = state === "not-default";
  const evidence: Record<ActiveState, string> = {
    default: `${manager}'s default alias points at it, so removing it would leave this shell without node.`,
    "not-default": `${manager}'s default alias names another version.`,
    unresolved: `${manager}'s default could not be established, so whether this is the version in use is unknown.`,
    "no-default-recorded": `${manager} records no default, so whether this is the version in use is unknown.`,
  };
  return buildFinding({
    providerId: ID,
    providerVersion: VERSION,
    category: "dev-environment",
    slug: slugForPath(path),
    title: `Node ${name} installed by ${manager}`,
    evidence: ["A complete runtime, with whatever global packages were installed into it.", evidence[state]],
    paths: [path],
    confidence: known ? "observed" : "uncertain",
    active: !known,
    actions: known ? ["trash"] : [],
    regenerationCost: "Reinstalled by the version manager, with its global packages installed again by hand.",
  });
}

/**
 * The version a manager's default file names, as a directory name.
 *
 * nvm writes `lts/iron`, `node`, `20`, or `v20.11.0`, and an alias may point at
 * another alias, so the chain is followed a bounded number of times and the
 * result is matched against the directories that actually exist.
 */
async function resolveDefault(
  environment: DiscoveryEnvironment,
  manager: Manager,
  versions: readonly RawPath[],
): Promise<string | undefined> {
  const names = versions.map((version) => basename(version));
  let value = (await environment.paths.readText(underHome(environment, ...(manager.defaultFile as readonly string[])), 256))
    ?.trim()
    .split("\n")[0]
    ?.trim();

  for (let step = 0; step < 4 && value !== undefined && value !== ""; step += 1) {
    const matched = matchVersion(value, names);
    if (matched !== undefined) {
      return matched;
    }
    if (manager.aliasDirectory === undefined || value.includes("..") || value.startsWith("/")) {
      return undefined;
    }
    value = (await environment.paths.readText(underHome(environment, ...manager.aliasDirectory, ...value.split("/")), 256))
      ?.trim()
      .split("\n")[0]
      ?.trim();
  }
  return undefined;
}

/** `v24.8.0`, `24.8.0`, and `24` all name the directory `v24.8.0`. */
function matchVersion(value: string, names: readonly string[]): string | undefined {
  if (names.includes(value)) {
    return value;
  }
  if (!/^v?[0-9]+(\.[0-9]+)*$/.test(value)) {
    return undefined;
  }
  const wanted = value.startsWith("v") ? value : `v${value}`;
  const matches = names.filter((name) => name === wanted || name.startsWith(`${wanted}.`));
  return matches.length === 1 ? matches[0] : undefined;
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
