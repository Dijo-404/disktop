import {
  isExpired,
  requiresAcknowledgement,
  type ActionPlan,
  type ActionResult,
} from "../domain/actions.js";
import { CapabilityUnavailable, type OperationFailure } from "../domain/errors.js";
import type { Capability } from "../domain/models.js";
import type { ActionPort, PlanStore } from "../ports/actions.js";

export interface ApplyRequest {
  readonly planId: string;
  /** The confirmation. `--yes` without a reviewed plan is not one. */
  readonly confirmed: boolean;
  /** Acknowledges a plan that is already irreversible; it never makes one so. */
  readonly acknowledgePermanent?: boolean;
}

export type ApplyOutcome =
  | {
      readonly kind: "applied";
      readonly plan: ActionPlan;
      readonly result: ActionResult;
      /**
       * Free space after minus free space before, when both were readable.
       * Absent rather than zero when they were not: "nothing changed" and
       * "nobody could tell" are different answers.
       */
      readonly observedFreeSpaceChange?: bigint;
      readonly notes: readonly string[];
    }
  | { readonly kind: "refused"; readonly failure: OperationFailure }
  | { readonly kind: "unavailable"; readonly capability: Capability };

export interface ApplyService {
  apply(request: ApplyRequest, signal: AbortSignal): Promise<ApplyOutcome>;
}

export interface ApplyDependencies {
  readonly store: Pick<PlanStore, "get">;
  readonly actions: ActionPort;
  readonly now: () => Date;
  /**
   * The hashes of the cleanup rules as the configuration file holds them now.
   *
   * Absent when the caller has no rules to compare against, which is not the
   * same as a rule having been removed: a surface that never loaded any is a
   * surface with nothing to contradict the plan, and the plan stands.
   */
  readonly currentRuleHashes?: () => ReadonlySet<string>;
}

const CONCURRENCY_NOTE =
  "Other processes write to the same filesystem, so the observed free-space change is not only this action's doing.";

const TRASH_NOTE =
  "A Trash move on the same filesystem usually frees nothing until Trash is emptied.";

/**
 * Commit one reviewed plan, and nothing else.
 *
 * This is the only place a plan becomes an action. Everything it checks, it
 * checks before the helper is asked: that the plan exists, that it has been
 * confirmed, that it has not expired into a description of a filesystem that
 * has moved on, and that an irreversible one has been acknowledged as such. The
 * helper then repeats every per-item check against live descriptors, which is
 * the check that actually protects anything.
 */
export function createApplyService(dependencies: ApplyDependencies): ApplyService {
  return {
    async apply(request, signal) {
      const plan = await dependencies.store.get(request.planId);
      if (plan === undefined) {
        return refuse(
          "invalid-plan",
          `No reviewed plan called '${request.planId}' is stored. Run 'disktop clean plan' first.`,
        );
      }
      if (!request.confirmed) {
        return refuse(
          "invalid-input",
          `Applying ${plan.id} needs --yes. It would ${describe(plan)}.`,
        );
      }
      if (isExpired(plan, dependencies.now())) {
        return refuse(
          "invalid-plan",
          `${plan.id} expired at ${plan.expiresAt} and describes a filesystem that may have moved on. Plan it again.`,
        );
      }

      // A plan from a rule was reviewed against that rule. If the rule has
      // been edited or removed since, the confirmation somebody gave was for a
      // different selection than the one the file now describes, and carrying
      // it over would apply a rule nobody agreed to.
      if (plan.ruleHash !== undefined && dependencies.currentRuleHashes !== undefined) {
        if (!dependencies.currentRuleHashes().has(plan.ruleHash)) {
          return refuse(
            "invalid-plan",
            `${plan.id} was reviewed against a cleanup rule that has since been changed or removed from config.toml. Plan it again so you can see what the rule selects now.`,
          );
        }
      }

      const irreversible = requiresAcknowledgement(plan);
      if (irreversible && request.acknowledgePermanent !== true) {
        return refuse(
          "invalid-plan",
          `${plan.id} removes data permanently. Add --permanent to acknowledge that it cannot be undone.`,
        );
      }
      // The acknowledgement only ever acknowledges. A plan that moves things to
      // Trash stays a Trash plan, because that is what was reviewed.
      if (!irreversible && request.acknowledgePermanent === true) {
        return refuse(
          "invalid-plan",
          `${plan.id} moves its targets to Trash. --permanent acknowledges a plan that is already irreversible; it cannot turn this one into one. Plan the permanent removal instead.`,
        );
      }

      let result: ActionResult;
      try {
        result = await dependencies.actions.apply(plan, signal);
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

      const change =
        result.freeBytesBefore === undefined || result.freeBytesAfter === undefined
          ? undefined
          : result.freeBytesAfter - result.freeBytesBefore;

      const notes = [CONCURRENCY_NOTE];
      if (plan.operation === "trash") {
        notes.unshift(TRASH_NOTE);
      }

      return {
        kind: "applied",
        plan,
        result: { ...result, planId: plan.id },
        ...(change === undefined ? {} : { observedFreeSpaceChange: change }),
        notes,
      };
    },
  };
}

function describe(plan: ActionPlan): string {
  const scope = plan.scopeSummary;
  if (plan.operation === "trash") {
    return `move ${scope} to Trash`;
  }
  return plan.operation === "empty-trash"
    ? `empty ${scope}, which releases everything Disktop has moved there`
    : `remove ${scope} permanently`;
}

function refuse(code: OperationFailure["code"], message: string): ApplyOutcome {
  return { kind: "refused", failure: { code, message } };
}
