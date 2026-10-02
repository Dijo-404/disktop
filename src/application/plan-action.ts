import {
  buildPlan,
  publishesOutput,
  type ActionOperation,
  type ActionPlan,
  type PlannedEntry,
  type SourceDisposition,
} from "../domain/actions.js";
import type { OperationFailure } from "../domain/errors.js";
import type { Finding } from "../domain/findings.js";
import type { RawPath } from "../domain/models.js";
import { isWithin, pathBytes, rawPathFromBytes } from "../domain/paths.js";
import {
  classifyDestination,
  classifyGenericTarget,
  type ProtectedPathContext,
} from "../domain/protected-paths.js";
import type { InventoryPort } from "../ports/inventory.js";
import type { FootprintPort, PathFacts, PathProbe } from "../ports/providers.js";
import type { InspectOutcome, InspectPort, PlanStore } from "../ports/actions.js";
import type { ManagerInventoryPort } from "../ports/managers.js";
import { MANAGER_ACTIONS, isManagerAction, managerScope } from "../domain/managers.js";
import { CapabilityUnavailable } from "../domain/errors.js";
import type { FootprintService } from "./footprint.js";

export interface PlanRequest {
  readonly operation: ActionOperation;
  /** Plan a finding a detector proposed, or an explicitly selected path. */
  readonly findingId?: string;
  readonly path?: RawPath;
  /**
   * Where a move publishes, and where a compress publishes when it is not
   * beside the source. A move has to name one; there is no default disk.
   */
  readonly destination?: RawPath;
  /** Required for a move or a compress. Nothing else accepts it. */
  readonly sourceDisposition?: SourceDisposition;
  /** The copy a hardlink replacement keeps. Nothing else accepts it. */
  readonly keepPath?: RawPath;
  /**
   * A second explicit path for a hardlink replacement: the copy that becomes
   * a name for `path`. A single path cannot describe a pair, and nothing here
   * goes looking for a duplicate on somebody's behalf.
   */
  readonly replacePath?: RawPath;
}

export interface PlanSettings {
  readonly home: RawPath;
  /** The user-owned roots generic cleanup may act inside. */
  readonly allowedRoots: readonly RawPath[];
  /** Trash, Disktop's own state, and anything else named as off limits. */
  readonly excludedRoots: readonly RawPath[];
  /** This user's own Trash, which only `empty-trash` may name as a target. */
  readonly trashDirectory: RawPath;
  readonly expiryMinutes: number;
}

export type PlanOutcome =
  | { readonly kind: "planned"; readonly plan: ActionPlan }
  | { readonly kind: "refused"; readonly failure: OperationFailure };

export interface PlanService {
  plan(request: PlanRequest, signal: AbortSignal): Promise<PlanOutcome>;
}

export interface PlanDependencies {
  readonly footprint: Pick<FootprintService, "discover">;
  readonly inventory: InventoryPort;
  readonly paths: Pick<PathProbe, "facts">;
  /** Measures a directory's whole subtree, which one stat cannot. */
  readonly footprints: FootprintPort;
  readonly store: Pick<PlanStore, "save">;
  readonly inspect: InspectPort;
  /** Absent where no manager adapter was built; a manager plan is then refused. */
  readonly managers?: ManagerInventoryPort;
  readonly settings: PlanSettings;
  readonly now: () => Date;
  /**
   * The hash of the cleanup rule a finding came from, when it came from one.
   *
   * It goes into the plan so an apply can tell whether the rule it was
   * reviewed against is still the rule in the configuration file.
   */
  readonly ruleHashFor?: (findingId: string) => string | undefined;
}

/** The operations a generic plan may fix. `manager` belongs to a later phase. */
const GENERIC_OPERATIONS: readonly ActionOperation[] = [
  "trash",
  "permanent",
  "empty-trash",
  "move",
  "compress",
  "dedup-hardlink",
];

/**
 * Turn a finding or a selected path into a reviewed, immutable plan.
 *
 * Three things happen here and all three happen before anything is stored. The
 * target is classified against the protected-path policy, so a plan for `/etc`
 * never exists to be applied. Every path is fingerprinted live, so the plan
 * describes the entries that are there now rather than the ones a detector saw
 * earlier. And the operation is fixed, because the whole point of a plan is
 * that apply time cannot change what was agreed to.
 */
export function createPlanService(dependencies: PlanDependencies): PlanService {
  return {
    async plan(request, signal) {
      if (request.operation === "manager") {
        return planManager(dependencies, request);
      }
      if (!GENERIC_OPERATIONS.includes(request.operation)) {
        return refuse("not-implemented", `Disktop cannot plan a '${request.operation}' action yet.`);
      }

      const context = await protectedPathContext(dependencies);
      if (context === undefined) {
        return refuse(
          "invalid-plan",
          "The mount table could not be read, so no target can be cleared. Nothing was planned.",
        );
      }

      const subject = await resolveSubject(dependencies, request, signal);
      if ("failure" in subject) {
        return { kind: "refused", failure: subject.failure };
      }

      // Emptying Trash is the one operation whose target is a directory the
      // generic policy excludes, so it is judged by a rule of its own: it may
      // name this user's Trash and nothing else. Every other operation goes
      // through the policy that refuses Trash along with everything else.
      if (request.operation === "empty-trash") {
        const trash = dependencies.settings.trashDirectory;
        if (subject.paths.some((path) => path.bytesBase64 !== trash.bytesBase64)) {
          return refuse(
            "protected-path",
            `Only ${trash.display} can be emptied. 'empty-trash' is not a way to remove an ordinary directory.`,
          );
        }
      } else {
        for (const path of subject.paths) {
          const verdict = classifyGenericTarget(path, context);
          if (!verdict.allowed) {
            return refuse(verdict.code, `${path.display} cannot be cleaned up: ${verdict.reason}.`);
          }
        }
      }

      // Where the output goes is decided here and nowhere else. A move has to
      // name a destination; a compress falls back to the source's own parent,
      // which is where somebody would put an archive by hand.
      let destination: RawPath | undefined;
      if (publishesOutput(request.operation)) {
        if (request.sourceDisposition === undefined) {
          return refuse(
            "invalid-input",
            `A '${request.operation}' plan has to say what becomes of the source. Pass '--source trash' or '--source permanent'.`,
          );
        }
        const named = request.destination ?? defaultDestination(request.operation, subject.paths);
        if (named === undefined) {
          return refuse(
            "invalid-input",
            "A move has to name the directory it publishes into. Pass '--destination PATH'.",
          );
        }
        // A destination is judged by its own policy. The allowlist that bounds
        // what Disktop may remove does not bound where it may write, because a
        // cross-disk move means writing outside it by definition.
        const verdict = classifyDestination(named, context);
        if (!verdict.allowed) {
          return refuse(
            verdict.code,
            `${named.display} cannot be written into: ${verdict.reason}.`,
          );
        }
        const destinationFacts = await dependencies.paths.facts(named);
        if (destinationFacts === undefined) {
          return refuse(
            "invalid-plan",
            `${named.display} is not there. Disktop publishes into a directory that already exists rather than creating one.`,
          );
        }
        if (destinationFacts.kind !== "directory") {
          return refuse("invalid-plan", `${named.display} is not a directory.`);
        }

        for (const path of subject.paths) {
          if (isWithin(pathBytes(path), pathBytes(named))) {
            return refuse(
              "invalid-plan",
              `${named.display} is inside ${path.display}, so publishing there would write the output into what it is copying.`,
            );
          }
          const sourceFacts = await dependencies.paths.facts(path);
          if (
            request.operation === "move" &&
            sourceFacts !== undefined &&
            sourceFacts.device === destinationFacts.device
          ) {
            return refuse(
              "invalid-plan",
              `${named.display} is on the same filesystem as ${path.display}. Moving within one filesystem frees nothing; use 'mv' or plan a different destination.`,
            );
          }
        }
        destination = named;
      } else if (request.destination !== undefined || request.sourceDisposition !== undefined) {
        return refuse(
          "invalid-input",
          `A '${request.operation}' plan publishes nothing, so '--destination' and '--source' do not apply to it.`,
        );
      }

      let keepPath: RawPath | undefined;
      if (request.operation === "dedup-hardlink") {
        if (subject.paths.length < 2) {
          return refuse(
            "invalid-plan",
            "Replacing a duplicate with a hardlink needs at least two files: the one to keep and the one to replace.",
          );
        }
        // The copy that survives is named, never inferred from order. When the
        // request does not say, the first path of the group is kept and the
        // plan records that choice so the person reviewing it can see it.
        keepPath = request.keepPath ?? (subject.paths[0] as RawPath);
        if (!subject.paths.some((path) => path.bytesBase64 === keepPath?.bytesBase64)) {
          return refuse(
            "invalid-plan",
            `${keepPath.display} is not one of the files this plan covers, so it cannot be the copy that is kept.`,
          );
        }
      } else if (request.keepPath !== undefined) {
        return refuse(
          "invalid-input",
          `A '${request.operation}' plan keeps nothing, so '--keep-path' does not apply to it.`,
        );
      }

      // One measurement for every path at once. A directory's own stat gives
      // the bytes of its inode and nothing about what it holds, so a plan built
      // from stats alone would tell somebody they were reclaiming four
      // kilobytes while moving a twenty-gigabyte tree.
      const measured = await measure(dependencies, subject.paths, signal);

      const entries: PlannedEntry[] = [];
      for (const path of subject.paths) {
        const facts = await dependencies.paths.facts(path);
        if (facts === undefined) {
          return refuse(
            "changed-target",
            `${path.display} is no longer there, so there is nothing to review.`,
          );
        }
        if (facts.kind === "other") {
          return refuse(
            "invalid-plan",
            `${path.display} is not a file, directory, or symlink, so Disktop will not act on it.`,
          );
        }
        entries.push(toEntry(path, facts, measured.get(path.bytesBase64)));
      }

      const reviewed = await withSubtrees(dependencies, entries, signal);
      if ("failure" in reviewed) {
        return { kind: "refused", failure: reviewed.failure };
      }
      entries.splice(0, entries.length, ...reviewed.entries);

      if (
        request.operation === "dedup-hardlink" &&
        new Set(entries.map((entry) => entry.expected.device)).size > 1
      ) {
        return refuse(
          "invalid-plan",
          "These files are not on the same filesystem, so a hardlink cannot join them.",
        );
      }

      const ruleHash =
        subject.findingId === undefined || dependencies.ruleHashFor === undefined
          ? undefined
          : dependencies.ruleHashFor(subject.findingId);

      const warnings = [...subject.warnings];
      if (entries.some((entry) => entry.expected.kind === "directory" && !measured.has(entry.path.bytesBase64))) {
        warnings.push(
          "A directory's footprint could not be measured, so the totals here cover the entries themselves and not everything inside them.",
        );
      }

      const plan = buildPlan({
        operation: request.operation,
        providerId: subject.providerId,
        ...(subject.findingId === undefined ? {} : { findingId: subject.findingId }),
        scopeSummary: scopeSummary(entries),
        createdAt: dependencies.now(),
        expiryMinutes: dependencies.settings.expiryMinutes,
        entries,
        ...(subject.regenerationCost === undefined
          ? {}
          : { regenerationCost: subject.regenerationCost }),
        ...(destination === undefined ? {} : { destination }),
        ...(request.sourceDisposition === undefined
          ? {}
          : { sourceDisposition: request.sourceDisposition }),
        ...(keepPath === undefined ? {} : { keepPath }),
        ...(ruleHash === undefined ? {} : { ruleHash }),
        warnings,
      });

      await dependencies.store.save(plan);
      return { kind: "planned", plan };
    },
  };
}

const MANAGER_PREFIX = "managers:";

async function planManager(dependencies: PlanDependencies, request: PlanRequest): Promise<PlanOutcome> {
  if (
    request.path !== undefined ||
    request.destination !== undefined ||
    request.sourceDisposition !== undefined ||
    request.keepPath !== undefined ||
    request.replacePath !== undefined
  ) {
    return refuse("invalid-input", "A manager plan names a manager finding, not a path, destination, or kept copy.");
  }
  const findingId = request.findingId;
  if (findingId === undefined || !findingId.startsWith(MANAGER_PREFIX)) {
    return refuse("invalid-input", "A manager plan needs a finding from 'disktop clean' whose id starts with 'managers:'.");
  }
  const action = findingId.slice(MANAGER_PREFIX.length);
  if (!isManagerAction(action)) {
    return refuse("invalid-plan", `${findingId} is reported for information; Disktop offers no action on it.`);
  }
  if (dependencies.managers === undefined) {
    return refuse("not-implemented", "No manager adapter is available in this build.");
  }
  const preview = await dependencies.managers.preview(action, {});
  if (preview.kind === "refused") {
    return refuse(preview.capability === undefined ? "invalid-plan" : "unsupported", preview.message);
  }
  const proposal = preview.proposal;
  if (!proposal.offered) {
    return refuse("invalid-plan", `${proposal.title}: there is nothing here Disktop will offer to remove right now.`);
  }
  let scope;
  try {
    scope = managerScope({
      action,
      items: proposal.items,
      parameters: proposal.parameters,
      count: proposal.count,
      ...(proposal.estimatedBytes === undefined ? {} : { estimatedBytes: proposal.estimatedBytes }),
      preview: proposal.preview,
    });
  } catch (error) {
    return refuse("invalid-plan", `The manager's selection could not be reviewed: ${String((error as Error).message)}`);
  }
  const spec = MANAGER_ACTIONS[action];
  const plan = buildPlan({
    operation: "manager",
    providerId: "managers",
    findingId,
    scopeSummary: proposal.title,
    createdAt: dependencies.now(),
    expiryMinutes: dependencies.settings.expiryMinutes,
    entries: [],
    manager: scope,
    ...(spec.regenerationCost === undefined ? {} : { regenerationCost: spec.regenerationCost }),
    warnings: [...spec.warnings, ...proposal.evidence],
  });
  await dependencies.store.save(plan);
  return { kind: "planned", plan };
}

/**
 * Where a compress puts its archive when nobody said: beside what it archives.
 *
 * A move has no equivalent. "Somewhere else" is the entire point of a move and
 * there is no disk Disktop may pick on somebody's behalf.
 */
function defaultDestination(
  operation: ActionOperation,
  paths: readonly RawPath[],
): RawPath | undefined {
  if (operation !== "compress") {
    return undefined;
  }
  const first = paths[0];
  if (first === undefined) {
    return undefined;
  }
  const bytes = pathBytes(first);
  const slash = bytes.lastIndexOf(0x2f);
  if (slash <= 0) {
    return undefined;
  }
  return rawPathFromBytes(bytes.slice(0, slash));
}

interface Subject {
  readonly paths: readonly RawPath[];
  readonly providerId: string;
  readonly findingId?: string;
  readonly regenerationCost?: string;
  readonly warnings: readonly string[];
}

/** What the request is about: a detector's finding, or a path somebody named. */
async function resolveSubject(
  dependencies: PlanDependencies,
  request: PlanRequest,
  signal: AbortSignal,
): Promise<Subject | { readonly failure: OperationFailure }> {
  if (request.operation === "empty-trash") {
    const trash = request.path ?? dependencies.settings.trashDirectory;
    return {
      paths: [trash],
      providerId: "trash",
      warnings: [
        "Everything in Trash goes. Anything Disktop moved there is no longer recoverable with 'disktop undo'.",
      ],
    };
  }

  if (request.path !== undefined) {
    if (request.replacePath !== undefined) {
      if (request.operation !== "dedup-hardlink") {
        return {
          failure: failure(
            "invalid-input",
            `A '${request.operation}' plan replaces nothing with a link, so '--replace' does not apply to it.`,
          ),
        };
      }
      if (request.replacePath.bytesBase64 === request.path.bytesBase64) {
        return {
          failure: failure(
            "invalid-input",
            "A file cannot be replaced by a link to itself. '--path' is the copy kept and '--replace' is the copy that becomes a name for it.",
          ),
        };
      }
      return {
        paths: [request.path, request.replacePath],
        providerId: "explicit-path",
        warnings: [
          "These paths were selected directly, so no detector vouched for them holding the same bytes. The helper compares them in full before it replaces either.",
        ],
      };
    }
    return {
      paths: [request.path],
      providerId: "explicit-path",
      // A path somebody typed carries no detector's judgement about what it is
      // for, so the plan says so rather than implying one.
      warnings: ["This path was selected directly, so no detector vouched for what it holds."],
    };
  }

  if (request.replacePath !== undefined) {
    return {
      failure: failure(
        "invalid-input",
        "'--replace' names a second path, so it goes with '--path' rather than with a finding.",
      ),
    };
  }
  if (request.findingId === undefined) {
    return { failure: failure("invalid-input", "Planning needs a finding ID or a --path.") };
  }

  const summary = await dependencies.footprint.discover({ measureSizes: true }, signal);
  const found = summary.findings.find((finding) => finding.id === request.findingId);
  if (found === undefined) {
    return {
      failure: failure(
        "invalid-input",
        `No finding called '${request.findingId}' was discovered. Run 'disktop clean' to see what is there now.`,
      ),
    };
  }
  return fromFinding(found);
}

function fromFinding(finding: Finding): Subject | { readonly failure: OperationFailure } {
  if (finding.paths.length === 0) {
    return {
      failure: failure(
        "invalid-plan",
        `${finding.id} names a manager's own state rather than paths, and manager cleanup is not implemented yet.`,
      ),
    };
  }
  if (finding.availableActionIds.length === 0) {
    return {
      failure: failure(
        "invalid-plan",
        `${finding.id} is reported for information; the detector offers no action on it.`,
      ),
    };
  }

  const warnings = [...finding.evidence];
  if (finding.active) {
    warnings.push(
      "This data is in use. Removing it may interrupt the program holding it or lose work in progress.",
    );
  }
  if (finding.confidence !== "observed") {
    warnings.push(`The detector is ${finding.confidence} rather than certain about this finding.`);
  }

  return {
    paths: finding.paths,
    providerId: finding.providerId,
    findingId: finding.id,
    ...(finding.regenerationCost === undefined
      ? {}
      : { regenerationCost: finding.regenerationCost }),
    warnings,
  };
}

/**
 * The context the protected-path policy judges against.
 *
 * It fails closed by construction: `classifyGenericTarget` refuses everything
 * when the mount list is empty, so an inventory nobody could read refuses every
 * plan rather than skipping the mount-root rule.
 */
async function protectedPathContext(
  dependencies: PlanDependencies,
): Promise<ProtectedPathContext | undefined> {
  const inventory = await dependencies.inventory.list();
  const mountRoots = inventory.filesystems.flatMap((filesystem) => [...filesystem.mounts]);
  if (mountRoots.length === 0) {
    return undefined;
  }
  return {
    homeDirectory: dependencies.settings.home,
    allowedRoots: dependencies.settings.allowedRoots,
    mountRoots,
    excludedRoots: dependencies.settings.excludedRoots,
  };
}

/**
 * Measured bytes per path, leaving out anything nothing could measure.
 *
 * A measurement that comes back unknown is absent from the map rather than
 * zero, so the caller can say so instead of reporting an empty directory.
 */
async function measure(
  dependencies: PlanDependencies,
  paths: readonly RawPath[],
  signal: AbortSignal,
): Promise<ReadonlyMap<string, bigint>> {
  const measured = new Map<string, bigint>();
  try {
    const reading = await dependencies.footprints.measure(paths, signal);
    for (const measurement of reading.measurements) {
      if (measurement.bytes !== undefined) {
        measured.set(measurement.path.bytesBase64, measurement.bytes);
      }
    }
  } catch {
    // A measurement that could not run leaves every footprint unknown. The
    // plan still describes exactly which entries it covers.
  }
  return measured;
}

function toEntry(path: RawPath, facts: PathFacts, measuredBytes: bigint | undefined): PlannedEntry {
  return {
    path,
    expected: {
      device: facts.device,
      inode: facts.inode,
      mountId: facts.mountId,
      kind: facts.kind as "file" | "directory" | "symlink",
      apparentBytes: facts.apparentBytes,
      // A restored archive or a network filesystem can hand back a timestamp
      // before the epoch. The helper clamps those to zero, and a plan that
      // carried a negative one would compare against a number the other side
      // cannot hold, after failing to serialise on the way out.
      modifiedNanoseconds:
        facts.modifiedNanoseconds < 0n ? 0n : facts.modifiedNanoseconds,
    },
    // What a person is told they are reclaiming is what was measured on disk,
    // not what the files claim to be. For a directory that means its whole
    // subtree; one stat would only describe its own inode.
    reviewedBytes: measuredBytes ?? facts.allocatedBytes,
  };
}

const INSPECT_FAILURES: Readonly<Record<string, OperationFailure["code"]>> = {
  "protected-path": "protected-path",
  "permission-denied": "permission-denied",
  "changed-target": "changed-target",
  cancelled: "cancelled",
};

async function withSubtrees(
  dependencies: PlanDependencies,
  entries: readonly PlannedEntry[],
  signal: AbortSignal,
): Promise<{ readonly entries: readonly PlannedEntry[] } | { readonly failure: OperationFailure }> {
  const directories = entries.filter((entry) => entry.expected.kind === "directory");
  if (directories.length === 0) {
    return { entries };
  }
  let answers: ReadonlyMap<string, InspectOutcome>;
  try {
    answers = await dependencies.inspect.inspect(
      directories.map((entry) => entry.path),
      signal,
    );
  } catch (error) {
    const explanation =
      error instanceof CapabilityUnavailable ? error.capability.explanation : String(error);
    return {
      failure: failure(
        "unsupported",
        `What is inside a directory could not be recorded, so it was not planned: ${explanation}`,
      ),
    };
  }
  const reviewed: PlannedEntry[] = [];
  for (const entry of entries) {
    if (entry.expected.kind !== "directory") {
      reviewed.push(entry);
      continue;
    }
    const answer = answers.get(entry.path.bytesBase64);
    if (answer === undefined || answer.kind === "refused") {
      return {
        failure: failure(
          answer === undefined ? "internal-error" : (INSPECT_FAILURES[answer.code] ?? "invalid-plan"),
          `${entry.path.display} cannot be reviewed: ${answer === undefined ? "the helper did not answer for it" : answer.message}`,
        ),
      };
    }
    reviewed.push({ ...entry, subtree: answer.subtree });
  }
  return { entries: reviewed };
}

function scopeSummary(entries: readonly PlannedEntry[]): string {
  const directories = entries.filter((entry) => entry.expected.kind === "directory").length;
  const others = entries.length - directories;
  const parts: string[] = [];
  if (directories > 0) {
    parts.push(`${directories} ${directories === 1 ? "directory" : "directories"}`);
  }
  if (others > 0) {
    parts.push(`${others} ${others === 1 ? "entry" : "entries"}`);
  }
  const first = entries[0];
  return `${parts.join(" and ")}, starting at ${first === undefined ? "nothing" : first.path.display}`;
}

function refuse(code: OperationFailure["code"], message: string): PlanOutcome {
  return { kind: "refused", failure: failure(code, message) };
}

function failure(code: OperationFailure["code"], message: string): OperationFailure {
  return { code, message };
}
