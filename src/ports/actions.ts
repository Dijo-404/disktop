import type { ActionPlan, ActionResult, SubtreeManifest } from "../domain/actions.js";
import type { Bytes, RawPath } from "../domain/models.js";

/**
 * Carrying out a reviewed plan.
 *
 * Both calls are terminal: they return what happened, including what they
 * refused to do. Neither takes a path, because neither decides what to act on
 * — the plan and the journal already did.
 */
export interface ActionPort {
  apply(plan: ActionPlan, signal: AbortSignal): Promise<ActionResult>;
  /** Put back what one Trash action moved, identified by its journal record. */
  restore(journalId: string, signal: AbortSignal): Promise<ActionResult>;
}

export type InspectOutcome =
  | { readonly kind: "inspected"; readonly subtree: SubtreeManifest }
  | { readonly kind: "refused"; readonly code: string; readonly message: string };

/** What is inside reviewed directories, keyed by each path's `bytesBase64`. */
export interface InspectPort {
  inspect(paths: readonly RawPath[], signal: AbortSignal): Promise<ReadonlyMap<string, InspectOutcome>>;
}

export type ItemOutcome = "in-progress" | "completed" | "skipped" | "failed" | "uncertain";

export interface JournalItem {
  readonly path: RawPath;
  /** Where a move put it. This is what an undo reads to find the file again. */
  readonly destination?: RawPath;
  readonly outcome: ItemOutcome;
  readonly message?: string;
  readonly bytes: Bytes;
}

export interface JournalRecord {
  readonly id: string;
  readonly planId: string;
  readonly operation: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  /**
   * `uncertain` is what an interrupted action reads as once reconciliation has
   * looked at it and could not tell whether its last item happened. It is never
   * promoted to `complete`.
   */
  readonly state: "in-progress" | "complete" | "partial" | "uncertain";
  readonly completed: bigint;
  readonly skipped: bigint;
  readonly failed: bigint;
  readonly selectedBytes: Bytes;
  readonly bytesMovedToTrash: Bytes;
  readonly freeBytesBefore?: Bytes;
  readonly freeBytesAfter?: Bytes;
  readonly items: readonly JournalItem[];
}

export interface JournalPage {
  readonly records: readonly JournalRecord[];
  readonly nextCursor?: string;
  /** How many interrupted records this reading resolved. */
  readonly reconciled: bigint;
}

/**
 * Read-only; the Rust helper is the sole durable journal writer.
 *
 * Reading resolves interrupted records as it goes, because a history that still
 * claims an abandoned action is running is not a history anybody can act on.
 */
export interface ActionJournalPort {
  list(cursor?: string, limit?: number): Promise<JournalPage>;
  get(id: string): Promise<JournalRecord | undefined>;
}

/** Where reviewed plans live between `clean plan` and `clean apply`. */
export interface PlanStore {
  save(plan: ActionPlan): Promise<void>;
  get(id: string): Promise<ActionPlan | undefined>;
  list(): Promise<readonly ActionPlan[]>;
  /** Drop the plans that have expired. Returns how many went. */
  prune(now: Date): Promise<number>;
}
