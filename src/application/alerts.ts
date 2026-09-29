import type { Alert, Filesystem } from "../domain/models.js";
import { formatBytes, usedPercentOfInodes, usedPercentOfSpace } from "../domain/sizes.js";

export interface AlertThresholds {
  readonly spacePercent: number;
  readonly inodePercent: number;
}

export interface AlertFormat {
  readonly units: "iec" | "si";
}

/**
 * Capacity pressure on each filesystem, counted once however many mount points
 * reach it. A threshold is crossed only when the used share has genuinely
 * reached it; the percentage is rounded down for exactly that reason.
 *
 * Low inodes are reported separately because a filesystem with free blocks and
 * no free inodes still fails every write, and no amount of freed space fixes it.
 */
export function evaluateAlerts(
  filesystems: readonly Filesystem[],
  thresholds: AlertThresholds,
  format: AlertFormat = { units: "iec" },
): readonly Alert[] {
  const alerts: Alert[] = [];

  for (const filesystem of filesystems) {
    if (filesystem.network) {
      continue;
    }

    const spacePercent = usedPercentOfSpace(filesystem.totalBytes, filesystem.freeBytes, filesystem.availableBytes);
    if (spacePercent >= thresholds.spacePercent) {
      alerts.push({
        filesystemId: filesystem.id,
        kind: "low-space",
        usedPercent: spacePercent,
        thresholdPercent: thresholds.spacePercent,
        message: `${describeMounts(filesystem)} ${filesystem.type} filesystem is ${spacePercent}% used with ${formatBytes(filesystem.availableBytes, format.units)} available.`,
      });
    }

    if (filesystem.totalInodes !== undefined && filesystem.freeInodes !== undefined && filesystem.totalInodes > 0n) {
      const inodePercent = usedPercentOfInodes(filesystem.totalInodes, filesystem.freeInodes);
      if (inodePercent >= thresholds.inodePercent) {
        alerts.push({
          filesystemId: filesystem.id,
          kind: "low-inodes",
          usedPercent: inodePercent,
          thresholdPercent: thresholds.inodePercent,
          message: `${describeMounts(filesystem)} has ${filesystem.freeInodes} inodes left; low inodes fail writes even when blocks are free.`,
        });
      }
    }
  }

  return alerts;
}

function describeMounts(filesystem: Filesystem): string {
  const points = filesystem.mounts.map((mount) => mount.display);
  if (points.length <= 2) {
    return points.join(" and ");
  }
  return `${points.slice(0, 2).join(", ")} and ${points.length - 2} more`;
}
