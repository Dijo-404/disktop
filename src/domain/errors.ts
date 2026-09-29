import type { Capability } from "./models.js";

export type OperationFailureCode =
  | "permission-denied"
  | "unsupported"
  | "changed-target"
  | "protected-path"
  | "incomplete-scan"
  | "cancelled"
  | "invalid-plan"
  | "invalid-input"
  | "not-implemented"
  | "internal-error";

export interface OperationFailure {
  readonly code: OperationFailureCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, string>>;
}


/**
 * Raised when the thing an operation needs is not there: no helper binary, a
 * kernel without the containment the scanner depends on, a denied permission.
 *
 * It carries the capability rather than a message alone, so a surface can say
 * exactly what is missing and why instead of reporting an empty result.
 */
export class CapabilityUnavailable extends Error {
  readonly capability: Capability;

  constructor(capability: Capability) {
    super(capability.explanation);
    this.name = "CapabilityUnavailable";
    this.capability = capability;
  }
}
