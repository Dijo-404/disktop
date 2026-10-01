import { homedir } from "node:os";
import { createDashboardService, type DashboardService, type DashboardSettings } from "../application/dashboard.js";
import { createExploreService, type ExploreService } from "../application/explore.js";
import { createFootprintService, type FootprintService } from "../application/footprint.js";
import { createScanService, type ScanService } from "../application/scan.js";
import { createSnapshotService, type SnapshotService } from "../application/snapshots.js";
import type { RawPath, Warning } from "../domain/models.js";
import { rawPathFromUtf8 } from "../domain/paths.js";
import { createLinuxInventory } from "../platform/linux/inventory/index.js";
import { createIndexFootprint } from "../platform/linux/footprint.js";
import { createPathProbe } from "../platform/linux/probe.js";
import { createToolPort } from "../platform/linux/tools.js";
import { createPackageInventory } from "../platform/linux/packages/index.js";
import { createBuiltInProviders } from "../providers/index.js";
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
  readonly footprint: FootprintService;
  readonly scanDefaults: {
    readonly accounting: Accounting;
    readonly crossFilesystems: boolean;
    readonly excludes: readonly RawPath[];
    readonly retention: RetentionLimits;
  };
  readonly settings: DashboardSettings;
  readonly startupWarnings: readonly Warning[];
}

/** Directory names that mark regenerable build output. */
const DEFAULT_ARTIFACT_DIRECTORIES: readonly string[] = [
  "node_modules",
  "target",
  "__pycache__",
  ".next",
  ".nuxt",
  "build",
  "dist",
];

/** The size above which a log file is worth reporting on its own. */
const DEFAULT_LARGE_LOG_BYTES = 128n * 1024n * 1024n;

/** The cap that keeps one noisy detector from flooding the list. */
const DEFAULT_MAX_FINDINGS_PER_PROVIDER = 50;

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

  const snapshotStore = createSnapshotStore(locations.dataDirectory);
  const snapshots = createSnapshotService(snapshotStore, scanner);

  const home = rawPathFromUtf8(options.homeDirectory ?? homedir());
  const footprints = createIndexFootprint({
    scanner,
    index: scanner,
    snapshots: snapshotStore,
    home,
    accounting: config.scan.accounting,
    crossFilesystems: config.scan.crossFilesystems,
    excludes,
  });
  const tools = createToolPort();
  const discovery = {
    home,
    variables: environment,
    userId: BigInt(process.getuid?.() ?? 0),
    now: new Date(),
    staleAfterDays: config.find.staleAfterDays,
    appImageRoots: [],
    artifactDirectories: DEFAULT_ARTIFACT_DIRECTORIES,
    largeLogBytes: DEFAULT_LARGE_LOG_BYTES,
    maxFindingsPerProvider: DEFAULT_MAX_FINDINGS_PER_PROVIDER,
    paths: createPathProbe(),
    tools: tools,
    index: footprints,
  };

  return {
    dashboard,
    scan: createScanService(scanner, {
      crossFilesystems: config.scan.crossFilesystems,
      accounting: config.scan.accounting,
      excludes,
    }),
    explore: createExploreService(scanner),
    snapshots,
    footprint: createFootprintService(createBuiltInProviders({ packages: createPackageInventory(tools) }), discovery, footprints),
    scanDefaults: {
      accounting: config.scan.accounting,
      crossFilesystems: config.scan.crossFilesystems,
      excludes,
      retention: { keepLatest: config.snapshots.keepLatest },
    },
    settings,
    startupWarnings,
  };
}
