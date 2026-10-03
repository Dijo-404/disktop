import type { RawPath } from "../../domain/models.js";
import { rawPathFromUtf8 } from "../../domain/paths.js";
import { parseSize } from "../../application/explore.js";
import { orderedWarnings } from "../../application/scan.js";
import type { CliContext } from "../context.js";
import { exitAfter, interruptible } from "../interrupt.js";
import { EXIT, buildEnvelope, encodeCapability, encodeCompleteness, encodeRawPath, encodeScanTotals, writeEnvelope } from "../output.js";
import { scanLines, warningLines } from "../text.js";

export interface ScanOptions {
  readonly asJson: boolean;
  readonly path?: string;
  readonly accounting?: "allocated" | "apparent";
  readonly crossFilesystems: boolean;
  readonly throttle?: string;
  readonly maxDepth?: string;
}

const AVAILABLE = { status: "available", explanation: "The helper scanned the requested root." } as const;

/**
 * Scan one root, index it, and save a snapshot.
 *
 * Interrupting stops the walk at a directory boundary and still reports what
 * was measured, marked incomplete, with the reason. Nothing here decides that
 * an unreadable subtree held nothing.
 */
export async function runScan(context: CliContext, options: ScanOptions): Promise<number> {
  const root = resolveRoot(context, options.path);
  const throttle = options.throttle === undefined ? undefined : parseSize(options.throttle);
  if (options.throttle !== undefined && throttle === undefined) {
    return refuse(context, options.asJson, "'--throttle' accepts a byte rate such as 50MiB or 52428800.");
  }
  const maxDepth = options.maxDepth === undefined ? undefined : parsePositive(options.maxDepth);
  if (options.maxDepth !== undefined && maxDepth === undefined) {
    return refuse(context, options.asJson, "'--max-depth' accepts a whole number of levels.");
  }

  const drawProgress = !options.asJson && context.interactive;
  let interrupted: boolean;
  let outcome;
  try {
    ({ value: outcome, interrupted } = await interruptible(context, (signal) =>
      context.storage.scan.run(
        [root],
        {
          ...(options.accounting === undefined ? {} : { accounting: options.accounting }),
          ...(options.crossFilesystems ? { crossFilesystems: true } : {}),
          ...(throttle === undefined ? {} : { throttleBytesPerSecond: throttle }),
          ...(maxDepth === undefined ? {} : { maxDepth }),
        },
        signal,
        (progress) => {
          if (drawProgress) {
            context.output.stderr(`\rScanned ${progress.scannedEntries} entries...`);
          }
        },
      ),
    ));
  } finally {
    if (drawProgress) {
      context.output.stderr("\r\u001b[K");
    }
  }

  if (outcome.kind === "unavailable") {
    const message = `Disktop cannot scan on this machine: ${outcome.capability.explanation}`;
    if (options.asJson) {
      writeEnvelope(
        context.output.stdout,
        buildEnvelope({
          command: "scan",
          generatedAt: context.now(),
          status: "error",
          exitCode: EXIT.operationalError,
          warnings: [],
          failure: { code: "unsupported", message, details: { capability: outcome.capability.status } },
        }),
      );
    } else {
      context.output.stderr(`${message}\n`);
    }
    return EXIT.operationalError;
  }

  const summary = outcome.summary;
  // The scope the snapshot records comes from the scan itself: what it read,
  // how deep it went, and which filesystems it touched. Deriving any of that
  // from the roots would let two scans of different scope compare as if they
  // had measured the same thing.
  const snapshot = await context.storage.snapshots.record(
    summary,
    { excludes: context.storage.defaults.excludes },
    context.now(),
  );
  const pruned = await context.storage.snapshots.prune(context.storage.defaults.retention);

  const cancelled = summary.completeness.warnings.some((warning) => warning.code === "cancelled");
  const status = summary.completeness.complete ? "complete" : "incomplete";
  const exitCode = summary.completeness.complete
    ? EXIT.complete
    : exitAfter(interrupted || cancelled, EXIT.incomplete);

  if (options.asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: "scan",
        generatedAt: context.now(),
        status,
        exitCode,
        warnings: orderedWarnings(summary.completeness),
        data: {
          capability: encodeCapability(AVAILABLE),
          scanId: summary.scanId,
          snapshotId: snapshot.id,
          accounting: summary.accounting,
          roots: summary.roots.map(encodeRawPath),
          totals: encodeScanTotals(summary.totals),
          completeness: encodeCompleteness(summary.completeness),
          prunedSnapshots: String(pruned),
        },
      }),
    );
    return exitCode;
  }

  for (const line of scanLines(summary, snapshot.id, context.settings.units)) {
    context.output.stdout(`${line}\n`);
  }
  for (const line of warningLines(orderedWarnings(summary.completeness))) {
    context.output.stderr(`${line}\n`);
  }
  return exitCode;
}

/** A scan with no path given covers the working directory, the way `du` does. */
export function resolveRoot(context: CliContext, path: string | undefined): RawPath {
  return rawPathFromUtf8(context.resolvePath(path ?? "."));
}

function parsePositive(value: string): bigint | undefined {
  return /^[1-9][0-9]*$/.test(value) ? BigInt(value) : undefined;
}

function refuse(context: CliContext, asJson: boolean, message: string): number {
  if (asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: "scan",
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
