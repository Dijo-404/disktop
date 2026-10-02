import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
  ActionOperation,
  ActionPlan,
  EntryFingerprint,
  PlannedEntry,
} from "../domain/actions.js";
import {
  ACTION_OPERATIONS,
  isExpired,
  publishesOutput,
  reversibilityOf,
  type SourceDisposition,
} from "../domain/actions.js";
import type { RawPath } from "../domain/models.js";
import { rawPathFromBytes } from "../domain/paths.js";
import { decimalBytes, parseDecimalBytes } from "../domain/sizes.js";
import type { PlanStore } from "../ports/actions.js";
import { PRIVATE_DIRECTORY_MODE } from "./xdg.js";

const PRIVATE_FILE_MODE = 0o600;
const PLAN_SUFFIX = ".json";

/** Bumped when the stored shape changes, so an old plan is skipped, not guessed at. */
export const PLAN_VERSION = 1;

/**
 * Reviewed plans on disk, one JSON file each, under `$XDG_STATE_HOME`.
 *
 * A plan is the authority an apply runs on, so two things matter here and
 * nothing else does. It is written to a temporary name and renamed into place,
 * so a crash mid-write leaves the previous file or none rather than a truncated
 * one that would apply half a plan. And every value round-trips exactly: paths
 * as base64 bytes, every count as a decimal string, so a plan reviewed against
 * one inode cannot come back naming another.
 *
 * These are Disktop's own records. Nothing here touches a user file; removing a
 * plan removes a description, not data.
 */
export function createPlanStore(stateDirectory: string): PlanStore {
  const directory = join(stateDirectory, "plans");

  return {
    async save(plan) {
      await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      const target = join(directory, `${plan.id}${PLAN_SUFFIX}`);
      const staging = `${target}.${randomBytes(6).toString("hex")}.partial`;

      const handle = await open(staging, "wx", PRIVATE_FILE_MODE);
      try {
        await handle.writeFile(`${JSON.stringify(encodePlan(plan), null, 2)}\n`, "utf8");
        // The bytes have to be on disk before the rename publishes them.
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(staging, target);
    },

    async get(id) {
      if (!isSafePlanId(id)) {
        return undefined;
      }
      return readPlan(join(directory, `${id}${PLAN_SUFFIX}`));
    },

    async list() {
      const plans: ActionPlan[] = [];
      for (const name of await planFiles(directory)) {
        const plan = await readPlan(join(directory, name));
        if (plan !== undefined) {
          plans.push(plan);
        }
      }
      // Newest first: the plan somebody just reviewed is the one they mean.
      return plans.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },

    async prune(now) {
      let removed = 0;
      for (const plan of await this.list()) {
        if (isExpired(plan, now)) {
          await rm(join(directory, `${plan.id}${PLAN_SUFFIX}`), { force: true });
          removed += 1;
        }
      }
      return removed;
    },
  };
}

/** A plan ID names one file in one directory; it is never a path. */
export function isSafePlanId(id: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(id) && id !== "." && id !== "..";
}

async function planFiles(directory: string): Promise<readonly string[]> {
  try {
    const names = await readdir(directory);
    return names.filter((name) => name.endsWith(PLAN_SUFFIX) && isSafePlanId(name.slice(0, -PLAN_SUFFIX.length)));
  } catch {
    return [];
  }
}

async function readPlan(path: string): Promise<ActionPlan | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const document: unknown = JSON.parse(source);
    return decodePlan(document);
  } catch {
    // A plan this build cannot read is a description it cannot act on. Guessing
    // at it would be applying an operation nobody reviewed.
    return undefined;
  }
}

function encodePlan(plan: ActionPlan): Record<string, unknown> {
  return {
    version: PLAN_VERSION,
    id: plan.id,
    operation: plan.operation,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    providerId: plan.providerId,
    ...(plan.findingId === undefined ? {} : { findingId: plan.findingId }),
    scopeSummary: plan.scopeSummary,
    reversibility: plan.reversibility,
    permission: plan.permission,
    ...(plan.exactItemCount === undefined ? {} : { exactItemCount: decimalBytes(plan.exactItemCount) }),
    selectedBytes: decimalBytes(plan.selectedBytes),
    ...(plan.entries === undefined ? {} : { entries: plan.entries.map(encodeEntry) }),
    ...(plan.managerScope === undefined ? {} : { managerScope: plan.managerScope }),
    ...(plan.regenerationCost === undefined ? {} : { regenerationCost: plan.regenerationCost }),
    ...(plan.destination === undefined ? {} : { destination: plan.destination.bytesBase64 }),
    ...(plan.sourceDisposition === undefined
      ? {}
      : { sourceDisposition: plan.sourceDisposition }),
    warnings: [...plan.warnings],
  };
}

function encodeEntry(entry: PlannedEntry): Record<string, unknown> {
  return {
    path: entry.path.bytesBase64,
    expected: {
      device: decimalBytes(entry.expected.device),
      inode: decimalBytes(entry.expected.inode),
      mountId: entry.expected.mountId,
      kind: entry.expected.kind,
      apparentBytes: decimalBytes(entry.expected.apparentBytes),
      modifiedNanoseconds: decimalBytes(entry.expected.modifiedNanoseconds),
    },
    reviewedBytes: decimalBytes(entry.reviewedBytes),
  };
}

function decodePlan(document: unknown): ActionPlan | undefined {
  if (!isRecord(document) || document.version !== PLAN_VERSION) {
    return undefined;
  }
  const entries = document.entries;
  // An operation this build does not know is a plan it cannot carry out, and
  // guessing at one would be running something nobody reviewed.
  const operation = text(document.operation) as ActionOperation;
  if (!ACTION_OPERATIONS.includes(operation)) {
    return undefined;
  }
  // A disposition this build does not know is a plan it cannot carry out: it
  // decides whether the source survives, and there is no safe default for that.
  let disposition: SourceDisposition | undefined;
  if (document.sourceDisposition !== undefined) {
    const stored = text(document.sourceDisposition);
    if (stored !== "trash" && stored !== "permanent") {
      return undefined;
    }
    disposition = stored;
  }
  // The two travel together. One without the other is a plan missing half of
  // what apply time is forbidden to decide.
  if (publishesOutput(operation) !== (disposition !== undefined)) {
    return undefined;
  }
  if (publishesOutput(operation) !== (document.destination !== undefined)) {
    return undefined;
  }

  const plan: ActionPlan = {
    id: text(document.id),
    operation,
    createdAt: text(document.createdAt),
    expiresAt: text(document.expiresAt),
    providerId: text(document.providerId),
    ...(document.findingId === undefined ? {} : { findingId: text(document.findingId) }),
    scopeSummary: text(document.scopeSummary),
    // Re-derived, never read: a stored claim that a permanent removal can be
    // undone would slip past the acknowledgement an irreversible plan needs.
    reversibility: reversibilityOf(operation, disposition),
    permission: text(document.permission) === "manager-privilege" ? "manager-privilege" : "user",
    ...(document.exactItemCount === undefined
      ? {}
      : { exactItemCount: parseDecimalBytes(text(document.exactItemCount)) }),
    selectedBytes: parseDecimalBytes(text(document.selectedBytes)),
    ...(Array.isArray(entries) ? { entries: entries.map(decodeEntry) } : {}),
    ...(document.managerScope === undefined ? {} : { managerScope: text(document.managerScope) }),
    ...(document.regenerationCost === undefined
      ? {}
      : { regenerationCost: text(document.regenerationCost) }),
    ...(document.destination === undefined
      ? {}
      : { destination: decodePath(text(document.destination)) }),
    ...(disposition === undefined ? {} : { sourceDisposition: disposition }),
    warnings: Array.isArray(document.warnings) ? document.warnings.map(text) : [],
  };
  return plan;
}

function decodeEntry(value: unknown): PlannedEntry {
  if (!isRecord(value) || !isRecord(value.expected)) {
    throw new RangeError("A stored plan entry is missing its reviewed identity");
  }
  const expected = value.expected;
  const fingerprint: EntryFingerprint = {
    device: parseDecimalBytes(text(expected.device)),
    inode: parseDecimalBytes(text(expected.inode)),
    mountId: text(expected.mountId),
    kind: text(expected.kind) as EntryFingerprint["kind"],
    apparentBytes: parseDecimalBytes(text(expected.apparentBytes)),
    modifiedNanoseconds: parseDecimalBytes(text(expected.modifiedNanoseconds)),
  };
  return {
    path: decodePath(text(value.path)),
    expected: fingerprint,
    reviewedBytes: parseDecimalBytes(text(value.reviewedBytes)),
  };
}

function decodePath(encoded: string): RawPath {
  return rawPathFromBytes(new Uint8Array(Buffer.from(encoded, "base64")));
}

function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new RangeError("A stored plan field is not the text this build expects");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
