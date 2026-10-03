import { sanitizeText } from "../../domain/paths.js";
import type { OperationFailure } from "../../domain/errors.js";
import type { CliContext } from "../context.js";
import { EXIT, buildEnvelope, encodeCapability, encodeRawPath, writeEnvelope } from "../output.js";
import { warningLines } from "../text.js";

export interface TimerOptions {
  readonly asJson: boolean;
  readonly action: string;
}

export async function runTimer(context: CliContext, options: TimerOptions): Promise<number> {
  if (options.action !== "install" && options.action !== "uninstall") {
    return refuse(context, options.asJson, { code: "invalid-input", message: "'timer' takes 'install' or 'uninstall'." });
  }
  if (context.timer === undefined) {
    return refuse(context, options.asJson, { code: "unsupported", message: "This build has no timer support." });
  }
  const result = options.action === "install" ? await context.timer.install() : await context.timer.uninstall();
  if (result.kind === "refused") {
    return refuse(context, options.asJson, result.failure);
  }
  const { outcome, warnings } = result;
  const complete = options.action === "uninstall" || outcome.enabled;
  const exitCode = complete ? EXIT.complete : EXIT.incomplete;
  const allWarnings = complete
    ? warnings
    : [...warnings, { code: "timer-not-enabled", message: "The units were written but systemd did not enable the timer." }];

  if (options.asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: "timer",
        generatedAt: context.now(),
        status: complete ? "complete" : "incomplete",
        exitCode,
        warnings: allWarnings,
        data: {
          action: options.action,
          capability: encodeCapability(outcome.capability),
          units: outcome.units.map((unit) => ({ name: unit.name, path: encodeRawPath(unit.path), state: unit.state })),
          enabled: outcome.enabled,
        },
      }),
    );
    return exitCode;
  }

  if (options.action === "install") {
    context.output.stdout(
      outcome.enabled
        ? "Installed disktop-alerts.timer: it runs 'disktop alerts check --notify' hourly and never cleans anything.\nRemove it with 'disktop timer uninstall'.\n"
        : "Wrote the timer units, but systemd did not enable them.\n",
    );
  } else {
    for (const unit of outcome.units) {
      context.output.stdout(`${unit.name}: ${unit.state}\n`);
    }
  }
  for (const line of warningLines(allWarnings)) {
    context.output.stderr(`${line}\n`);
  }
  return exitCode;
}

function refuse(context: CliContext, asJson: boolean, failure: OperationFailure): number {
  if (asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({ command: "timer", generatedAt: context.now(), status: "error", exitCode: EXIT.operationalError, warnings: [], failure }),
    );
  } else {
    context.output.stderr(`${sanitizeText(failure.message)}\n`);
  }
  return EXIT.operationalError;
}
