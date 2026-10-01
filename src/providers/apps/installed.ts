import { findingSize, type Finding } from "../../domain/findings.js";
import type { Warning } from "../../domain/models.js";
import type { InstalledPackage, ManagerInventory, PackageInventoryPort } from "../../ports/packages.js";
import type { DiscoveryEnvironment, FindingProvider } from "../../ports/providers.js";
import { isWithin, pathBytes } from "../../domain/paths.js";
import { basename, buildFinding, exists, safeSlug, safeText, slugForPath } from "../support.js";

const ID = "apps.installed";
const VERSION = 1;

/** How many individual packages each manager contributes, largest first. */
const PER_MANAGER = 5;

/**
 * What is installed on this machine, and whose number each size is.
 *
 * Every manager keeps its row even when it is not installed, because "pacman
 * is not here" and "pacman reported nothing" are different facts and a reader
 * has to be able to tell them apart.
 *
 * No size here is a measurement. dpkg declares an unpacked size, rpm and
 * pacman sum their file sizes, Flatpak deduplicates across runtimes, and snap,
 * npm and pip report nothing at all. Each finding repeats what its number
 * means rather than letting it pass for bytes that could be reclaimed.
 */
export function createInstalledAppsProvider(packages: PackageInventoryPort): FindingProvider {
  return {
    id: ID,
    version: VERSION,
    categories: ["installed-app"],

    async probe() {
      const inventories = await packages.list();
      const answered = inventories.filter((inventory) => inventory.capability.status === "available");
      if (answered.length === 0) {
        return { status: "missing-tool", explanation: "No supported package manager answered on this machine." };
      }
      return {
        status: "available",
        explanation: `${answered.map((inventory) => inventory.manager).join(", ")} answered.`,
      };
    },

    async discover(environment) {
      const inventories = await packages.list();
      const findings: Finding[] = [];
      const warnings: Warning[] = [];
      let complete = true;

      for (const inventory of inventories) {
        if (inventory.capability.status === "permission-denied") {
          warnings.push({
            code: "manager-denied",
            message: `${inventory.manager} refused to list its packages: ${inventory.capability.explanation}`,
          });
          complete = false;
          continue;
        }
        if (inventory.capability.status !== "available" || inventory.packages.length === 0) {
          continue;
        }
        findings.push(summaryFinding(inventory));
      }

      for (const inventory of inventories) {
        if (inventory.capability.status !== "available") {
          continue;
        }
        for (const entry of largest(inventory.packages)) {
          findings.push(packageFinding(inventory, entry));
        }
      }

      findings.push(...(await appImageFindings(environment)));
      return { findings, warnings, complete };
    },
  };
}

function summaryFinding(inventory: ManagerInventory): Finding {
  const measured = inventory.packages.filter((entry) => entry.reportedBytes !== undefined);
  const total = measured.reduce((sum, entry) => sum + (entry.reportedBytes ?? 0n), 0n);
  const unmeasured = inventory.packages.length - measured.length;

  return buildFinding({
    providerId: ID,
    providerVersion: VERSION,
    category: "installed-app",
    slug: `${inventory.manager}-installed`,
    title: `${inventory.packages.length} packages installed through ${inventory.manager}`,
    evidence: [
      inventory.sizeMeaning,
      unmeasured === 0
        ? `All ${inventory.packages.length} packages reported a size.`
        : `${unmeasured} of ${inventory.packages.length} packages reported no size, so they add nothing to the total.`,
    ],
    managerScope: inventory.manager,
    size:
      measured.length === 0
        ? findingSize(undefined, "unknown", `${inventory.manager} reports no size for its packages.`)
        : findingSize(total, "manager-reported", inventory.sizeMeaning),
    confidence: "likely",
    capability: inventory.capability,
    actions: [],
    active: true,
  });
}

function packageFinding(inventory: ManagerInventory, entry: InstalledPackage): Finding {
  return buildFinding({
    providerId: ID,
    providerVersion: VERSION,
    category: "installed-app",
    slug: `${inventory.manager}-${safeSlug(entry.name, 64)}`,
    title: `${safeText(entry.name, 64)}${entry.version === undefined ? "" : ` ${safeText(entry.version, 32)}`} (${inventory.manager})`,
    evidence: [
      `One of the largest packages ${inventory.manager} reports.`,
      inventory.sizeMeaning,
      "Removing it is the manager's job, and the manager knows what else depends on it.",
    ],
    managerScope: `${inventory.manager} ${entry.name}`,
    size:
      entry.reportedBytes === undefined
        ? findingSize(undefined, "unknown", `${inventory.manager} reports no size for this package.`)
        : findingSize(entry.reportedBytes, "manager-reported", inventory.sizeMeaning),
    confidence: "likely",
    capability: inventory.capability,
    actions: ["manager"],
    active: true,
  });
}

/** Largest reported first; packages with no size never displace one that has. */
function largest(packages: readonly InstalledPackage[]): readonly InstalledPackage[] {
  return [...packages]
    .filter((entry) => entry.reportedBytes !== undefined)
    .sort((left, right) => ((left.reportedBytes ?? 0n) > (right.reportedBytes ?? 0n) ? -1 : 1))
    .slice(0, PER_MANAGER);
}

/** AppImages are single files in configured directories, with no manager at all. */
async function appImageFindings(environment: DiscoveryEnvironment): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  for (const root of environment.appImageRoots) {
    if (!(await exists(environment, root))) {
      continue;
    }
    for (const entry of await environment.paths.list(root)) {
      if (!basename(entry).toLowerCase().endsWith(".appimage")) {
        continue;
      }
      const facts = await environment.paths.facts(entry);
      if (facts === undefined || facts.kind !== "file") {
        continue;
      }
      // An AppImage under /opt belongs to whoever installed it system-wide.
      // Only one in this user's own home is theirs to move to the Trash.
      const mine = facts.ownerId === environment.userId && isWithin(pathBytes(environment.home), pathBytes(entry));
      findings.push(
        buildFinding({
          providerId: ID,
          providerVersion: VERSION,
          category: "installed-app",
          slug: slugForPath(entry),
          title: `AppImage ${basename(entry)}`,
          evidence: [
            "A self-contained application file with no package manager behind it.",
            "Its settings and data live elsewhere and are not part of this finding.",
            mine
              ? "It is yours and sits in your home directory."
              : "It sits outside your home directory or belongs to another user, so it is reported rather than offered.",
          ],
          paths: [entry],
          size: findingSize(facts.allocatedBytes, "stat", "Blocks on disk from one stat call."),
          actions: mine ? ["trash"] : [],
          active: true,
        }),
      );
    }
  }
  return findings;
}
