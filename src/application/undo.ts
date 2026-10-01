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
  | { readonly kind: "restored"; readonly record: JournalRecord; readonly result: ActionResult }
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
      if (record.operation !== "trash") {
        return refuse(
          "unsupported",
          `That action ${record.operation === "erase" ? "removed its targets permanently" : `was a '${record.operation}'`}, so it cannot be undone.`,
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
        return { kind: "restored", record, result };
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

function refuse(code: OperationFailure["code"], message: string): UndoOutcome {
  return { kind: "refused", failure: { code, message } };
}
