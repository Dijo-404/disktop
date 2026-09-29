import { homedir } from "node:os";
import { createDashboardService, type DashboardService, type DashboardSettings } from "../application/dashboard.js";
import type { Warning } from "../domain/models.js";
import { createLinuxInventory } from "../platform/linux/inventory/index.js";
import { loadConfigFile } from "../storage/config.js";
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

  const settings: DashboardSettings = {
    units: loaded.config.units,
    thresholds: {
      spacePercent: loaded.config.alerts.spaceThresholdPercent,
      inodePercent: loaded.config.alerts.inodeThresholdPercent,
    },
  };

  const startupWarnings: Warning[] =
    loaded.problem === undefined ? [] : [{ code: "config-not-applied", message: `${loaded.problem} Built-in defaults are in use.` }];

  return {
    dashboard: createDashboardService(createLinuxInventory(), settings, startupWarnings),
    settings,
    startupWarnings,
  };
}
