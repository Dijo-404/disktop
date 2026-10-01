import type { Finding } from "../../domain/findings.js";
import type { RawPath, Warning } from "../../domain/models.js";
import type { DiscoveryEnvironment, FindingProvider } from "../../ports/providers.js";
import { absolutePath, buildFinding, childDirectories, exists, joinPath, slugForPath } from "../support.js";

const ID = "storage.system-snapshots";
const VERSION = 1;

const TIMESHIFT_ROOTS: readonly string[] = ["/timeshift", "/run/timeshift", "/mnt/timeshift"];

export interface SystemSnapshotOptions {
  readonly timeshiftRoots?: readonly RawPath[];
}

/**
 * Filesystem snapshots: Timeshift directories, btrfs subvolumes, ZFS snapshots.
 *
 * Everything here is read-only, and for one reason. A snapshot shares its
 * blocks with the live filesystem and with the snapshots around it, so
 * deleting one can free anything between its whole apparent size and nothing
 * at all. Offering a number as reclaimable space would be a guess, and
 * offering an action on it would be a guess acted on.
 */
export function createSystemSnapshotsProvider(options: SystemSnapshotOptions = {}): FindingProvider {
  const timeshiftRoots =
    options.timeshiftRoots ??
    TIMESHIFT_ROOTS.map(absolutePath).filter((path): path is RawPath => path !== undefined);

  return {
    id: ID,
    version: VERSION,
    categories: ["system-snapshot"],

    async probe() {
      // Even with no Timeshift directory, btrfs or zfs may have something to say.
      return { status: "available", explanation: "Snapshot sources are read where they exist." };
    },

    async discover(environment) {
      const findings: Finding[] = [];
      const warnings: Warning[] = [];

      for (const root of timeshiftRoots) {
        const snapshots = joinPath(root, "snapshots");
        if (!(await exists(environment, snapshots))) {
          continue;
        }
        for (const snapshot of await childDirectories(environment, snapshots)) {
          findings.push(
            buildFinding({
              providerId: ID,
              providerVersion: VERSION,
              category: "system-snapshot",
              slug: slugForPath(snapshot),
              title: `Timeshift snapshot ${snapshot.display.slice(snapshot.display.lastIndexOf("/") + 1)}`,
              evidence: [
                "A system restore point Timeshift owns; remove it with Timeshift so its own index stays correct.",
                "A snapshot shares blocks with the live filesystem, so deleting it may free nothing.",
              ],
              paths: [snapshot],
              confidence: "uncertain",
              actions: [],
            }),
          );
        }
      }

      findings.push(...(await btrfsFindings(environment, warnings)));
      findings.push(...(await zfsFindings(environment, warnings)));

      return { findings, warnings, complete: warnings.length === 0 };
    },
  };
}

async function btrfsFindings(
  environment: DiscoveryEnvironment,
  warnings: Warning[],
): Promise<readonly Finding[]> {
  const outcome = await environment.tools.run("btrfs", ["subvolume", "list", "/"]);
  if (outcome.capability.status !== "available") {
    // Being denied means there may be subvolumes nobody could read, which makes
    // the answer short. A machine with no btrfs at all is simply a machine with
    // no btrfs, and saying so every run would make every run incomplete.
    if (outcome.capability.status === "permission-denied") {
      warnings.push({
        code: "subvolumes-unavailable",
        message: `btrfs subvolumes were not read: ${outcome.capability.explanation}`,
      });
    }
    return [];
  }

  const findings: Finding[] = [];
  for (const line of outcome.stdout.split("\n")) {
    const match = /^ID (\d+) .*\bpath (.+)$/.exec(line.trim());
    if (match === null) {
      continue;
    }
    const [, id, path] = match as unknown as [string, string, string];
    findings.push(
      buildFinding({
        providerId: ID,
        providerVersion: VERSION,
        category: "system-snapshot",
        slug: `btrfs-${id}`,
        title: `btrfs subvolume ${path}`,
        evidence: [
          `btrfs subvolume list reported it as subvolume ${id}.`,
          "Subvolumes share extents, so a subvolume's size is not space that deleting it would free.",
        ],
        confidence: "uncertain",
        actions: [],
      }),
    );
  }
  return findings;
}

async function zfsFindings(environment: DiscoveryEnvironment, warnings: Warning[]): Promise<readonly Finding[]> {
  const outcome = await environment.tools.run("zfs", ["list", "-H", "-p", "-t", "snapshot", "-o", "name,used"]);
  if (outcome.capability.status !== "available") {
    // A machine with no ZFS is not an incomplete reading, only an absent one.
    return [];
  }

  const findings: Finding[] = [];
  for (const line of outcome.stdout.split("\n")) {
    const [name, used] = line.split("\t");
    if (name === undefined || name === "" || used === undefined || !/^[0-9]+$/.test(used)) {
      continue;
    }
    findings.push(
      buildFinding({
        providerId: ID,
        providerVersion: VERSION,
        category: "system-snapshot",
        slug: `zfs-${name.replace(/[^A-Za-z0-9._-]+/g, "-")}`,
        title: `ZFS snapshot ${name}`,
        evidence: [
          `zfs list reports ${used} bytes as used by this snapshot alone.`,
          "That figure counts only blocks no other snapshot references; destroying several at once can free more.",
        ],
        confidence: "uncertain",
        actions: [],
      }),
    );
  }
  void warnings;
  return findings;
}
