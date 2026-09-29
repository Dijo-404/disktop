import type { ActionPlan, ActionResult } from "../domain/actions.js";

export interface ActionPort {
  apply(plan: ActionPlan, signal: AbortSignal): Promise<ActionResult>;
  restore(journalId: string, signal: AbortSignal): Promise<ActionResult>;
}

export interface JournalRecord {
  readonly id: string;
  readonly planId: string;
  readonly operation: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly state: "in-progress" | "complete" | "partial" | "uncertain";
}

/** Read-only; the Rust helper is the sole durable journal writer. */
export interface ActionJournalPort {
  list(cursor?: string): Promise<{ readonly records: readonly JournalRecord[]; readonly nextCursor?: string }>;
  get(id: string): Promise<JournalRecord | undefined>;
}
