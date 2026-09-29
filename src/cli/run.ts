import type { CliContext } from "./context.js";
import { parseArguments, renderHelp, type CommandSpec, type ParsedCommand } from "./parser.js";
import { EXIT, buildEnvelope, writeEnvelope } from "./output.js";
import { runAlertsCheck, parseThreshold } from "./commands/alerts.js";
import { runDashboard } from "./commands/dashboard.js";
import { runDevices } from "./commands/devices.js";

/** Resolve one argument list to an exit status. Nothing here touches a device. */
export async function runCli(args: readonly string[], context: CliContext): Promise<number> {
  const result = parseArguments(args);

  if (result.kind === "version") {
    context.output.stdout(`${context.version}\n`);
    return EXIT.complete;
  }
  if (result.kind === "help") {
    context.output.stdout(renderHelp(result.command));
    return EXIT.complete;
  }
  if (result.kind === "error") {
    context.output.stderr(`${result.message}\n`);
    return EXIT.operationalError;
  }

  const { parsed } = result;
  const asJson = parsed.flags.has("json");
  const withUnits = applyUnits(context, parsed);

  if (!parsed.command.implemented) {
    return notImplemented(withUnits, parsed.command, asJson);
  }

  const name = parsed.command.path.join(" ");
  if (name === "devices") {
    return runDevices(withUnits, asJson);
  }
  if (name === "alerts check") {
    const threshold = parseThreshold(parsed.values.get("threshold"));
    if (threshold === "invalid") {
      withUnits.output.stderr("'--threshold' accepts a whole percentage from 0 to 100.\n");
      return EXIT.operationalError;
    }
    return runAlertsCheck(withUnits, { asJson, ...(threshold === undefined ? {} : { thresholdPercent: threshold }) });
  }

  // The root command: JSON or a redirected stdout means no interactive surface.
  if (asJson || !withUnits.interactive) {
    return runDashboard(withUnits, asJson);
  }
  return withUnits.launchTui(withUnits.settings);
}

function applyUnits(context: CliContext, parsed: ParsedCommand): CliContext {
  const units = parsed.values.get("units");
  if (units !== "iec" && units !== "si") {
    return context;
  }
  return { ...context, settings: { ...context.settings, units } };
}

/**
 * A declared but unbuilt command says so in the same envelope shape a working
 * one uses, so a script reading Disktop's JSON never has to parse prose to
 * discover that nothing happened.
 */
function notImplemented(context: CliContext, command: CommandSpec, asJson: boolean): number {
  const name = command.path.join(" ");
  const message = `Disktop '${name}' is declared but not implemented yet. Run disktop --help.`;

  if (asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: name,
        generatedAt: context.now(),
        status: "error",
        exitCode: EXIT.operationalError,
        warnings: [],
        failure: { code: "not-implemented", message },
      }),
    );
  } else {
    context.output.stderr(`${message}\n`);
  }
  return EXIT.operationalError;
}
