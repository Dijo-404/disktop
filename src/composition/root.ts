import { homedir } from "node:os";
import { createDashboardService, type DashboardService, type DashboardSettings } from "../application/dashboard.js";
import { createExploreService, type ExploreService } from "../application/explore.js";
import { createScanService, type ScanService } from "../application/scan.js";
import { createSnapshotService, type SnapshotService } from "../application/snapshots.js";
import type { RawPath, Warning } from "../domain/models.js";
import { isWithin, pathBytes, rawPathFromUtf8 } from "../domain/paths.js";
import { createLinuxInventory } from "../platform/linux/inventory/index.js";
import { createNativeScanner } from "../platform/linux/scan/index.js";
import { NativeHelperClient } from "../native/client.js";
import type { Accounting } from "../ports/scan.js";
import type { RetentionLimits } from "../ports/snapshots.js";
import { loadConfigFile } from "../storage/config.js";
import { createSnapshotStore } from "../storage/snapshots.js";
import { resolveLocations } from "../storage/xdg.js";

/**
 * The composition root: the one place adapters are chosen and built.
 *
 * Every other layer receives what it needs as an argument, which is why the
 * dependency rule can forbid the CLI, the TUI, and the entry point from
 * reaching a Linux command or the helper at all.
 */
export interface Services {
  readonly dashboard: DashboardService;
  readonly scan: ScanService;
  readonly explore: ExploreService;
  readonly snapshots: SnapshotService;
  readonly scanDefaults: {
    readonly accounting: Accounting;
    readonly crossFilesystems: boolean;
    readonly excludes: readonly RawPath[];
    readonly retention: RetentionLimits;
  };
  filesystemsUnder(roots: readonly RawPath[]): Promise<readonly string[]>;
  readonly settings: DashboardSettings;
  readonly startupWarnings: readonly Warning[];
}

export interface CompositionOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
}

export async function createServices(options: CompositionOptions = {}): Promise<Services> {
  const environment = options.environment ?? process.env;
  const locations = resolveLocations(environment, options.homeDirectory ?? homedir());
  const loaded = await loadConfigFile(locations.configFile);
  const config = loaded.config;

  const settings: DashboardSettings = {
    units: config.units,
    thresholds: {
      spacePercent: config.alerts.spaceThresholdPercent,
      inodePercent: config.alerts.inodeThresholdPercent,
    },
  };

  const startupWarnings: Warning[] =
    loaded.problem === undefined ? [] : [{ code: "config-not-applied", message: `${loaded.problem} Built-in defaults are in use.` }];

  const inventory = createLinuxInventory();
  const dashboard = createDashboardService(inventory, settings, startupWarnings);

  const excludes = [
    ...config.scan.excludes,
    // Disktop's own index lives under the cache directory; scanning it would
    // measure the scan itself.
    locations.cacheDirectory,
    ...(config.scan.excludeWindowsMounts ? ["/mnt/c", "/mnt/wsl"] : []),
  ].map(rawPathFromUtf8);

  const scanner = createNativeScanner({
    indexDirectory: locations.cacheDirectory,
    maxIndexBytes: BigInt(config.scan.maxIndexBytes),
    keepScans: config.scan.keepScans,
    start: () => NativeHelperClient.start(),
  });

  const snapshots = createSnapshotService(createSnapshotStore(locations.dataDirectory), scanner);

  return {
    dashboard,
    scan: createScanService(scanner, {
      crossFilesystems: config.scan.crossFilesystems,
      accounting: config.scan.accounting,
      excludes,
    }),
    explore: createExploreService(scanner),
    snapshots,
    scanDefaults: {
      accounting: config.scan.accounting,
      crossFilesystems: config.scan.crossFilesystems,
      excludes,
      retention: { keepLatest: config.snapshots.keepLatest },
    },
    async filesystemsUnder(roots) {
      const view = await inventory.list();
      const identities = new Set<string>();
      for (const root of roots) {
        const target = pathBytes(root);
        // The filesystem holding a root is the one with the longest mount
        // point that contains it; a shorter one is an ancestor, not the
        // filesystem the scan actually walked.
        let best: { id: string; length: number } | undefined;
        for (const filesystem of view.filesystems) {
          for (const mount of filesystem.mounts) {
            const mountBytes = pathBytes(mount);
            if (isWithin(mountBytes, target) && (best === undefined || mountBytes.length > best.length)) {
              best = { id: filesystem.id, length: mountBytes.length };
            }
          }
        }
        if (best !== undefined) {
          identities.add(best.id);
        }
      }
      return [...identities].sort();
    },
    settings,
    startupWarnings,
  };
}
