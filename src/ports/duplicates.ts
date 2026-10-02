import type { DuplicateGroup } from "../domain/duplicates.js";
import type { RawPath, Warning } from "../domain/models.js";

export interface DuplicateQuery {
  readonly scanId: string;
  /** Search this path and everything below it. */
  readonly underPath: RawPath;
  /** Files below this size are not candidates. */
  readonly minimumBytes: bigint;
  readonly maximumGroups?: number;
  readonly maximumFilesPerGroup?: number;
}

export interface DuplicateReading {
  readonly groups: readonly DuplicateGroup[];
  /**
   * False when a cap was reached, a file could not be read, or the search was
   * cancelled. The warnings then say what was missed, and a caller must report
   * the answer as partial rather than as the whole picture.
   */
  readonly complete: boolean;
  readonly warnings: readonly Warning[];
  /** Index rows that shared a size with another file, so had to be considered. */
  readonly candidatesRead: bigint;
  /** Files whose content was actually read. Never more than `candidatesRead`. */
  readonly filesHashed: bigint;
}

/**
 * Reading content is the helper's job, not Node's.
 *
 * Node holds no file open and hashes nothing: it asks for the groups and gets
 * back a bounded answer. The groups it receives are a listing. Acting on one
 * goes through a reviewed plan, which the helper revalidates and byte-compares
 * from its own side.
 */
export interface DuplicatePort {
  groups(query: DuplicateQuery, signal: AbortSignal): Promise<DuplicateReading>;
}
