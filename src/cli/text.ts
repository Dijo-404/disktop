import type { Alert, Filesystem, StorageDevice, Warning } from "../domain/models.js";
import { formatBytes, usedPercentOfInodes, usedPercentOfSpace } from "../domain/sizes.js";

export type Units = "iec" | "si";

/** A fixed-width capacity table that still reads at 80 columns. */
export function filesystemLines(filesystems: readonly Filesystem[], units: Units): string[] {
  if (filesystems.length === 0) {
    return ["No filesystems could be inspected."];
  }

  const rows = filesystems.map((filesystem) => ({
    mount: filesystem.mounts.map((mount) => mount.display).join(", "),
    type: filesystem.type,
    size: formatBytes(filesystem.totalBytes, units),
    available: formatBytes(filesystem.availableBytes, units),
    used: `${usedPercentOfSpace(filesystem.totalBytes, filesystem.freeBytes, filesystem.availableBytes)}%`,
    inodes:
      filesystem.totalInodes === undefined || filesystem.freeInodes === undefined
        ? "-"
        : `${usedPercentOfInodes(filesystem.totalInodes, filesystem.freeInodes)}%`,
  }));

  const mountWidth = Math.max(11, ...rows.map((row) => row.mount.length));
  const typeWidth = Math.max(4, ...rows.map((row) => row.type.length));
  const header = `${"Mount".padEnd(mountWidth)}  ${"Type".padEnd(typeWidth)}  ${"Size".padStart(10)}  ${"Available".padStart(10)}  ${"Used".padStart(5)}  ${"Inodes".padStart(6)}`;

  return [
    header,
    ...rows.map(
      (row) =>
        `${row.mount.padEnd(mountWidth)}  ${row.type.padEnd(typeWidth)}  ${row.size.padStart(10)}  ${row.available.padStart(10)}  ${row.used.padStart(5)}  ${row.inodes.padStart(6)}`,
    ),
  ];
}

export function deviceLines(devices: readonly StorageDevice[], units: Units): string[] {
  if (devices.length === 0) {
    return ["No block devices could be inspected."];
  }

  const rows = devices.map((device) => ({
    name: device.name,
    kind: device.kind,
    size: formatBytes(device.sizeBytes, units),
    detail: [device.transport, device.model, device.removable ? "removable" : undefined].filter((part) => part !== undefined).join(" "),
    partitions: String(device.partitions.length),
  }));

  const nameWidth = Math.max(6, ...rows.map((row) => row.name.length));
  return [
    `${"Device".padEnd(nameWidth)}  ${"Kind".padEnd(7)}  ${"Size".padStart(10)}  ${"Parts".padStart(5)}  Detail`,
    ...rows.map((row) => `${row.name.padEnd(nameWidth)}  ${row.kind.padEnd(7)}  ${row.size.padStart(10)}  ${row.partitions.padStart(5)}  ${row.detail}`),
  ];
}

export function alertLines(alerts: readonly Alert[]): string[] {
  return alerts.map((alert) => `[${alert.kind}] ${alert.message}`);
}

/** Warnings go to stderr so a redirected stdout still holds only the answer. */
export function warningLines(warnings: readonly Warning[]): string[] {
  return warnings.map((warning) => `warning: ${warning.code}: ${warning.message}`);
}
