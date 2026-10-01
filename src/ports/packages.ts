import type { Capability } from "../domain/models.js";

export interface InstalledPackage {
  readonly name: string;
  readonly version?: string;
  /** What the manager says it occupies. Absent when the manager did not say. */
  readonly reportedBytes?: bigint;
}

/**
 * One package manager's answer.
 *
 * A manager that is not installed is a row with its capability and no
 * packages, never an absent row: the difference between "pacman is not here"
 * and "pacman reported nothing" is the difference between a fact about the
 * machine and a reading that failed.
 */
export interface ManagerInventory {
  readonly manager: string;
  readonly capability: Capability;
  readonly packages: readonly InstalledPackage[];
  /** What the manager's own size figure means, for a finding to repeat. */
  readonly sizeMeaning: string;
}

export interface PackageInventoryPort {
  list(): Promise<readonly ManagerInventory[]>;
}
