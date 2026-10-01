import type { Finding } from "../../domain/findings.js";
import type { RawPath } from "../../domain/models.js";
import type { FindingProvider } from "../../ports/providers.js";
import {
  basename,
  buildFinding,
  childDirectories,
  exists,
  joinPath,
  slugForPath,
  underHome,
} from "../support.js";

const ID = "cache.electron";
const VERSION = 1;

/** The directories Chromium creates inside an Electron application's data. */
const CACHE_NAMES: readonly string[] = ["Cache", "Code Cache", "GPUCache", "DawnCache", "ShaderCache"];

/** Where desktop applications keep per-application data. */
const APPLICATION_ROOTS: readonly (readonly string[])[] = [
  [".config"],
  [".local", "share"],
  [".var", "app"],
];

/**
 * The Chromium caches that every Electron application carries.
 *
 * There is no list of applications here: the detector looks one level into the
 * directories applications keep their data in, and reports the ones that have
 * a Chromium cache inside. A new chat application needs no code change to be
 * found, and a directory with no cache in it is left alone.
 *
 * Overlap with the browser and IDE detectors is deliberate. Both will see
 * `~/.config/Code/Cache`; the merge in `domain/findings.ts` decides which
 * description a reader gets, rather than each detector guessing.
 */
export function createElectronCacheProvider(): FindingProvider {
  return {
    id: ID,
    version: VERSION,
    categories: ["app-cache"],

    async probe(environment) {
      for (const root of APPLICATION_ROOTS) {
        if (await exists(environment, underHome(environment, ...root))) {
          return { status: "available", explanation: "Application data directories exist." };
        }
      }
      return { status: "missing-tool", explanation: "No application data directory exists under this home directory." };
    },

    async discover(environment) {
      const findings: Finding[] = [];
      const seen = new Set<string>();

      for (const root of APPLICATION_ROOTS) {
        for (const application of await childDirectories(environment, underHome(environment, ...root))) {
          for (const name of CACHE_NAMES) {
            const path = joinPath(application, name);
            if (seen.has(path.bytesBase64) || !(await exists(environment, path))) {
              continue;
            }
            seen.add(path.bytesBase64);
            findings.push(cacheFinding(path, application, name));
          }
        }
      }

      return { findings, warnings: [], complete: true };
    },
  };
}

function cacheFinding(path: RawPath, application: RawPath, name: string): Finding {
  return buildFinding({
    providerId: ID,
    providerVersion: VERSION,
    category: "app-cache",
    slug: slugForPath(path),
    title: `${basename(application)} ${name}`,
    evidence: [
      `A Chromium ${name} directory inside ${application.display}.`,
      "Messages, settings and signed-in sessions live beside it and are not part of this finding.",
    ],
    paths: [path],
    actions: ["trash"],
    regenerationCost: "Rebuilt as the application is used; the next launch is slower once.",
  });
}
