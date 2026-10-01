import type { ActionPlan, ActionResult, PlannedEntry } from "../../../domain/actions.js";
import { CapabilityUnavailable } from "../../../domain/errors.js";
import type { OperationFailure, OperationFailureCode } from "../../../domain/errors.js";
import type { RawPath } from "../../../domain/models.js";
import { rawPathFromBytes, rawPathFromUtf8 } from "../../../domain/paths.js";
import type { HelperEvent, HelperStart, NativeHelperClient } from "../../../native/client.js";
import {
  parseActionResult,
  parseJournalPage,
  type NativeJournalItem,
  type NativeJournalRecord,
} from "../../../native/protocol.js";
import type {
  ActionJournalPort,
  ActionPort,
  JournalItem,
  JournalPage,
  JournalRecord,
} from "../../../ports/actions.js";

export interface NativeActionOptions {
  /** `$XDG_STATE_HOME/disktop`. Node owns the location, not the helper. */
  readonly journalDirectory: string;
  /** `$XDG_DATA_HOME/Trash`, per the freedesktop specification. */
  readonly homeTrashDirectory: string;
  readonly start: () => Promise<HelperStart>;
}

/** How many history records one page asks for. */
const PAGE_SIZE = 50;

/**
 * The action and journal ports, backed by the `disktop-fs` child process.
 *
 * Node decides nothing here. It hands the helper a reviewed plan and the two
 * directories whose locations the XDG rules fix, and the helper repeats every
 * check before it touches anything — which is the point of the arrangement, not
 * a redundancy in it. One helper is started per operation and shut down after
 * it, so nothing is left running between commands.
 */
export function createNativeActions(options: NativeActionOptions): ActionPort & ActionJournalPort {
  const journalDirectory = rawPathFromUtf8(options.journalDirectory).bytesBase64;
  const homeTrashDirectory = rawPathFromUtf8(options.homeTrashDirectory).bytesBase64;

  async function run(
    operation: string,
    operationArguments: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<ActionResult> {
    const client = await connect(options.start);
    try {
      let terminal: HelperEvent | undefined;
      for await (const event of client.stream(operation, operationArguments, signal)) {
        // `accepted` and `item-result` are progress: the whole action's answer
        // is the terminal event, and a stream that ends without one is never
        // read as success.
        terminal = event;
      }
      if (terminal === undefined) {
        throw new Error("The helper closed before the action reported what it did.");
      }
      refuseError(terminal, client);
      return toResult(parseActionResult(terminal.result));
    } finally {
      await client.close();
    }
  }

  return {
    async apply(plan, signal) {
      const operation = helperOperation(plan);
      const result = await run(
        operation,
        {
          planId: plan.id,
          journalDirectory,
          // Only a Trash move needs somewhere to put things.
          ...(operation === "trash" ? { homeTrashDirectory } : {}),
          targets: (plan.entries ?? []).map(encodeTarget),
        },
        signal,
      );
      return { ...result, planId: plan.id };
    },

    async restore(journalId, signal) {
      const result = await run("restore", { journalDirectory, journalId }, signal);
      return result;
    },

    async list(cursor, limit) {
      const client = await connect(options.start);
      try {
        const event = await client.request("journal-reconcile", {
          journalDirectory,
          ...(cursor === undefined ? {} : { cursor }),
          limit: String(Math.max(1, Math.trunc(limit ?? PAGE_SIZE))),
        });
        refuseError(event, client);
        const page = parseJournalPage(event.result);
        return {
          reconciled: page.reconciled,
          records: page.records.map(toJournalRecord),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        } satisfies JournalPage;
      } finally {
        await client.close();
      }
    },

    async get(id) {
      // The helper answers with pages, so a lookup walks them. History is
      // bounded by what a person actually did, not by the filesystem's size.
      let cursor: string | undefined;
      do {
        const page: JournalPage = await this.list(cursor, PAGE_SIZE);
        const found = page.records.find((record) => record.id === id);
        if (found !== undefined) {
          return found;
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return undefined;
    },
  };
}

/**
 * The helper operation one reviewed plan maps to.
 *
 * The mapping is total and fixed: a plan that says `permanent` erases, and
 * nothing at apply time can make it trash instead or the other way round.
 */
function helperOperation(plan: ActionPlan): string {
  switch (plan.operation) {
    case "trash":
      return "trash";
    case "permanent":
      return "erase";
    default:
      throw new CapabilityUnavailable({
        status: "unsupported-kernel",
        explanation: `Disktop cannot carry out a '${plan.operation}' plan yet.`,
      });
  }
}

function encodeTarget(entry: PlannedEntry): Record<string, unknown> {
  return {
    path: entry.path.bytesBase64,
    expected: {
      device: entry.expected.device.toString(10),
      inode: entry.expected.inode.toString(10),
      mountId: entry.expected.mountId,
      kind: entry.expected.kind,
      apparentBytes: entry.expected.apparentBytes.toString(10),
      modifiedNanoseconds: entry.expected.modifiedNanoseconds.toString(10),
    },
    reviewedBytes: entry.reviewedBytes.toString(10),
  };
}

function toResult(result: ReturnType<typeof parseActionResult>): ActionResult {
  return {
    planId: "",
    completed: result.completed,
    skipped: result.skipped,
    failed: result.failed,
    selectedBytes: result.selectedBytes,
    bytesMovedToTrash: result.bytesMovedToTrash,
    ...(result.freeBytesBefore === undefined ? {} : { freeBytesBefore: result.freeBytesBefore }),
    ...(result.freeBytesAfter === undefined ? {} : { freeBytesAfter: result.freeBytesAfter }),
    state: result.state,
    journalId: result.journalId,
    undoAvailable: result.undoAvailable,
  };
}

function toJournalRecord(record: NativeJournalRecord): JournalRecord {
  return {
    id: record.id,
    planId: record.planId,
    operation: record.operation,
    startedAt: instant(record.startedAtMilliseconds),
    ...(record.finishedAtMilliseconds === undefined
      ? {}
      : { finishedAt: instant(record.finishedAtMilliseconds) }),
    state: record.state,
    completed: record.completed,
    skipped: record.skipped,
    failed: record.failed,
    selectedBytes: record.selectedBytes,
    bytesMovedToTrash: record.bytesMovedToTrash,
    ...(record.freeBytesBefore === undefined ? {} : { freeBytesBefore: record.freeBytesBefore }),
    ...(record.freeBytesAfter === undefined ? {} : { freeBytesAfter: record.freeBytesAfter }),
    items: record.items.map(toJournalItem),
  };
}

function toJournalItem(item: NativeJournalItem): JournalItem {
  return {
    path: decodePath(item.path),
    ...(item.destination === undefined ? {} : { destination: decodePath(item.destination) }),
    outcome: item.outcome,
    ...(item.message === undefined ? {} : { message: item.message }),
    bytes: item.bytes,
  };
}

/** The helper counts milliseconds; the public contract reads instants. */
function instant(milliseconds: bigint): string {
  return new Date(Number(milliseconds)).toISOString();
}

/** A failure the caller is expected to handle rather than crash on. */
export class ActionRefused extends Error {
  readonly failure: OperationFailure;

  constructor(failure: OperationFailure) {
    super(failure.message);
    this.name = "ActionRefused";
    this.failure = failure;
  }
}

const FAILURE_CODES: Readonly<Record<string, OperationFailureCode>> = {
  "protected-path": "protected-path",
  "changed-target": "changed-target",
  "unsafe-parent": "protected-path",
  "expired-plan": "invalid-plan",
  "no-safe-trash": "unsupported",
  "invalid-arguments": "invalid-plan",
  "unknown-request": "invalid-plan",
  "journal-write-failed": "internal-error",
  cancelled: "cancelled",
};

/**
 * Translate the helper's refusal into something a surface can show.
 *
 * A missing kernel feature, a denied permission, or a filesystem that cannot do
 * this are capability states: the machine cannot offer the feature. Everything
 * else is a refusal about this particular request, and reaches the caller as a
 * failure it is expected to report rather than as a crash.
 */
function refuseError(event: HelperEvent, client: NativeHelperClient): void {
  if (event.event !== "error") {
    return;
  }
  const failure = event.error as { code?: unknown; message?: unknown } | undefined;
  const code = typeof failure?.code === "string" ? failure.code : "internal-error";
  const message = typeof failure?.message === "string" ? failure.message : "The helper refused the action.";
  const diagnostics = client.diagnostics();
  const explanation = diagnostics === "" ? message : `${message} (${diagnostics})`;

  if (code === "unsupported-kernel" || code === "unsupported-filesystem") {
    throw new CapabilityUnavailable({ status: code, explanation });
  }
  if (code === "permission-denied") {
    throw new CapabilityUnavailable({ status: "permission-denied", explanation });
  }
  const mapped = FAILURE_CODES[code];
  if (mapped !== undefined) {
    throw new ActionRefused({ code: mapped, message: explanation, details: { helperCode: code } });
  }
  throw new Error(explanation);
}

async function connect(start: () => Promise<HelperStart>): Promise<NativeHelperClient> {
  const started = await start();
  if (!started.started) {
    throw new CapabilityUnavailable(started.capability);
  }
  return started.client;
}

function decodePath(encoded: string): RawPath {
  return rawPathFromBytes(new Uint8Array(Buffer.from(encoded, "base64")));
}
