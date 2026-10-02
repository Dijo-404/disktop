import type { ActionOperation } from "../../domain/actions.js";
import { KEEP_RULES, type KeepRule } from "../../domain/duplicates.js";
import type { OperationFailure } from "../../domain/errors.js";
import type { IndexedEntry, ScanCompleteness, Warning } from "../../domain/models.js";
import { rawPathFromUtf8 } from "../../domain/paths.js";
import type { DuplicateOutcome } from "../../application/duplicates.js";
import { parseSize } from "../../application/explore.js";
import {
  staleBeforeNanoseconds as staleBeforeNanoseconds_,
  type StalenessBasis,
} from "../../domain/staleness.js";
import { FIND_KINDS, type FindKind } from "../../application/find.js";
import type { CliContext } from "../context.js";
import {
  EXIT,
  buildEnvelope,
  encodeActionPlan,
  encodeActionResult,
  encodeIndexedEntry,
  encodeJournalRecord,
  encodeRawPath,
  writeEnvelope,
} from "../output.js";
import {
  duplicateLines,
  entryLines,
  planLines,
  resultLines,
  historyLines,
  warningLines,
} from "../text.js";
import { newestCovering } from "./explore.js";

export interface PlanOptions {
  readonly asJson: boolean;
  readonly findingId?: string;
  readonly path?: string;
  readonly operation?: string;
}

export interface ApplyOptions {
  readonly asJson: boolean;
  readonly planId: string;
  readonly confirmed: boolean;
  readonly acknowledgePermanent: boolean;
}

export interface UndoOptions {
  readonly asJson: boolean;
  readonly actionId: string;
  readonly confirmed: boolean;
}

export interface FindOptions {
  readonly asJson: boolean;
  readonly kind: string;
  readonly path?: string;
  readonly limit?: string;
  readonly keep?: string;
  readonly keepUnder?: string;
  readonly minSize?: string;
  readonly olderThan?: string;
}

/** The operations `clean plan` can fix today. The rest belong to later phases. */
const PLANNABLE: readonly ActionOperation[] = ["trash", "permanent", "empty-trash"];

/**
 * Review one finding or path into a stored plan. Nothing changes on disk here;
 * a plan is a description that `clean apply` may later act on.
 */
export async function runPlan(context: CliContext, options: PlanOptions): Promise<number> {
  const operation = (options.operation ?? "trash") as ActionOperation;
  // Emptying Trash needs no subject: Disktop already knows where Trash is.
  if (operation !== "empty-trash" && options.findingId === undefined && options.path === undefined) {
    return refuse(context, "clean plan", options.asJson, {
      code: "invalid-input",
      message: "'clean plan' needs a FINDING_ID, or --path with a path to review.",
    });
  }
  if (options.findingId !== undefined && options.path !== undefined) {
    return refuse(context, "clean plan", options.asJson, {
      code: "invalid-input",
      message: "'clean plan' takes a FINDING_ID or --path, not both.",
    });
  }

  if (!PLANNABLE.includes(operation)) {
    return refuse(context, "clean plan", options.asJson, {
      code: "not-implemented",
      message: `'--operation ${operation}' is declared but not implemented yet. ${PLANNABLE.join(", ")} work today.`,
    });
  }

  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  context.signals.listen(interrupt);
  let outcome;
  try {
    outcome = await context.actions.plan(
      {
        operation,
        ...(options.findingId === undefined ? {} : { findingId: options.findingId }),
        ...(options.path === undefined
          ? {}
          : { path: rawPathFromUtf8(context.resolvePath(options.path)) }),
      },
      controller.signal,
    );
  } finally {
    context.signals.stop(interrupt);
  }

  if (outcome.kind === "refused") {
    return refuse(context, "clean plan", options.asJson, outcome.failure);
  }

  if (options.asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: "clean plan",
        generatedAt: context.now(),
        status: "complete",
        exitCode: EXIT.complete,
        warnings: [],
        data: { plan: encodeActionPlan(outcome.plan) },
      }),
    );
    return EXIT.complete;
  }

  for (const line of planLines(outcome.plan, context.settings.units)) {
    context.output.stdout(`${line}\n`);
  }
  return EXIT.complete;
}

/**
 * Carry out one already-reviewed plan.
 *
 * `--yes` is the confirmation and nothing else: it does not skip planning, and
 * it cannot stand in for the acknowledgement an irreversible plan needs.
 */
export async function runApply(context: CliContext, options: ApplyOptions): Promise<number> {
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  context.signals.listen(interrupt);
  let outcome;
  try {
    outcome = await context.actions.apply(
      {
        planId: options.planId,
        confirmed: options.confirmed,
        acknowledgePermanent: options.acknowledgePermanent,
      },
      controller.signal,
    );
  } finally {
    context.signals.stop(interrupt);
  }

  if (outcome.kind === "refused") {
    return refuse(context, "clean apply", options.asJson, outcome.failure);
  }
  if (outcome.kind === "unavailable") {
    return refuse(context, "clean apply", options.asJson, {
      code: "unsupported",
      message: `Disktop cannot change files on this machine: ${outcome.capability.explanation}`,
    });
  }

  // An action that skipped or failed anything did not do what was reviewed, and
  // the exit status has to say so to a script that is not reading the JSON.
  const complete = outcome.result.state === "complete";
  const warnings: Warning[] = complete
    ? []
    : [
        {
          code: "action-incomplete",
          message: `${outcome.result.skipped} item(s) were skipped and ${outcome.result.failed} failed. Run 'disktop history' for the record.`,
        },
      ];

  const exitCode = complete ? EXIT.complete : EXIT.incomplete;
  if (options.asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: "clean apply",
        generatedAt: context.now(),
        status: complete ? "complete" : "incomplete",
        exitCode,
        warnings,
        data: {
          plan: encodeActionPlan(outcome.plan),
          result: encodeActionResult(
            outcome.result,
            outcome.observedFreeSpaceChange,
            outcome.notes,
          ),
        },
      }),
    );
    return exitCode;
  }

  for (const line of resultLines(
    outcome.result,
    outcome.observedFreeSpaceChange,
    outcome.notes,
    context.settings.units,
  )) {
    context.output.stdout(`${line}\n`);
  }
  for (const line of warningLines(warnings)) {
    context.output.stderr(`${line}\n`);
  }
  return exitCode;
}

/** The durable record of what was done, reconciled as it is read. */
export async function runHistory(context: CliContext, asJson: boolean): Promise<number> {
  const page = await context.actions.history();

  if (asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: "history",
        generatedAt: context.now(),
        status: "complete",
        exitCode: EXIT.complete,
        warnings: [],
        data: {
          records: page.records.map(encodeJournalRecord),
          reconciled: page.reconciled.toString(10),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        },
      }),
    );
    return EXIT.complete;
  }

  for (const line of historyLines(page.records, context.settings.units)) {
    context.output.stdout(`${line}\n`);
  }
  if (page.reconciled > 0n) {
    context.output.stderr(
      `${page.reconciled} interrupted action(s) were resolved while reading this history.\n`,
    );
  }
  return EXIT.complete;
}

/** Put back what one Trash action moved. */
export async function runUndo(context: CliContext, options: UndoOptions): Promise<number> {
  if (!options.confirmed) {
    return refuse(context, "undo", options.asJson, {
      code: "invalid-input",
      message: `Undoing ${options.actionId} needs --yes. Run 'disktop history' to see what it did.`,
    });
  }

  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  context.signals.listen(interrupt);
  let outcome;
  try {
    outcome = await context.actions.restore(options.actionId, controller.signal);
  } finally {
    context.signals.stop(interrupt);
  }

  if (outcome.kind === "refused") {
    return refuse(context, "undo", options.asJson, outcome.failure);
  }
  if (outcome.kind === "unavailable") {
    return refuse(context, "undo", options.asJson, {
      code: "unsupported",
      message: `Disktop cannot change files on this machine: ${outcome.capability.explanation}`,
    });
  }

  const complete = outcome.result.state === "complete";
  const exitCode = complete ? EXIT.complete : EXIT.incomplete;
  const warnings: Warning[] = complete
    ? []
    : [
        {
          code: "undo-incomplete",
          message: `${outcome.result.skipped} item(s) could not come back, usually because something else is at their original path now.`,
        },
      ];

  if (options.asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: "undo",
        generatedAt: context.now(),
        status: complete ? "complete" : "incomplete",
        exitCode,
        warnings,
        data: {
          record: encodeJournalRecord(outcome.record),
          result: encodeActionResult(outcome.result, undefined, []),
        },
      }),
    );
    return exitCode;
  }

  for (const line of resultLines(outcome.result, undefined, [], context.settings.units)) {
    context.output.stdout(`${line}\n`);
  }
  for (const line of warningLines(warnings)) {
    context.output.stderr(`${line}\n`);
  }
  return exitCode;
}

/**
 * Entries of one kind out of a stored scan. `find` never scans: if no stored
 * scan covers the path it says so and names the command that would make one.
 */
export async function runFind(context: CliContext, options: FindOptions): Promise<number> {
  if (!FIND_KINDS.includes(options.kind as FindKind)) {
    return refuse(context, "find", options.asJson, {
      code: "invalid-input",
      message: `'find' takes one of ${FIND_KINDS.join(", ")}, not '${options.kind}'.`,
    });
  }
  if (options.limit !== undefined && !/^[1-9][0-9]{0,3}$/.test(options.limit)) {
    return refuse(context, "find", options.asJson, {
      code: "invalid-input",
      message: "'--limit' accepts a whole number of entries from 1 to 1000.",
    });
  }

  const wanted = rawPathFromUtf8(context.resolvePath(options.path ?? "."));
  const scan = await newestCovering(context, wanted);
  if (scan === undefined) {
    return refuse(context, "find", options.asJson, {
      code: "invalid-input",
      message: `No stored scan covers ${wanted.display}. Run 'disktop scan ${wanted.display}' first.`,
    });
  }

  const rule = options.keep ?? "oldest";
  if (!KEEP_RULES.includes(rule as KeepRule)) {
    return refuse(context, "find", options.asJson, {
      code: "invalid-input",
      message: `'--keep' takes one of ${KEEP_RULES.join(", ")}, not '${rule}'.`,
    });
  }
  let minimumBytes: bigint | undefined;
  if (options.minSize !== undefined) {
    minimumBytes = parseSize(options.minSize);
    if (minimumBytes === undefined) {
      return refuse(context, "find", options.asJson, {
        code: "invalid-input",
        message: "'--min-size' accepts a size such as 1MiB or 4096.",
      });
    }
  }

  let staleBeforeNanoseconds: bigint | undefined;
  if (options.kind === "stale") {
    const days = options.olderThan ?? String(context.storage.find.staleAfterDays);
    if (!/^[1-9][0-9]{0,3}$/.test(days)) {
      return refuse(context, "find", options.asJson, {
        code: "invalid-input",
        message: "'--older-than' accepts a whole number of days from 1 to 9999.",
      });
    }
    staleBeforeNanoseconds = staleBeforeNanoseconds_(context.now(), Number(days));
  }

  const outcome = await context.actions.find({
    kind: options.kind as FindKind,
    scanId: scan.scanId,
    path: wanted,
    ...(options.limit === undefined ? {} : { limit: Number(options.limit) }),
    rule: rule as KeepRule,
    ...(options.keepUnder === undefined
      ? {}
      : { keepUnder: rawPathFromUtf8(context.resolvePath(options.keepUnder)) }),
    ...(minimumBytes === undefined ? {} : { minimumBytes }),
    ...(staleBeforeNanoseconds === undefined ? {} : { staleBeforeNanoseconds }),
  });

  if (outcome.kind === "refused") {
    return refuse(context, "find", options.asJson, outcome.failure);
  }
  if (outcome.kind === "unavailable") {
    return refuse(context, "find", options.asJson, {
      code: "unsupported",
      message: `Disktop cannot read the index on this machine: ${outcome.capability.explanation}`,
    });
  }
  if (outcome.kind === "duplicates") {
    return renderDuplicates(context, options, scan.scanId, scan.completeness, outcome.result);
  }
  if (outcome.kind === "stale") {
    return renderStale(context, options, scan.scanId, scan.completeness, outcome);
  }

  // A page of a partial scan is not a picture of the whole tree, and says so.
  const complete = scan.completeness.complete;
  const exitCode = complete ? EXIT.complete : EXIT.incomplete;
  const warnings = complete ? [] : scan.completeness.warnings;

  if (options.asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: "find",
        generatedAt: context.now(),
        status: complete ? "complete" : "incomplete",
        exitCode,
        warnings,
        data: {
          kind: options.kind,
          scanId: scan.scanId,
          entries: outcome.entries.map(encodeIndexedEntry),
          ...(outcome.nextCursor === undefined ? {} : { nextCursor: outcome.nextCursor }),
        },
      }),
    );
    return exitCode;
  }

  for (const line of entryLines(outcome.entries, context.settings.units, "allocated")) {
    context.output.stdout(`${line}\n`);
  }
  for (const line of warningLines(warnings)) {
    context.output.stderr(`${line}\n`);
  }
  return exitCode;
}

/**
 * A stale listing's answer.
 *
 * It carries the basis beside the entries, because the dates are only half the
 * answer: what makes them useful or misleading is what the mount holding them
 * does about access times, and a reader who is not told that will read "not
 * modified" as "not used".
 */
function renderStale(
  context: CliContext,
  options: FindOptions,
  scanId: string,
  completeness: ScanCompleteness,
  outcome: { readonly entries: readonly IndexedEntry[]; readonly nextCursor?: string; readonly basis: StalenessBasis },
): number {
  const complete = completeness.complete;
  const exitCode = complete ? EXIT.complete : EXIT.incomplete;
  const warnings = complete ? [] : completeness.warnings;

  if (options.asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: "find",
        generatedAt: context.now(),
        status: complete ? "complete" : "incomplete",
        exitCode,
        warnings,
        data: {
          kind: "stale",
          scanId,
          entries: outcome.entries.map(encodeIndexedEntry),
          ...(outcome.nextCursor === undefined ? {} : { nextCursor: outcome.nextCursor }),
          basis: {
            field: outcome.basis.field,
            confidence: outcome.basis.confidence,
            label: outcome.basis.label,
          },
        },
      }),
    );
    return exitCode;
  }

  context.output.stdout(`These files were ${outcome.basis.label}\n`);
  for (const line of entryLines(outcome.entries, context.settings.units, "allocated")) {
    context.output.stdout(`${line}\n`);
  }
  for (const line of warningLines(warnings)) {
    context.output.stderr(`${line}\n`);
  }
  return exitCode;
}

/**
 * A duplicate search's answer.
 *
 * It carries groups rather than a page of rows, so it has its own writer: a
 * flat list would lose which copy pairs with which, which is the only thing a
 * reader of this is actually deciding about.
 */
function renderDuplicates(
  context: CliContext,
  options: FindOptions,
  scanId: string,
  completeness: ScanCompleteness,
  result: DuplicateOutcome,
): number {
  if (result.kind === "refused") {
    return refuse(context, "find", options.asJson, result.failure);
  }
  if (result.kind === "unavailable") {
    return refuse(context, "find", options.asJson, {
      code: "unsupported",
      message: `Disktop cannot search for duplicates on this machine: ${result.capability.explanation}`,
    });
  }

  // Two things can make this answer partial and they are different facts: the
  // scan it reads from may have missed directories, and the search itself may
  // have hit a cap or an unreadable file. Either one means the listing is not
  // the whole picture, so both are reported and both set the exit status.
  const complete = completeness.complete && result.complete;
  const exitCode = complete ? EXIT.complete : EXIT.incomplete;
  const warnings = [...(completeness.complete ? [] : completeness.warnings), ...result.warnings];

  if (options.asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: "find",
        generatedAt: context.now(),
        status: complete ? "complete" : "incomplete",
        exitCode,
        warnings,
        data: {
          kind: "duplicates",
          scanId,
          groups: result.groups.map((decided) => ({
            apparentBytes: decided.group.apparentBytes.toString(10),
            digest: decided.group.digest,
            reclaimableBytes: decided.reclaimableBytes.toString(10),
            files: decided.group.files.map((file) => ({
              path: encodeRawPath(file.path),
              device: file.device.toString(10),
              inode: file.inode.toString(10),
              apparentBytes: file.apparentBytes.toString(10),
              modifiedNanoseconds: file.modifiedNanoseconds.toString(10),
              ownerId: file.ownerId.toString(10),
              groupId: file.groupId.toString(10),
              permissions: file.permissions,
            })),
            decision:
              decided.decision.kind === "decided"
                ? {
                    kind: "decided",
                    keep: encodeRawPath(decided.decision.kept.path),
                    basis: decided.decision.basis,
                    arbitrary: decided.decision.arbitrary,
                  }
                : { kind: "undecidable", reason: decided.decision.reason },
          })),
          reclaimableBytes: result.reclaimableBytes.toString(10),
          candidatesRead: result.candidatesRead.toString(10),
          filesHashed: result.filesHashed.toString(10),
        },
      }),
    );
    return exitCode;
  }

  for (const line of duplicateLines(result.groups, result.reclaimableBytes, context.settings.units)) {
    context.output.stdout(`${line}\n`);
  }
  for (const line of warningLines(warnings)) {
    context.output.stderr(`${line}\n`);
  }
  return exitCode;
}

function refuse(
  context: CliContext,
  command: string,
  asJson: boolean,
  failure: OperationFailure,
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
        failure,
      }),
    );
  } else {
    context.output.stderr(`${failure.message}\n`);
  }
  return EXIT.operationalError;
}
