import type { Finding } from "../../domain/findings.js";
import type { RawPath } from "../../domain/models.js";
import type { DiscoveryEnvironment, FindingProvider } from "../../ports/providers.js";
import {
  basename,
  buildFinding,
  childDirectories,
  exists,
  joinPath,
  parentOf,
  slugForPath,
  underHome,
} from "../support.js";

const ID = "storage.wine";
const VERSION = 1;

/** The registry file Wine writes into every prefix it creates. */
const MARKER = "system.reg";

const SINGLE_PREFIXES: readonly (readonly string[])[] = [[".wine"], [".wine32"], [".wine64"]];
const PREFIX_COLLECTIONS: readonly (readonly string[])[] = [
  [".local", "share", "wineprefixes"],
  [".local", "share", "lutris", "prefixes"],
  [".local", "share", "bottles", "bottles"],
  [".PlayOnLinux", "wineprefix"],
];

/**
 * Wine prefixes: whole Windows installations, one per application.
 *
 * `system.reg` is what proves it. A prefix holds the application's own files
 * and registry, so the installer is needed to rebuild it; this is not a cache,
 * and the finding says so.
 */
export function createWineProvider(): FindingProvider {
  return {
    id: ID,
    version: VERSION,
    categories: ["game-data"],

    async probe(environment) {
      const found = await prefixes(environment);
      return found.length > 0
        ? { status: "available", explanation: `${found.length} Wine prefixes exist.` }
        : { status: "missing-tool", explanation: "No Wine prefix exists under this home directory." };
    },

    async discover(environment) {
      const findings: Finding[] = [];
      for (const prefix of await prefixes(environment)) {
        findings.push(
          buildFinding({
            providerId: ID,
            providerVersion: VERSION,
            category: "game-data",
            slug: slugForPath(prefix),
            title: `Wine prefix ${basename(prefix)} in ${basename(parentOf(prefix))}`,
            evidence: [
              `A ${MARKER} file proves this is a Wine prefix: a whole Windows installation with its own registry.`,
              "Whatever was installed into it, and whatever it saved, is inside.",
            ],
            paths: [prefix],
            confidence: "uncertain",
            actions: ["trash"],
            regenerationCost: "Rebuilt only by running the original installer again.",
          }),
        );
      }
      return { findings, warnings: [], complete: true };
    },
  };
}

async function prefixes(environment: DiscoveryEnvironment): Promise<readonly RawPath[]> {
  const found: RawPath[] = [];
  for (const segments of SINGLE_PREFIXES) {
    const path = underHome(environment, ...segments);
    if (await isPrefix(environment, path)) {
      found.push(path);
    }
  }
  for (const segments of PREFIX_COLLECTIONS) {
    for (const candidate of await childDirectories(environment, underHome(environment, ...segments))) {
      if (await isPrefix(environment, candidate)) {
        found.push(candidate);
      }
    }
  }
  return found;
}

async function isPrefix(environment: DiscoveryEnvironment, path: RawPath): Promise<boolean> {
  return exists(environment, joinPath(path, MARKER));
}
