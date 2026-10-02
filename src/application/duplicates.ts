import {
  applyKeepRule,
  reclaimableBytes,
  type DuplicateGroup,
  type KeepDecision,
  type KeepRule,
} from "../domain/duplicates.js";
import { CapabilityUnavailable, StaleScanIndex, type OperationFailure } from "../domain/errors.js";
import type { Bytes, Capability, RawPath, Warning } from "../domain/models.js";
import type { DuplicatePort } from "../ports/duplicates.js";

export interface DuplicateRequest {
  readonly scanId: string;
  readonly path: RawPath;
  readonly rule: KeepRule;
  /** Required by, and only by, the `in-path` rule. */
  readonly keepUnder?: RawPath;
  readonly minimumBytes: bigint;
  readonly maximumGroups?: number;
}

export interface DecidedGroup {
  readonly group: DuplicateGroup;
  readonly decision: KeepDecision;
  /** What removing this group's other copies would free. Zero when undecided. */
  readonly reclaimableBytes: Bytes;
}

export type DuplicateOutcome =
  | {
      readonly kind: "found";
      readonly groups: readonly DecidedGroup[];
      readonly reclaimableBytes: Bytes;
      readonly complete: boolean;
      readonly warnings: readonly Warning[];
      readonly candidatesRead: bigint;
      readonly filesHashed: bigint;
    }
  | { readonly kind: "refused"; readonly failure: OperationFailure }
  | { readonly kind: "unavailable"; readonly capability: Capability };

export interface DuplicateService {
  find(request: DuplicateRequest, signal: AbortSignal): Promise<DuplicateOutcome>;
}

/**
 * Groups of identical files, each with the copy a keep rule would keep.
 *
 * Nothing here opens a file or decides to remove one. The helper reads the
 * content and this applies a rule to what came back, so what a person sees is
 * a proposal: which copy would survive, what that would free, and which groups
 * the rule could not decide. Acting on it is a separate, reviewed plan.
 *
 * A group the rule cannot decide stays in the listing with its reason and
 * contributes nothing to the reclaimable total. Dropping it would hide a real
 * duplicate; guessing a keeper for it would answer a question nobody asked.
 */
export function createDuplicateService(port: DuplicatePort): DuplicateService {
  return {
    async find(request, signal) {
      if (request.rule === "in-path" && request.keepUnder === undefined) {
        return {
          kind: "refused",
          failure: {
            code: "invalid-input",
            message:
              "'--keep in-path' needs '--keep-under PATH' to say which directory's copy survives.",
          },
        };
      }

      let reading;
      try {
        reading = await port.groups(
          {
            scanId: request.scanId,
            underPath: request.path,
            minimumBytes: request.minimumBytes,
            ...(request.maximumGroups === undefined
              ? {}
              : { maximumGroups: request.maximumGroups }),
          },
          signal,
        );
      } catch (error) {
        if (error instanceof CapabilityUnavailable) {
          return { kind: "unavailable", capability: error.capability };
        }
        if (error instanceof StaleScanIndex) {
          return {
            kind: "refused",
            failure: {
              code: "invalid-input",
              message: `${error.message} Run 'disktop scan ${request.path.display}' and search again.`,
            },
          };
        }
        throw error;
      }

      const groups: DecidedGroup[] = [];
      let total = 0n;
      for (const group of reading.groups) {
        const decision = applyKeepRule(group, request.rule, request.keepUnder);
        const reclaimable = decision.kind === "decided" ? reclaimableBytes(group) : 0n;
        total += reclaimable;
        groups.push({ group, decision, reclaimableBytes: reclaimable });
      }

      return {
        kind: "found",
        groups,
        reclaimableBytes: total,
        complete: reading.complete,
        warnings: reading.warnings,
        candidatesRead: reading.candidatesRead,
        filesHashed: reading.filesHashed,
      };
    },
  };
}
