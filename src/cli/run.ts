import { sanitizeText } from "../domain/paths.js";
import type { CliContext } from "./context.js";
import { parseArguments, renderHelp, type CliOutput, type CommandSpec, type ParsedCommand } from "./parser.js";
import { EXIT, buildEnvelope, writeEnvelope } from "./output.js";
import { runAlertsCheck, parseThreshold } from "./commands/alerts.js";
import { runApply, runFind, runHistory, runPlan, runUndo } from "./commands/actions.js";
import { runClean } from "./commands/clean.js";
import { runCompletion } from "./commands/completion.js";
import { runDashboard } from "./commands/dashboard.js";
import { runDevices } from "./commands/devices.js";
import { runExplore } from "./commands/explore.js";
import { runReport } from "./commands/report.js";
import { runScan } from "./commands/scan.js";
import { runSnapshots } from "./commands/snapshots.js";
import { runTimer } from "./commands/timer.js";

/**
 * Answer what the command table alone can answer: help, the version, and a
 * command line that does not parse. Returns undefined when a command has to
 * run. Nothing here reads configuration or touches a device.
 *
 * A refused command line with `--json` is still one error envelope on stdout,
 * because a script that asked for JSON reads stdout and nothing else; without
 * `--json` the reason goes to stderr and stdout stays empty.
 */
export function answerFromCommandTable(
  args: readonly string[],
  output: CliOutput,
  version: string,
  now: Date,
): number | undefined {
  const result = parseArguments(args);
  if (result.kind === "version") {
    output.stdout(`${version}\n`);
    return EXIT.complete;
  }
  if (result.kind === "help") {
    output.stdout(renderHelp(result.command));
    return EXIT.complete;
  }
  if (result.kind === "error") {
    // The message quotes what was typed, and what was typed can be a filename
    // pasted from somewhere else; it is printed the way any other name is.
    const message = sanitizeText(result.message);
    if (args.includes("--json")) {
      writeEnvelope(
        output.stdout,
        buildEnvelope({
          command: "disktop",
          generatedAt: now,
          status: "error",
          exitCode: EXIT.operationalError,
          warnings: [],
          failure: { code: "invalid-input", message },
        }),
      );
    } else {
      output.stderr(`${message}\n`);
    }
    return EXIT.operationalError;
  }
  return undefined;
}

/** Resolve one argument list to an exit status. Nothing here touches a device. */
export async function runCli(args: readonly string[], context: CliContext): Promise<number> {
  const answered = answerFromCommandTable(args, context.output, context.version, context.now());
  if (answered !== undefined) {
    return answered;
  }
  const result = parseArguments(args);
  if (result.kind !== "command") {
    return EXIT.operationalError;
  }

  const { parsed } = result;
  const asJson = parsed.flags.has("json");
  const withUnits = applyUnits(context, parsed);

  if (!parsed.command.implemented) {
    return notImplemented(withUnits, parsed.command, asJson);
  }

  const name = parsed.command.path.join(" ");
  const accounting = parsed.values.get("accounting") as "allocated" | "apparent" | undefined;
  if (name === "devices") {
    return runDevices(withUnits, asJson);
  }
  if (name === "scan") {
    return runScan(withUnits, {
      asJson,
      ...(parsed.operand === undefined ? {} : { path: parsed.operand }),
      ...(accounting === undefined ? {} : { accounting }),
      crossFilesystems: parsed.flags.has("cross-filesystems"),
      ...(optional(parsed, "throttle")),
      ...(optional(parsed, "max-depth", "maxDepth")),
    });
  }
  if (name === "explore") {
    return runExplore(withUnits, {
      asJson,
      ...(parsed.operand === undefined ? {} : { path: parsed.operand }),
      ...(optional(parsed, "sort")),
      ...(optional(parsed, "order")),
      ...(optional(parsed, "kind")),
      ...(optional(parsed, "min-size", "minSize")),
      ...(optional(parsed, "max-size", "maxSize")),
      ...(optional(parsed, "ext", "extension")),
      ...(optional(parsed, "name")),
      ...(optional(parsed, "older-than", "olderThanDays")),
      ...(optional(parsed, "limit")),
      ...(optional(parsed, "cursor")),
      typeTotals: parsed.flags.has("type-totals"),
      owners: parsed.flags.has("owners"),
    } as Parameters<typeof runExplore>[1]);
  }
  if (name === "clean") {
    return runClean(withUnits, {
      asJson,
      ...(optional(parsed, "category")),
      ...(optional(parsed, "limit")),
      measureSizes: !parsed.flags.has("no-sizes"),
    });
  }
  if (name === "clean plan") {
    return runPlan(withUnits, {
      asJson,
      ...(parsed.operand === undefined ? {} : { findingId: parsed.operand }),
      ...(optional(parsed, "path")),
      ...(optional(parsed, "operation")),
      ...(optional(parsed, "destination")),
      ...(optional(parsed, "keep-path", "keepPath")),
      ...(optional(parsed, "replace", "replacePath")),
      ...(optional(parsed, "source")),
    });
  }
  if (name === "clean apply") {
    return runApply(withUnits, {
      asJson,
      planId: parsed.operand ?? "",
      confirmed: parsed.flags.has("yes"),
      acknowledgePermanent: parsed.flags.has("permanent"),
    });
  }
  if (name === "history") {
    return runHistory(withUnits, {
      asJson,
      ...(optional(parsed, "cursor")),
      ...(optional(parsed, "limit")),
    });
  }
  if (name === "undo") {
    return runUndo(withUnits, {
      asJson,
      actionId: parsed.operand ?? "",
      confirmed: parsed.flags.has("yes"),
    });
  }
  if (name === "find") {
    return runFind(withUnits, {
      asJson,
      kind: parsed.operand ?? "",
      ...(optional(parsed, "path")),
      ...(optional(parsed, "limit")),
      ...(optional(parsed, "keep")),
      ...(optional(parsed, "keep-under", "keepUnder")),
      ...(optional(parsed, "min-size", "minSize")),
      ...(optional(parsed, "older-than", "olderThan")),
    });
  }
  if (name === "snapshots") {
    return runSnapshots(withUnits, {
      asJson,
      action: parsed.operand ?? "list",
      ...(optional(parsed, "from")),
      ...(optional(parsed, "to")),
    });
  }
  if (name === "timer") {
    return runTimer(withUnits, { asJson, action: parsed.operand ?? "" });
  }
  if (name === "report") {
    return runReport(withUnits, {
      asJson,
      ...(optional(parsed, "format")),
      ...(optional(parsed, "output")),
      ...(optional(parsed, "path")),
      ...(optional(parsed, "limit")),
      findings: parsed.flags.has("findings"),
    });
  }
  if (name === "completion") {
    return runCompletion(withUnits, parsed.operand ?? "");
  }
  if (name === "alerts check") {
    const threshold = parseThreshold(parsed.values.get("threshold"));
    if (threshold === "invalid") {
      withUnits.output.stderr("'--threshold' accepts a whole percentage from 0 to 100.\n");
      return EXIT.operationalError;
    }
    return runAlertsCheck(withUnits, {
      asJson,
      notify: parsed.flags.has("notify"),
      ...(threshold === undefined ? {} : { thresholdPercent: threshold }),
    });
  }

  // The root command: JSON or a redirected stdout means no interactive surface.
  if (asJson || !withUnits.interactive) {
    return runDashboard(withUnits, asJson);
  }
  return withUnits.launchTui(withUnits.settings);
}

/** Copy an option through only when it was given, so no default is invented. */
function optional(parsed: ParsedCommand, option: string, field = option): Record<string, string> {
  const value = parsed.values.get(option);
  return value === undefined ? {} : { [field]: value };
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
