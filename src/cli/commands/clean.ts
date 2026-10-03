import type { FootprintRequest } from "../../application/footprint.js";
import { FINDING_CATEGORIES, type FindingCategory } from "../../domain/findings.js";
import type { CliContext } from "../context.js";
import { exitAfter, interruptible } from "../interrupt.js";
import {
  EXIT,
  buildEnvelope,
  encodeCapability,
  encodeCategoryTotal,
  encodeFinding,
  encodeProviderReport,
  writeEnvelope,
} from "../output.js";
import { findingLines, providerLines, warningLines } from "../text.js";

export interface CleanOptions {
  readonly asJson: boolean;
  readonly category?: string;
  readonly limit?: string;
  readonly measureSizes: boolean;
}

/**
 * Everything the detectors found, with nothing applied.
 *
 * Listing is the whole command in this phase: there is no path from here to a
 * deletion, and `clean plan` and `clean apply` still refuse. The result names
 * every detector that ran, including the ones that could not look, so a short
 * list is never read as a clean machine.
 */
export async function runClean(context: CliContext, options: CleanOptions): Promise<number> {
  const categories = parseCategories(options.category);
  if (categories === "invalid") {
    return refuse(
      context,
      options.asJson,
      `'--category' accepts one of ${FINDING_CATEGORIES.join(", ")}.`,
    );
  }
  if (options.limit !== undefined && !isBoundedLimit(options.limit)) {
    return refuse(context, options.asJson, "'--limit' accepts a whole number of findings from 1 to 1000.");
  }

  const request: FootprintRequest = {
    measureSizes: options.measureSizes,
    ...(categories === undefined ? {} : { categories }),
  };

  const { value: summary, interrupted } = await interruptible(context, (signal) =>
    context.footprint.discover(request, signal),
  );

  const limit = options.limit === undefined ? summary.findings.length : Number(options.limit);
  const listed = summary.findings.slice(0, limit);
  const truncated = listed.length < summary.findings.length;
  // A configuration that could not be applied belongs at the top of this
  // list: somebody whose own cleanup rules were dropped is reading a listing
  // that is missing exactly the thing they wrote.
  const warnings = [
    ...context.startupWarnings,
    ...summary.warnings,
    ...(truncated
      ? [
          {
            code: "findings-truncated",
            message: `${summary.findings.length} findings were discovered; --limit showed the first ${listed.length}.`,
          },
        ]
      : []),
  ];

  const complete = summary.complete && !truncated && context.startupWarnings.length === 0;
  const exitCode = exitAfter(interrupted, complete ? EXIT.complete : EXIT.incomplete);

  if (options.asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: "clean",
        generatedAt: context.now(),
        status: complete ? "complete" : "incomplete",
        exitCode,
        warnings,
        data: {
          capability: encodeCapability(summary.capability),
          measured: summary.measured,
          findings: listed.map(encodeFinding),
          providers: summary.providers.map(encodeProviderReport),
          categoryTotals: summary.categoryTotals.map(encodeCategoryTotal),
        },
      }),
    );
    return exitCode;
  }

  for (const line of findingLines({ ...summary, findings: listed }, context.settings.units)) {
    context.output.stdout(`${line}\n`);
  }
  for (const line of providerLines(summary.providers)) {
    context.output.stderr(`${line}\n`);
  }
  for (const line of warningLines(warnings)) {
    context.output.stderr(`${line}\n`);
  }
  return exitCode;
}

/** 1 to 1000, which is what the option's own message promises. */
function isBoundedLimit(limit: string): boolean {
  return /^[1-9][0-9]{0,3}$/.test(limit) && Number(limit) <= 1000;
}

function parseCategories(category: string | undefined): readonly FindingCategory[] | undefined | "invalid" {
  if (category === undefined) {
    return undefined;
  }
  if (!FINDING_CATEGORIES.includes(category as FindingCategory)) {
    return "invalid";
  }
  return [category as FindingCategory];
}

function refuse(context: CliContext, asJson: boolean, message: string): number {
  if (asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: "clean",
        generatedAt: context.now(),
        status: "error",
        exitCode: EXIT.operationalError,
        warnings: [],
        failure: { code: "invalid-input", message },
      }),
    );
  } else {
    context.output.stderr(`${message}\n`);
  }
  return EXIT.operationalError;
}
