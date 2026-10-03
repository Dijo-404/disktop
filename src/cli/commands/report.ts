import { DEFAULT_REPORT_ENTRIES, MAX_REPORT_ENTRIES, includedSections, reportWarnings, type Report } from "../../application/report.js";
import type { OperationFailure } from "../../domain/errors.js";
import { rawPathFromUtf8 } from "../../domain/paths.js";
import { renderCsvReport } from "../../reports/csv.js";
import { renderHtmlReport } from "../../reports/html.js";
import { renderJsonReport } from "../../reports/json.js";
import type { CliContext } from "../context.js";
import { EXIT, buildEnvelope, encodeRawPath, writeEnvelope } from "../output.js";
import { warningLines } from "../text.js";

export type ReportFormat = "json" | "csv" | "html";

export interface ReportOptions {
  readonly asJson: boolean;
  readonly format?: string;
  readonly output?: string;
  readonly path?: string;
  readonly limit?: string;
  readonly findings: boolean;
}

const FORMAT_NAMES: Readonly<Record<ReportFormat, string>> = { json: "JSON", csv: "CSV", html: "HTML" };

/**
 * Export what Disktop knows as one JSON, CSV, or HTML document.
 *
 * The report goes to stdout unless `--output` names a new file, which is
 * created whole or not at all and never replaces anything. With `--json`,
 * stdout carries the envelope describing what was written, so the report
 * itself has to go to a file: two documents on one stream is neither.
 */
export async function runReport(context: CliContext, options: ReportOptions): Promise<number> {
  const format = options.format;
  if (format !== "json" && format !== "csv" && format !== "html") {
    return refuse(context, options.asJson, {
      code: "invalid-input",
      message: "'report' needs --format json, csv, or html.",
    });
  }
  if (options.asJson && options.output === undefined) {
    return refuse(context, options.asJson, {
      code: "invalid-input",
      message:
        "With --json, standard output carries the result envelope, so the report needs --output FILE. Leave out --json to write the report itself to standard output.",
    });
  }
  if (options.limit !== undefined && !isBoundedLimit(options.limit)) {
    return refuse(context, options.asJson, {
      code: "invalid-input",
      message: `'--limit' accepts a whole number of entries from 1 to ${MAX_REPORT_ENTRIES}.`,
    });
  }

  const target = options.output === undefined ? undefined : rawPathFromUtf8(context.resolvePath(options.output));
  if (target !== undefined) {
    // Gathering findings can take minutes; finding out afterwards that the
    // name was taken would waste them. The write checks again regardless.
    const check = await context.report.check(target);
    if (check.kind === "refused") {
      return refuse(context, options.asJson, check.failure);
    }
  }

  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  context.signals.listen(interrupt);
  let outcome;
  try {
    outcome = await context.report.gather(
      {
        ...(options.path === undefined ? {} : { subject: rawPathFromUtf8(context.resolvePath(options.path)) }),
        limit: options.limit === undefined ? DEFAULT_REPORT_ENTRIES : Number(options.limit),
        findings: options.findings,
        generatedAt: context.now(),
        version: context.version,
      },
      controller.signal,
    );
  } finally {
    context.signals.stop(interrupt);
  }
  if (outcome.kind === "refused") {
    return refuse(context, options.asJson, outcome.failure);
  }

  const { report } = outcome;
  const text = render(format, report, context.settings.units);
  const warnings = reportWarnings(report);

  if (target === undefined) {
    context.output.stdout(text);
    for (const line of warningLines(warnings)) {
      context.output.stderr(`${line}\n`);
    }
    return report.complete ? EXIT.complete : EXIT.incomplete;
  }

  const written = await context.report.publish(target, Buffer.from(text, "utf8"));
  if (written.kind === "refused") {
    return refuse(context, options.asJson, written.failure);
  }

  const allWarnings = [...warnings, ...written.warnings];
  const complete = report.complete && written.warnings.length === 0;
  const exitCode = complete ? EXIT.complete : EXIT.incomplete;

  if (options.asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: "report",
        generatedAt: context.now(),
        status: complete ? "complete" : "incomplete",
        exitCode,
        warnings: allWarnings,
        data: {
          format,
          output: encodeRawPath(target),
          bytesWritten: written.bytesWritten.toString(10),
          sections: [...includedSections(report)],
        },
      }),
    );
    return exitCode;
  }

  context.output.stdout(
    `Wrote the ${FORMAT_NAMES[format]} report to ${target.display} (${written.bytesWritten} bytes, ${
      report.complete ? "complete" : "incomplete"
    }).\n`,
  );
  for (const line of warningLines(allWarnings)) {
    context.output.stderr(`${line}\n`);
  }
  return exitCode;
}

function render(format: ReportFormat, report: Report, units: "iec" | "si"): string {
  switch (format) {
    case "json":
      return renderJsonReport(report);
    case "csv":
      return renderCsvReport(report);
    default:
      return renderHtmlReport(report, units);
  }
}

/** 1 to 1000, which is what the option's own message promises. */
function isBoundedLimit(limit: string): boolean {
  return /^[1-9][0-9]{0,3}$/.test(limit) && Number(limit) <= MAX_REPORT_ENTRIES;
}

/** A refusal in the envelope shape, or on stderr; an interrupted report exits 130. */
function refuse(context: CliContext, asJson: boolean, failure: OperationFailure): number {
  const exitCode = failure.code === "cancelled" ? EXIT.interrupted : EXIT.operationalError;
  if (asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({ command: "report", generatedAt: context.now(), status: "error", exitCode, warnings: [], failure }),
    );
  } else {
    context.output.stderr(`${failure.message}\n`);
  }
  return exitCode;
}
