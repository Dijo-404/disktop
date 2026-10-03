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
 * Raised when the scan a command was asked about is no longer in the index.
 *
 * The index is a bounded cache that prunes whole scans, so this is an ordinary
 * thing to run into and the answer is to scan again. It is its own type
 * because the alternative — letting it reach a surface as a generic failure —
 * tells somebody that Disktop broke when in fact their cache rolled over.
 */
export class StaleScanIndex extends Error {
  readonly scanId: string;

  constructor(scanId: string, message: string) {
    super(message);
    this.name = "StaleScanIndex";
    this.scanId = scanId;
  }
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

/** Raised before any command runs when Disktop may not start here at all. */
export class StartupRefused extends Error {
  readonly failure: OperationFailure;

  constructor(failure: OperationFailure) {
    super(failure.message);
    this.name = "StartupRefused";
    this.failure = failure;
  }
}
