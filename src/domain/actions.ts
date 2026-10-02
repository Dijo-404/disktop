import type { Bytes, RawPath } from "./models.js";

/** Reviewed operations are fixed before an apply request is accepted. */
export type ActionOperation =
  | "trash"
  | "permanent"
  | "empty-trash"
  | "move"
  | "compress"
  | "dedup-hardlink"
  | "manager";

export interface EntryFingerprint {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mountId: string;
  readonly kind: "file" | "directory" | "symlink";
  readonly apparentBytes: Bytes;
  readonly modifiedNanoseconds: bigint;
}

export interface PlannedEntry {
  readonly path: RawPath;
  readonly expected: EntryFingerprint;
  /**
   * What this entry measured at review time. The helper renames a subtree in
   * one syscall rather than re-measuring it, so this is the number a result
   * reports back, partitioned by what became of the entry.
   */
  readonly reviewedBytes: Bytes;
}

/**
 * Whether what this plan does can be taken back.
 *
 * Trash can: the bytes are still there under another name, and the journal
 * says where. Everything else in this list cannot, which is why the operation
 * is fixed at review time and `--permanent` at apply time acknowledges a plan
 * rather than changing one.
 */
export type Reversibility = "undo-from-trash" | "irreversible";

/**
 * What becomes of a source once a move or a compress has published its output.
 *
 * This is the whole difference between an operation somebody can take back and
 * one they cannot, so it is fixed at review time like the operation itself.
 * `trash` leaves the original recoverable from the journal; `permanent`
 * releases its bytes and nothing can bring them back.
 */
export type SourceDisposition = "trash" | "permanent";

/** The operations that publish an output somewhere and then deal with a source. */
const PUBLISHING: readonly ActionOperation[] = ["move", "compress"];

export function publishesOutput(operation: ActionOperation): boolean {
  return PUBLISHING.includes(operation);
}

/** Who has to be asked before the action can run. */
export type ActionPermission = "user" | "manager-privilege";

export interface ActionPlan {
  readonly id: string;
  readonly operation: ActionOperation;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly providerId: string;
  /** The finding this plan came from, when it came from one. */
  readonly findingId?: string;
  /** What a person reads to recognise the scope: "3 directories under ~/.cache". */
  readonly scopeSummary: string;
  readonly reversibility: Reversibility;
  readonly permission: ActionPermission;
  /** Absent for a manager plan, which cannot promise a count. */
  readonly exactItemCount?: bigint;
  /** The sum of what the entries measured at review time. */
  readonly selectedBytes: Bytes;
  readonly entries?: readonly PlannedEntry[];
  /** A bounded manager selection, never a shell line. */
  readonly managerScope?: string;
  readonly regenerationCost?: string;
  /**
   * Where a move or compress publishes its output, and absent for every other
   * operation. Fixed here so apply time cannot choose a different disk.
   */
  readonly destination?: RawPath;
  /** What becomes of the source, for the same two operations and no others. */
  readonly sourceDisposition?: SourceDisposition;
  /**
   * The copy a hardlink replacement keeps, and absent for every other
   * operation. It is always one of this plan's own entries, so the fingerprint
   * the helper revalidates it against is the one that was reviewed.
   *
   * This is named rather than inferred from entry order because the operation
   * is irreversible: "the first one" is the kind of implicit rule that puts
   * the wrong file's inode on the releasing end of it.
   */
  readonly keepPath?: RawPath;
  /**
   * The identity of the cleanup rule this plan came from, when it came from
   * one. An apply reads the rule again and hashes it again: a plan whose hash
   * no longer matches was reviewed against a rule that is not the rule in the
   * file any more, and a confirmation given for the first one does not carry
   * over to the second.
   */
  readonly ruleHash?: string;
  readonly warnings: readonly string[];
}

/**
 * One thing an apply checked after the fact.
 *
 * A check that could not run is `unavailable` and never `passed`: "it was
 * fine" and "nobody could tell" are different answers, and only one of them
 * is evidence. A `failed` one means the action did not do what the plan said,
 * whatever the helper's own per-item outcomes reported.
 */
export interface VerificationCheck {
  readonly check:
    | "destination-present"
    | "source-disposed"
    | "free-space-read"
    | "digest-matched";
  readonly outcome: "passed" | "failed" | "unavailable";
  readonly detail: string;
}

export interface ActionResult {
  readonly planId: string;
  readonly completed: bigint;
  readonly skipped: bigint;
  readonly failed: bigint;
  /** What the plan reviewed, whatever became of it. */
  readonly selectedBytes: Bytes;
  /** The reviewed size of what actually moved. Usually frees nothing yet. */
  readonly bytesMovedToTrash: Bytes;
  /** Space available before the first item and after the last, when readable. */
  readonly freeBytesBefore?: Bytes;
  readonly freeBytesAfter?: Bytes;
  readonly state: "complete" | "partial" | "uncertain";
  readonly journalId: string;
  readonly undoAvailable: boolean;
  /** What the apply checked once the helper had finished, and what it found. */
  readonly verification: readonly VerificationCheck[];
}

export interface PlanInput {
  readonly operation: ActionOperation;
  readonly providerId: string;
  readonly findingId?: string;
  readonly scopeSummary: string;
  readonly createdAt: Date;
  readonly expiryMinutes: number;
  readonly entries: readonly PlannedEntry[];
  readonly managerScope?: string;
  readonly regenerationCost?: string;
  readonly destination?: RawPath;
  readonly sourceDisposition?: SourceDisposition;
  readonly keepPath?: RawPath;
  readonly ruleHash?: string;
  readonly warnings: readonly string[];
  readonly id?: string;
  readonly random?: () => string;
}

export const ACTION_OPERATIONS: readonly ActionOperation[] = [
  "trash",
  "permanent",
  "empty-trash",
  "move",
  "compress",
  "dedup-hardlink",
  "manager",
];

const IRREVERSIBLE: readonly ActionOperation[] = ["permanent", "empty-trash", "dedup-hardlink"];

/**
 * Whether what an operation does can be taken back.
 *
 * This is the only place that decides. A stored plan's own claim about its
 * reversibility is re-derived from its operation rather than believed, so a
 * file that said a permanent removal could be undone cannot slip past the
 * acknowledgement an irreversible plan needs.
 */
export function reversibilityOf(
  operation: ActionOperation,
  disposition?: SourceDisposition,
): Reversibility {
  if (IRREVERSIBLE.includes(operation)) {
    return "irreversible";
  }
  // A move or a compress is only as reversible as what it does to the source.
  // Publishing a copy somewhere and then releasing the original's bytes is a
  // permanent removal with an extra step, and it is told to a person as one.
  if (publishesOutput(operation) && disposition === "permanent") {
    return "irreversible";
  }
  return "undo-from-trash";
}

const IRREVERSIBLE_WARNING =
  "This cannot be undone. The bytes are released rather than moved, and no journal entry can bring them back.";

/**
 * A plan identifier the helper will also accept.
 *
 * The helper's `planId` rule is the narrower of the two, so matching it here
 * means a plan never has to be renamed to cross the process boundary.
 */
export function newPlanId(createdAt: Date, random: () => string): string {
  const stamp = createdAt.toISOString().replace(/[-:.TZ]/g, "");
  const suffix = random().replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
  return `plan-${stamp}-${suffix.padEnd(8, "0")}`;
}

/**
 * Freeze a reviewed action.
 *
 * Everything an apply needs is decided here: the operation, the exact entries
 * with the identity each one had at review time, whether it can be undone, and
 * when it stops being a description of this filesystem. Nothing downstream may
 * add to it, which is the whole reason it exists as a value rather than as a
 * set of arguments.
 */
export function buildPlan(input: PlanInput): ActionPlan {
  const manager = input.operation === "manager";
  if (!manager && input.entries.length === 0) {
    throw new RangeError("A plan needs at least one reviewed entry");
  }
  if (manager && (input.managerScope === undefined || input.managerScope.trim() === "")) {
    throw new RangeError("A manager plan needs the bounded selection it would run");
  }
  if (input.expiryMinutes <= 0) {
    throw new RangeError("A plan has to expire at some point after it was made");
  }
  // A duplicate has to be replaced by a link to something, and that something
  // has to be in the plan. One entry is a file with nothing to point at.
  if (input.operation === "dedup-hardlink") {
    if (input.entries.length < 2) {
      throw new RangeError(
        "Replacing a duplicate with a hardlink needs the file to keep and at least one to replace",
      );
    }
    if (input.keepPath === undefined) {
      throw new RangeError("A hardlink replacement plan has to name the copy it keeps");
    }
    const kept = input.keepPath;
    if (!input.entries.some((entry) => entry.path.bytesBase64 === kept.bytesBase64)) {
      throw new RangeError(
        "The copy a hardlink replacement keeps has to be one of the plan's own reviewed entries",
      );
    }
  } else if (input.keepPath !== undefined) {
    throw new RangeError(
      `A '${input.operation}' plan keeps nothing, so it carries no kept copy`,
    );
  }

  if (input.ruleHash !== undefined && !/^[0-9a-f]{64}$/.test(input.ruleHash)) {
    throw new RangeError("A rule hash is 64 lowercase hexadecimal characters or absent");
  }

  const publishing = publishesOutput(input.operation);
  if (publishing && (input.destination === undefined || input.sourceDisposition === undefined)) {
    throw new RangeError(
      "A move or compress plan fixes its destination and what becomes of its source; apply time cannot choose either",
    );
  }
  if (!publishing && (input.destination !== undefined || input.sourceDisposition !== undefined)) {
    throw new RangeError(
      `A '${input.operation}' plan publishes nothing, so it carries no destination or source disposition`,
    );
  }

  const reversibility = reversibilityOf(input.operation, input.sourceDisposition);
  const warnings = [...input.warnings];
  if (reversibility === "irreversible" && !warnings.includes(IRREVERSIBLE_WARNING)) {
    warnings.push(IRREVERSIBLE_WARNING);
  }

  const selectedBytes = input.entries.reduce((total, entry) => total + entry.reviewedBytes, 0n);
  const expiresAt = new Date(input.createdAt.getTime() + input.expiryMinutes * 60_000);

  return {
    id: input.id ?? newPlanId(input.createdAt, input.random ?? defaultRandom),
    operation: input.operation,
    createdAt: input.createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    providerId: input.providerId,
    ...(input.findingId === undefined ? {} : { findingId: input.findingId }),
    scopeSummary: input.scopeSummary,
    reversibility,
    permission: manager ? "manager-privilege" : "user",
    // A manager reports what it did; it cannot promise a count beforehand, and
    // a number here would read as one.
    ...(manager ? {} : { exactItemCount: BigInt(input.entries.length) }),
    selectedBytes,
    ...(manager ? {} : { entries: [...input.entries] }),
    ...(input.managerScope === undefined ? {} : { managerScope: input.managerScope }),
    ...(input.regenerationCost === undefined ? {} : { regenerationCost: input.regenerationCost }),
    ...(input.destination === undefined ? {} : { destination: input.destination }),
    ...(input.sourceDisposition === undefined
      ? {}
      : { sourceDisposition: input.sourceDisposition }),
    ...(input.keepPath === undefined ? {} : { keepPath: input.keepPath }),
    ...(input.ruleHash === undefined ? {} : { ruleHash: input.ruleHash }),
    warnings,
  };
}

/**
 * A plan describes a filesystem at a moment. Past its expiry it describes a
 * filesystem that may no longer exist, so it is refused rather than revalidated
 * item by item and applied to whatever is there now.
 */
export function isExpired(plan: ActionPlan, now: Date): boolean {
  return now.getTime() >= Date.parse(plan.expiresAt);
}

/**
 * Whether applying this plan needs its irreversibility acknowledged.
 *
 * The acknowledgement says "I know this one cannot be taken back". It never
 * turns a Trash plan into a permanent one: that choice was made at review time
 * and lives in the plan.
 */
export function requiresAcknowledgement(plan: ActionPlan): boolean {
  return plan.reversibility === "irreversible";
}

function defaultRandom(): string {
  // Not cryptographic: a plan ID only has to be unique among this user's own
  // plans, and it is never a capability.
  return Math.random().toString(36).slice(2).padEnd(8, "0");
}

/**
 * What an apply can say about its own result, after the fact.
 *
 * The helper reports what it did item by item. This is the separate question
 * of whether the action as a whole did what the plan described, asked from
 * Node's side where the plan is. It cannot see the filesystem, so it checks
 * what the result itself makes checkable and marks the rest `unavailable`
 * rather than assuming.
 */
export function verify(plan: ActionPlan, result: Omit<ActionResult, "verification">): readonly VerificationCheck[] {
  const checks: VerificationCheck[] = [];

  if (plan.destination !== undefined) {
    // Node does not stat the destination: the helper published each item with
    // a rename that refuses to overwrite and reported it, which is a stronger
    // statement than a stat taken afterwards would be.
    //
    // A completed item is one whose output arrived *and* whose source was
    // dealt with. An item that published and then could not dispose of its
    // source is neither completed nor skipped, so a count of completions
    // cannot distinguish "nothing was copied" from "everything was copied and
    // one original is still there". Saying so is the honest answer; claiming
    // nothing was published would send somebody looking for a copy that is
    // sitting right there.
    const everyItemSettled = result.completed + result.skipped === result.completed + result.skipped + result.failed;
    checks.push({
      check: "destination-present",
      outcome: result.completed > 0n && everyItemSettled ? "passed" : "unavailable",
      detail:
        result.completed > 0n && everyItemSettled
          ? `${result.completed} item(s) were published into ${plan.destination.display} without overwriting anything.`
          : `Disktop did not read ${plan.destination.display} back, so it cannot say here what is in it; the per-item results above say what each one did.`,
    });
  }

  const unfinished = result.skipped + result.failed;
  checks.push({
    check: "source-disposed",
    outcome: unfinished === 0n ? "passed" : "failed",
    detail:
      unfinished === 0n
        ? `All ${result.completed} reviewed item(s) were dealt with.`
        : `${unfinished} of the reviewed items were not: ${result.skipped} skipped and ${result.failed} failed.`,
  });

  const readable = result.freeBytesBefore !== undefined && result.freeBytesAfter !== undefined;
  checks.push({
    check: "free-space-read",
    outcome: readable ? "passed" : "unavailable",
    detail: readable
      ? "Free space was read before the first item and after the last. Other processes write to the same filesystem, so the change is not only this action's doing."
      : "Free space could not be read, so Disktop cannot say what changed on the filesystem.",
  });

  return checks;
}

/**
 * The state a result is entitled to, once its own checks have been read.
 *
 * A result that failed a check does not get to call itself complete, whatever
 * the helper reported. It is never promoted the other way: an `uncertain`
 * result stays uncertain, because a check passing says nothing about an item
 * nobody could resolve.
 */
export function stateAfterVerification(
  state: ActionResult["state"],
  checks: readonly VerificationCheck[],
): ActionResult["state"] {
  if (state === "uncertain") {
    return state;
  }
  return checks.some((check) => check.outcome === "failed") ? "partial" : state;
}
