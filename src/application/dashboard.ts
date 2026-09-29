import type { Alert, Capability, Filesystem, StorageDevice, Warning } from "../domain/models.js";
import type { InventoryPort } from "../ports/inventory.js";
import { evaluateAlerts, type AlertThresholds } from "./alerts.js";

export interface DashboardSettings {
  readonly thresholds: AlertThresholds;
  readonly units: "iec" | "si";
}

/** What every capacity surface shows: the same joined inventory and the same alerts. */
export interface DashboardView {
  readonly capability: Capability;
  readonly filesystems: readonly Filesystem[];
  readonly alerts: readonly Alert[];
  readonly warnings: readonly Warning[];
  readonly complete: boolean;
}

export interface InventoryView extends DashboardView {
  readonly devices: readonly StorageDevice[];
}

export interface DashboardService {
  dashboard(): Promise<DashboardView>;
  inventory(): Promise<InventoryView>;
}

/**
 * `startupWarnings` carry problems found before any device was read, such as a
 * configuration file that could not be applied. They travel with every result
 * so a surface cannot show settings-driven output without showing that the
 * settings were not the ones on disk.
 */
export function createDashboardService(
  inventory: InventoryPort,
  settings: DashboardSettings,
  startupWarnings: readonly Warning[] = [],
): DashboardService {
  const load = async (): Promise<InventoryView> => {
    const result = await inventory.list();
    const alerts = evaluateAlerts(result.filesystems, settings.thresholds, { units: settings.units });
    const warnings = [...startupWarnings, ...result.warnings];
    return {
      capability: result.capability,
      devices: result.devices,
      filesystems: [...result.filesystems].sort(byMountPoint),
      alerts,
      warnings,
      // A warning means something could not be inspected, so the answer is
      // partial. Saying so is the difference between a short list and a lie.
      complete: result.capability.status === "available" && warnings.length === 0,
    };
  };

  return {
    async dashboard() {
      const view = await load();
      return { capability: view.capability, filesystems: view.filesystems, alerts: view.alerts, warnings: view.warnings, complete: view.complete };
    },
    inventory: load,
  };
}

function byMountPoint(left: Filesystem, right: Filesystem): number {
  const leftPoint = left.mounts[0]?.display ?? "";
  const rightPoint = right.mounts[0]?.display ?? "";
  return leftPoint.localeCompare(rightPoint, "en");
}
