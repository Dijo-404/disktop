import { sanitizeText } from "../../domain/paths.js";
import type { CliContext } from "../context.js";
import { EXIT, buildEnvelope, encodeDirectoryChange, encodeSnapshot, writeEnvelope } from "../output.js";
import { diffLines, snapshotLines } from "../text.js";

export interface SnapshotsOptions {
  readonly asJson: boolean;
  readonly action: string;
  readonly from?: string;
  readonly to?: string;
}

/**
 * List saved snapshots, or compare two of them.
 *
 * A comparison between scans of different scope is refused rather than shown:
 * subtracting a scan that excluded a directory from one that did not produces
 * a number that reads exactly like real growth.
 */
export async function runSnapshots(context: CliContext, options: SnapshotsOptions): Promise<number> {
  if (options.action === "list") {
    return list(context, options.asJson);
  }
  if (options.action === "diff") {
    return diff(context, options);
  }
  return refuse(
    context,
    options.asJson,
    "snapshots",
    "invalid-input",
    `'disktop snapshots' takes 'list' or 'diff', not '${options.action}'.`,
  );
}

async function list(context: CliContext, asJson: boolean): Promise<number> {
  const snapshots = await context.storage.snapshots.list();

  if (asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: "snapshots list",
        generatedAt: context.now(),
        status: "complete",
        exitCode: EXIT.complete,
        warnings: [],
        data: { snapshots: snapshots.map(encodeSnapshot) },
      }),
    );
    return EXIT.complete;
  }

  for (const line of snapshotLines(snapshots, context.settings.units)) {
    context.output.stdout(`${line}\n`);
  }
  return EXIT.complete;
}

async function diff(context: CliContext, options: SnapshotsOptions): Promise<number> {
  const snapshots = await context.storage.snapshots.list();
  // With nothing named, compare the two most recent: the question people ask
  // is almost always "what changed since last time?".
  const later = options.to ?? snapshots[0]?.id;
  const earlier = options.from ?? snapshots[1]?.id;
  if (earlier === undefined || later === undefined) {
    return refuse(
      context,
      options.asJson,
      "snapshots diff",
      "invalid-input",
      "Comparing growth needs two saved snapshots. Run 'disktop scan' again to record another.",
    );
  }

  const outcome = await context.storage.snapshots.diff(earlier, later);

  if (outcome.kind === "missing") {
    return refuse(context, options.asJson, "snapshots diff", "invalid-input", `No snapshot named '${outcome.id}' is stored.`);
  }
  if (outcome.kind === "incomparable") {
    return refuse(
      context,
      options.asJson,
      "snapshots diff",
      "invalid-input",
      `Those two scans did not measure the same thing, so comparing them would invent growth. ${outcome.reasons.join(" ")}`,
    );
  }

  const found = outcome.diff;
  if (options.asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: "snapshots diff",
        generatedAt: context.now(),
        status: "complete",
        exitCode: EXIT.complete,
        warnings: [],
        data: {
          earlier: encodeSnapshot(found.earlier),
          later: encodeSnapshot(found.later),
          totalDeltaBytes: found.totalDeltaBytes.toString(10),
          directories: found.directories.map(encodeDirectoryChange),
          uncertain: found.uncertain,
          ...(found.uncertain ? { uncertainty: [...found.uncertainty] } : {}),
        },
      }),
    );
    return EXIT.complete;
  }

  for (const line of diffLines(found, context.settings.units)) {
    context.output.stdout(`${line}\n`);
  }
  for (const note of found.uncertainty) {
    context.output.stderr(`${note}\n`);
  }
  return EXIT.complete;
}

function refuse(
  context: CliContext,
  asJson: boolean,
  command: string,
  code: "invalid-input",
  message: string,
): number {
  if (asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command,
        generatedAt: context.now(),
        status: "error",
        exitCode: EXIT.operationalError,
        warnings: [],
        failure: { code, message },
      }),
    );
  } else {
    context.output.stderr(`${sanitizeText(message)}\n`);
  }
  return EXIT.operationalError;
}
