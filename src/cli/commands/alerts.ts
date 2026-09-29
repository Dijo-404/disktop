import { evaluateAlerts } from "../../application/alerts.js";
import type { CliContext } from "../context.js";
import { EXIT, buildEnvelope, encodeAlert, encodeCapability, encodeFilesystem, writeEnvelope } from "../output.js";
import { alertLines, warningLines } from "../text.js";

export interface AlertsOptions {
  readonly asJson: boolean;
  readonly thresholdPercent?: number;
}

/**
 * `disktop alerts check`. Reaching a threshold is the expected monitoring
 * outcome, so it exits 1; a threshold reached on an incomplete inventory still
 * reports incomplete, because the alert may not be the whole story.
 */
export async function runAlertsCheck(context: CliContext, options: AlertsOptions): Promise<number> {
  const view = await context.dashboard.dashboard();
  const thresholds =
    options.thresholdPercent === undefined
      ? context.settings.thresholds
      : { spacePercent: options.thresholdPercent, inodePercent: options.thresholdPercent };

  const alerts = evaluateAlerts(view.filesystems, thresholds, { units: context.settings.units });
  const status = view.complete ? "complete" : "incomplete";
  const exitCode = !view.complete ? EXIT.incomplete : alerts.length > 0 ? EXIT.alertThresholdReached : EXIT.complete;

  if (options.asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: "alerts check",
        generatedAt: context.now(),
        status,
        exitCode,
        warnings: view.warnings,
        data: {
          capability: encodeCapability(view.capability),
          thresholdPercent: thresholds.spacePercent,
          inodeThresholdPercent: thresholds.inodePercent,
          alerts: alerts.map(encodeAlert),
          filesystems: view.filesystems.map(encodeFilesystem),
        },
      }),
    );
    return exitCode;
  }

  if (alerts.length === 0) {
    context.output.stdout(`No filesystem has reached ${thresholds.spacePercent}% of its space or ${thresholds.inodePercent}% of its inodes.\n`);
  }
  for (const line of alertLines(alerts)) {
    context.output.stdout(`${line}\n`);
  }
  for (const line of warningLines(view.warnings)) {
    context.output.stderr(`${line}\n`);
  }
  return exitCode;
}

export function parseThreshold(value: string | undefined): number | undefined | "invalid" {
  if (value === undefined) {
    return undefined;
  }
  if (!/^(0|[1-9][0-9]?|100)$/.test(value)) {
    return "invalid";
  }
  return Number(value);
}
