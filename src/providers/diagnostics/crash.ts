import type { Finding } from "../../domain/findings.js";
import type { RawPath } from "../../domain/models.js";
import type { DiscoveryEnvironment, FindingProvider } from "../../ports/providers.js";
import { absolutePath, buildFinding, exists, slugForPath, underHome } from "../support.js";

const ID = "diagnostic.crash";
const VERSION = 1;

const SYSTEM_ROOTS: readonly string[] = ["/var/crash", "/var/lib/systemd/coredump", "/var/spool/abrt"];
const USER_ROOTS: readonly (readonly string[])[] = [[".cache", "abrt"], [".local", "share", "crash"]];

export interface CrashOptions {
  readonly systemRoots?: readonly string[];
}

/**
 * Crash dumps and core files.
 *
 * A core file is a copy of a process's memory, so these directories are often
 * large and often contain whatever that process was holding at the time:
 * documents, keys, session tokens. The user-owned directories can be put in
 * the Trash through the ordinary reviewed pipeline; the system ones are
 * root-owned and belong to the crash reporter that wrote them, so they are
 * reported rather than offered.
 */
export function createCrashProvider(options: CrashOptions = {}): FindingProvider {
  const systemRoots = (options.systemRoots ?? SYSTEM_ROOTS)
    .map(absolutePath)
    .filter((path): path is RawPath => path !== undefined);

  return {
    id: ID,
    version: VERSION,
    categories: ["crash-dump"],

    async probe(environment) {
      const present = await presentRoots(environment, systemRoots);
      return present.length > 0
        ? { status: "available", explanation: `${present.length} crash directories exist.` }
        : { status: "missing-tool", explanation: "No crash or core dump directory exists on this machine." };
    },

    async discover(environment) {
      const findings: Finding[] = [];

      for (const root of await presentRoots(environment, systemRoots)) {
        const owned = (await environment.paths.facts(root))?.ownerId === environment.userId;
        findings.push(
          buildFinding({
            providerId: ID,
            providerVersion: VERSION,
            category: "crash-dump",
            slug: slugForPath(root),
            title: `Crash dumps in ${root.display}`,
            evidence: [
              "A core file is a copy of a process's memory, so these can hold documents, keys, or session tokens.",
              owned
                ? "This directory belongs to you, so it can go through the ordinary reviewed Trash action."
                : "This directory belongs to the system crash reporter, which is what should remove its own files.",
            ],
            paths: [root],
            actions: owned ? ["trash"] : [],
            regenerationCost: "Crash dumps are only useful to whoever is debugging the crash that produced them.",
          }),
        );
      }

      return { findings, warnings: [], complete: true };
    },
  };
}

async function presentRoots(
  environment: DiscoveryEnvironment,
  systemRoots: readonly RawPath[],
): Promise<readonly RawPath[]> {
  const candidates = [...systemRoots, ...USER_ROOTS.map((segments) => underHome(environment, ...segments))];
  const found: RawPath[] = [];
  for (const candidate of candidates) {
    if (await exists(environment, candidate)) {
      found.push(candidate);
    }
  }
  return found;
}
