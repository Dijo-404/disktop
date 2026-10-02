import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
  ActionOperation,
  ActionPlan,
  EntryFingerprint,
  PlannedEntry,
  SubtreeManifest,
} from "../domain/actions.js";
import {
  ACTION_OPERATIONS,
  isExpired,
  publishesOutput,
  reversibilityOf,
  type SourceDisposition,
} from "../domain/actions.js";
import {
  describeCommand,
  isManagerAction,
  managerScope,
  type ManagerPreview,
  type ManagerScope,
} from "../domain/managers.js";
import type { RawPath } from "../domain/models.js";
import { rawPathFromBytes } from "../domain/paths.js";
import { decimalBytes, parseDecimalBytes } from "../domain/sizes.js";
import type { PlanStore } from "../ports/actions.js";
import { PRIVATE_DIRECTORY_MODE } from "./xdg.js";

const PRIVATE_FILE_MODE = 0o600;
const PLAN_SUFFIX = ".json";

/** Bumped when the stored shape changes, so an old plan is skipped, not guessed at. */
export const PLAN_VERSION = 2;

/** The longest expiry `cleanup.plan_expiry_minutes` can configure. */
const MAX_EXPIRY_MILLISECONDS = 1440 * 60_000;

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
    ...(plan.selectedBytes === undefined ? {} : { selectedBytes: decimalBytes(plan.selectedBytes) }),
    ...(plan.entries === undefined ? {} : { entries: plan.entries.map(encodeEntry) }),
    ...(plan.manager === undefined ? {} : { manager: encodeManager(plan.manager) }),
    ...(plan.regenerationCost === undefined ? {} : { regenerationCost: plan.regenerationCost }),
    ...(plan.destination === undefined ? {} : { destination: plan.destination.bytesBase64 }),
    ...(plan.sourceDisposition === undefined
      ? {}
      : { sourceDisposition: plan.sourceDisposition }),
    ...(plan.keepPath === undefined ? {} : { keepPath: plan.keepPath.bytesBase64 }),
    ...(plan.ruleHash === undefined ? {} : { ruleHash: plan.ruleHash }),
    warnings: [...plan.warnings],
  };
}

function encodeManager(scope: ManagerScope): Record<string, unknown> {
  return {
    action: scope.action,
    parameters: { ...scope.parameters },
    items: scope.items.map((item) => ({
      id: item.id,
      ...(item.bytes === undefined ? {} : { bytes: decimalBytes(item.bytes) }),
    })),
    count:
      scope.count.kind === "unknown"
        ? { kind: "unknown" }
        : { kind: scope.count.kind, value: decimalBytes(scope.count.value) },
    ...(scope.estimatedBytes === undefined ? {} : { estimatedBytes: decimalBytes(scope.estimatedBytes) }),
    preview: scope.preview,
  };
}

const MANAGER_KEYS = new Set(["action", "parameters", "items", "count", "estimatedBytes", "preview"]);
const PREVIEWS: readonly ManagerPreview[] = ["listed", "simulated", "none"];

function decodeManager(value: unknown): ManagerScope {
  if (!isRecord(value) || Object.keys(value).some((key) => !MANAGER_KEYS.has(key))) {
    throw new RangeError("A stored manager selection holds something this build does not read");
  }
  const action = text(value.action);
  if (!isManagerAction(action)) {
    throw new RangeError("A stored manager selection names an action this build does not know");
  }
  const parameters = value.parameters;
  if (!isRecord(parameters)) {
    throw new RangeError("A stored manager selection has no parameters");
  }
  const items = value.items;
  if (!Array.isArray(items)) {
    throw new RangeError("A stored manager selection has no items");
  }
  const count = value.count;
  if (!isRecord(count)) {
    throw new RangeError("A stored manager selection has no count");
  }
  const kind = text(count.kind);
  const preview = text(value.preview) as ManagerPreview;
  if (!PREVIEWS.includes(preview)) {
    throw new RangeError("A stored manager selection has no preview kind");
  }
  return managerScope({
    action,
    parameters: Object.fromEntries(Object.entries(parameters).map(([key, entry]) => [key, text(entry)])),
    items: items.map((item: unknown) => {
      if (!isRecord(item) || Object.keys(item).some((key) => key !== "id" && key !== "bytes")) {
        throw new RangeError("A stored manager item holds something this build does not read");
      }
      return {
        id: text(item.id),
        ...(item.bytes === undefined ? {} : { bytes: parseDecimalBytes(text(item.bytes)) }),
      };
    }),
    count:
      kind === "unknown"
        ? { kind }
        : kind === "exact" || kind === "estimated"
          ? { kind, value: parseDecimalBytes(text(count.value)) }
          : (() => {
              throw new RangeError("A stored manager count is not one this build knows");
            })(),
    ...(value.estimatedBytes === undefined ? {} : { estimatedBytes: parseDecimalBytes(text(value.estimatedBytes)) }),
    preview,
  });
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
    ...(entry.subtree === undefined
      ? {}
      : { subtree: { entries: decimalBytes(entry.subtree.entries), digest: entry.subtree.digest } }),
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
  // The same rule for the copy a hardlink replacement keeps: a stored plan
  // that lost it is a plan that would have to pick one, and picking one is
  // exactly what this build refuses to do.
  if ((operation === "dedup-hardlink") !== (document.keepPath !== undefined)) {
    return undefined;
  }

  const createdAt = instant(document.createdAt);
  const expiresAt = instant(document.expiresAt);
  const window = Date.parse(expiresAt) - Date.parse(createdAt);
  if (window <= 0 || window > MAX_EXPIRY_MILLISECONDS) {
    return undefined;
  }

  const decodedEntries = Array.isArray(entries) ? entries.map(decodeEntry) : undefined;
  if (operation !== "manager" && (decodedEntries === undefined || decodedEntries.length === 0)) {
    return undefined;
  }
  if ((operation === "manager") !== (document.manager !== undefined)) {
    return undefined;
  }
  const manager = operation === "manager" ? decodeManager(document.manager) : undefined;
  if (manager !== undefined) {
    if (decodedEntries !== undefined) {
      return undefined;
    }
    const stored = document.selectedBytes === undefined ? undefined : parseDecimalBytes(text(document.selectedBytes));
    if (stored !== manager.estimatedBytes) {
      return undefined;
    }
    const exact = manager.count.kind === "exact" ? manager.count.value : undefined;
    const storedCount =
      document.exactItemCount === undefined ? undefined : parseDecimalBytes(text(document.exactItemCount));
    if (storedCount !== exact) {
      return undefined;
    }
  }
  if (decodedEntries !== undefined) {
    const total = decodedEntries.reduce((sum, entry) => sum + entry.reviewedBytes, 0n);
    if (parseDecimalBytes(text(document.selectedBytes)) !== total) {
      return undefined;
    }
    if (
      document.exactItemCount !== undefined &&
      parseDecimalBytes(text(document.exactItemCount)) !== BigInt(decodedEntries.length)
    ) {
      return undefined;
    }
  }

  const plan: ActionPlan = {
    id: text(document.id),
    operation,
    createdAt,
    expiresAt,
    providerId: text(document.providerId),
    ...(document.findingId === undefined ? {} : { findingId: text(document.findingId) }),
    scopeSummary: text(document.scopeSummary),
    // Re-derived, never read: a stored claim that a permanent removal can be
    // undone would slip past the acknowledgement an irreversible plan needs.
    reversibility: reversibilityOf(operation, disposition),
    permission: manager?.privilege === "root" ? "manager-privilege" : "user",
    ...(document.exactItemCount === undefined
      ? {}
      : { exactItemCount: parseDecimalBytes(text(document.exactItemCount)) }),
    ...(document.selectedBytes === undefined
      ? {}
      : { selectedBytes: parseDecimalBytes(text(document.selectedBytes)) }),
    ...(decodedEntries === undefined ? {} : { entries: decodedEntries }),
    ...(manager === undefined
      ? {}
      : {
          managerScope: manager.commands.map((command) => describeCommand(command, manager.privilege)).join("; "),
          manager,
        }),
    ...(document.regenerationCost === undefined
      ? {}
      : { regenerationCost: text(document.regenerationCost) }),
    ...(document.destination === undefined
      ? {}
      : { destination: decodePath(text(document.destination)) }),
    ...(disposition === undefined ? {} : { sourceDisposition: disposition }),
    ...(document.keepPath === undefined
      ? {}
      : { keepPath: decodePath(text(document.keepPath)) }),
    ...(document.ruleHash === undefined ? {} : { ruleHash: ruleHashOf(document.ruleHash) }),
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
    kind: entryKind(expected.kind),
    apparentBytes: parseDecimalBytes(text(expected.apparentBytes)),
    modifiedNanoseconds: parseDecimalBytes(text(expected.modifiedNanoseconds)),
  };
  return {
    path: decodePath(text(value.path)),
    expected: fingerprint,
    reviewedBytes: parseDecimalBytes(text(value.reviewedBytes)),
    ...(value.subtree === undefined ? {} : { subtree: subtreeOf(value.subtree) }),
  };
}

function subtreeOf(value: unknown): SubtreeManifest {
  if (!isRecord(value) || !/^[0-9a-f]{64}$/.test(text(value.digest))) {
    throw new RangeError("A stored plan's subtree is not a digest");
  }
  return { entries: parseDecimalBytes(text(value.entries)), digest: text(value.digest) };
}

const ENTRY_KINDS: readonly EntryFingerprint["kind"][] = ["file", "directory", "symlink"];

function entryKind(value: unknown): EntryFingerprint["kind"] {
  const kind = text(value) as EntryFingerprint["kind"];
  if (!ENTRY_KINDS.includes(kind)) {
    throw new RangeError("A stored plan entry names a kind Disktop never plans");
  }
  return kind;
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function instant(value: unknown): string {
  const stored = text(value);
  if (!INSTANT.test(stored) || Number.isNaN(Date.parse(stored))) {
    throw new RangeError("A stored plan time is not an instant");
  }
  return stored;
}

/** A stored hash that is not a hash is a stored plan this build will not read. */
function ruleHashOf(value: unknown): string {
  const stored = text(value);
  if (!/^[0-9a-f]{64}$/.test(stored)) {
    throw new RangeError("A stored plan's rule hash is not a hash");
  }
  return stored;
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
