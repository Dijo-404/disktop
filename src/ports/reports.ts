import type { OperationFailure } from "../domain/errors.js";
import type { RawPath, Warning } from "../domain/models.js";

export type ReportTargetCheck =
  | { readonly kind: "clear" }
  | { readonly kind: "refused"; readonly failure: OperationFailure };

export type ReportWriteOutcome =
  | {
      readonly kind: "written";
      readonly bytesWritten: bigint;
      /**
       * The report is in place, but something around it went wrong: its
       * directory entry could not be flushed, or a staging file could not be
       * removed. Either one is worth saying, and neither undoes the write.
       */
      readonly warnings: readonly Warning[];
    }
  | { readonly kind: "refused"; readonly failure: OperationFailure };

/**
 * Where an exported report goes when it is written to a file.
 *
 * There is no method that replaces a file. A report is published under a name
 * nothing holds yet, or not at all, because the name somebody typed after
 * `--output` can be a file they did not mean to lose.
 */
export interface ReportFilePort {
  /** Refuse early, before the slow part, when the target cannot be created. */
  check(target: RawPath): Promise<ReportTargetCheck>;
  /** Publish complete content under a new name, never over an existing one. */
  createExclusive(target: RawPath, content: Uint8Array): Promise<ReportWriteOutcome>;
}
