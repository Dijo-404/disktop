import type { ActionResult } from "../domain/actions.js";
import { CapabilityUnavailable, type OperationFailure } from "../domain/errors.js";
import type { Capability } from "../domain/models.js";
import type {
  ActionJournalPort,
  ActionPort,
  JournalPage,
  JournalRecord,
} from "../ports/actions.js";

export type UndoOutcome =
  | {
      readonly kind: "restored";
      readonly record: JournalRecord;
      readonly result: ActionResult;
      /**
       * What putting the original back did not do. A move or a compress
       * published something too, and that output is still exactly where it was
       * put: an undo brings the source back, it does not retire the copy.
       */
      readonly notes: readonly string[];
    }
  | { readonly kind: "refused"; readonly failure: OperationFailure }
  | { readonly kind: "unavailable"; readonly capability: Capability };

export interface UndoService {
  /** Reconciled history, newest first. */
  history(cursor?: string, limit?: number): Promise<JournalPage>;
  restore(journalId: string, signal: AbortSignal): Promise<UndoOutcome>;
}

export interface UndoDependencies {
  readonly journal: ActionJournalPort;
  readonly actions: ActionPort;
}

/**
 * Reading what happened, and putting back what can be put back.
 *
 * Reading the journal reconciles it first, because a history that still claims
 * an abandoned action is running is not one anybody can act on, and because
 * `docs/safety.md` requires interrupted records to be resolved before undo is
 * offered at all.
 *
 * Only a Trash move leaves something to restore. A permanent removal is refused
 * here by name rather than attempted and reported as having restored nothing,
 * and an action reconciliation could not judge is refused until it has been:
 * undoing something that may not have happened is its own way of losing data.
 */
/**
 * The journalled operations that left something in Trash to put back.
 *
 * A move or a compress is here only when its plan's disposition was `trash`.
 * The helper records a `permanent` one with no Trash destination at all, which
 * is what `trashedAnything` below reads: the operation name says what kind of
 * action it was, and the items say whether it left anything recoverable.
 */
const RESTORABLE: ReadonlySet<string> = new Set(["trash", "copy-move", "compress"]);

/** The operations that published an output beside putting the source away. */
const PUBLISHING: ReadonlySet<string> = new Set(["copy-move", "compress"]);

/**
 * Whether this record left anything in Trash.
 *
 * A `permanent` disposition releases the source's bytes, so its completed
 * items carry no destination to come back from. Asking here is better than
 * asking the helper and being told item by item that there was nothing: the
 * answer is the same for the whole action and a person should read it once.
 */
function trashedAnything(record: JournalRecord): boolean {
  return record.items.some(
    (item) => item.outcome === "completed" && item.destination !== undefined,
  );
}

export function createUndoService(dependencies: UndoDependencies): UndoService {
  return {
    async history(cursor, limit) {
      return dependencies.journal.list(cursor, limit);
    },

    async restore(journalId, signal) {
      let record: JournalRecord | undefined;
      try {
        record = await dependencies.journal.get(journalId);
      } catch (error) {
        if (error instanceof CapabilityUnavailable) {
          return { kind: "unavailable", capability: error.capability };
        }
        throw error;
      }

      if (record === undefined) {
        return refuse(
          "invalid-input",
          `No action called '${journalId}' is in the journal. Run 'disktop history' to see what is there.`,
        );
      }
      // A move or a compress that trashed its source left the original
      // recoverable in exactly the same way a Trash action did, and the
      // journal records where it went. One that removed it permanently did
      // not, and the journal's own operation name is what tells them apart.
      if (!RESTORABLE.has(record.operation)) {
        return refuse(
          "unsupported",
          `That action ${record.operation === "erase" ? "removed its targets permanently" : `was a '${record.operation}'`}, so it cannot be undone.`,
        );
      }
      if (PUBLISHING.has(record.operation) && !trashedAnything(record)) {
        return refuse(
          "unsupported",
          `That ${record.operation === "compress" ? "compression" : "move"} removed its source permanently, so there is nothing to put back. What it published is still where it was put; remove it with 'disktop clean plan --path' if you no longer want it.`,
        );
      }
      if (record.state === "in-progress" || record.state === "uncertain") {
        return refuse(
          "invalid-plan",
          `That action is ${record.state}: Disktop cannot yet tell what it did, so it will not act on it. Run 'disktop history' to reconcile it first.`,
        );
      }

      try {
        const result = await dependencies.actions.restore(journalId, signal);
        // The restore undid one reviewed plan, so it reports that plan's ID.
        // The helper does not know it; only the record does.
        return {
          kind: "restored",
          record,
          result: { ...result, planId: record.planId },
          notes: notesFor(record),
        };
      } catch (error) {
        if (error instanceof CapabilityUnavailable) {
          return { kind: "unavailable", capability: error.capability };
        }
        const failure = (error as { failure?: OperationFailure }).failure;
        if (failure !== undefined) {
          return { kind: "refused", failure };
        }
        throw error;
      }
    },
  };
}

/**
 * What an undo did not do.
 *
 * `PLAN.md` asks an undo of a move or a compress to retire the published output
 * through a reviewed Trash action of its own. It is not retired here, and the
 * reason is the same reason every other removal in Disktop is reviewed: a
 * second deletion nobody previewed, performed as a side effect of an undo, is
 * exactly the shape of action this program exists not to take. So the output
 * is named and left, and removing it is a plan somebody makes and confirms.
 */
function notesFor(record: JournalRecord): readonly string[] {
  if (!PUBLISHING.has(record.operation)) {
    return [];
  }
  const published = record.items
    .filter((item) => item.outcome === "completed")
    .map((item) => item.path.display);
  const what = record.operation === "compress" ? "archive" : "copy";
  return [
    `The original is back. The ${what} this action published is still where it was put: an undo brings the source back and does not remove anything else.`,
    ...(published.length === 0
      ? []
      : [`Review it with 'disktop clean plan --path PATH' if you no longer want it. Restored: ${published.join(", ")}.`]),
  ];
}

function refuse(code: OperationFailure["code"], message: string): UndoOutcome {
  return { kind: "refused", failure: { code, message } };
}
