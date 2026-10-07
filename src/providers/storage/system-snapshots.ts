import type { Finding } from "../../domain/findings.js";
import type { RawPath, Warning } from "../../domain/models.js";
import type { DiscoveryEnvironment, FindingProvider } from "../../ports/providers.js";
import {
  absolutePath,
  buildFinding,
  childDirectories,
  exists,
  joinPath,
  safeSlug,
  safeText,
  slugForPath,
} from "../support.js";

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

    async discover(environment, signal) {
      signal.throwIfAborted();
      const findings: Finding[] = [];
      const warnings: Warning[] = [];

      for (const root of timeshiftRoots) {
        signal.throwIfAborted();
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

      findings.push(...(await btrfsFindings(environment, warnings, signal)));
      const zfs = await zfsFindings(environment, warnings, signal);
      findings.push(...zfs.findings);

      return { findings, warnings, complete: zfs.complete };
    },
  };
}

async function btrfsFindings(
  environment: DiscoveryEnvironment,
  warnings: Warning[],
  signal: AbortSignal,
): Promise<readonly Finding[]> {
  const outcome = await environment.tools.run("btrfs", ["subvolume", "list", "/"], signal);
  signal.throwIfAborted();
  if (outcome.capability.status !== "available") {
    if (outcome.capability.status === "missing-tool") {
      // No btrfs-progs: this machine has no btrfs, which is a fact about the
      // machine rather than something Disktop failed to read.
      return [];
    }
    // `btrfs subvolume list /` prints the same "Operation not permitted" when
    // the root is not btrfs and when an unprivileged user asks about one that
    // is. The two cannot be told apart from here, so the reading is reported
    // as unavailable without claiming which it was, and without making every
    // run on every non-btrfs machine incomplete.
    warnings.push({
      code: "subvolumes-unavailable",
      message:
        "btrfs subvolumes were not read: either this filesystem is not btrfs, or listing its subvolumes needs privilege.",
    });
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
        slug: `btrfs-${safeSlug(id, 32)}`,
        title: `btrfs subvolume ${safeText(path)}`,
        evidence: [
          `btrfs subvolume list reported it as subvolume ${safeText(id, 32)}.`,
          "Subvolumes share extents, so a subvolume's size is not space that deleting it would free.",
        ],
        confidence: "uncertain",
        actions: [],
      }),
    );
  }
  return findings;
}

async function zfsFindings(
  environment: DiscoveryEnvironment,
  warnings: Warning[],
  signal: AbortSignal,
): Promise<{ readonly findings: readonly Finding[]; readonly complete: boolean }> {
  const outcome = await environment.tools.run("zfs", ["list", "-H", "-p", "-t", "snapshot", "-o", "name,used"], signal);
  signal.throwIfAborted();
  // ToolPort also calls a failed or timed-out command "missing-tool". A
  // genuinely absent executable has no exit/output; an attempted reading must
  // not disappear as if this machine had no ZFS.
  const absent = outcome.capability.status === "missing-tool"
    && outcome.exitCode === null
    && outcome.stdout === ""
    && outcome.stderr === ""
    && !/failed|could not be started|did not finish|was stopped|was terminated/i.test(outcome.capability.explanation);
  if (absent) return { findings: [], complete: true };
  if (outcome.capability.status !== "available" || outcome.exitCode !== 0) {
    const denied = outcome.capability.status === "permission-denied";
    warnings.push({
      code: denied ? "zfs-denied" : "zfs-unavailable",
      message: `ZFS snapshots were not read: ${safeText(outcome.capability.explanation, 256)}. ${denied
        ? "Ask the pool administrator to grant this account read access."
        : "Check that the installed ZFS tools can query the pool."}`,
    });
    return { findings: [], complete: false };
  }

  const findings: Finding[] = [];
  let malformed = 0;
  for (const line of outcome.stdout.split("\n")) {
    signal.throwIfAborted();
    if (line === "") continue;
    const columns = line.split("\t");
    const [name, used] = columns;
    if (columns.length !== 2 || name === undefined || !/^.+@.+$/.test(name) || used === undefined || !/^[0-9]+$/.test(used)) {
      malformed += 1;
      continue;
    }
    findings.push(
      buildFinding({
        providerId: ID,
        providerVersion: VERSION,
        category: "system-snapshot",
        slug: `zfs-${safeSlug(name, 64)}`,
        title: `ZFS snapshot ${safeText(name)}`,
        evidence: [
          `zfs list reports ${used} bytes as used by this snapshot alone.`,
          "That figure counts only blocks no other snapshot references; destroying several at once can free more.",
        ],
        confidence: "uncertain",
        actions: [],
      }),
    );
  }
  if (malformed > 0) {
    warnings.push({
      code: "zfs-output-unreadable",
      message: `${malformed} ZFS snapshot ${malformed === 1 ? "row was" : "rows were"} unreadable; valid rows are retained. Check the installed ZFS tool's output format.`,
    });
  }
  return { findings, complete: malformed === 0 };
}
