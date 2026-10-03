import type { Alert } from "../domain/models.js";
import type { NotificationOutcome, NotificationPort } from "../ports/notifications.js";

const SHOWN = 3;

export async function notifyAlerts(
  port: NotificationPort,
  alerts: readonly Alert[],
): Promise<NotificationOutcome | undefined> {
  if (alerts.length === 0) {
    return undefined;
  }
  const title = alerts.some((alert) => alert.kind === "low-space") ? "Disktop: low disk space" : "Disktop: low inodes";
  const lines = alerts.slice(0, SHOWN).map((alert) => alert.message);
  if (alerts.length > SHOWN) {
    lines.push(`and ${alerts.length - SHOWN} more`);
  }
  return port.send(title, lines.join("\n"));
}
