import type { Capability, Filesystem, RawPath, StorageDevice, Warning } from "../domain/models.js";

export interface InventoryResult {
  readonly devices: readonly StorageDevice[];
  readonly filesystems: readonly Filesystem[];
  readonly warnings: readonly Warning[];
  readonly capability: Capability;
}

export interface InventoryPort {
  list(): Promise<InventoryResult>;
  /**
   * The options the kernel reports for the mount holding this path.
   *
   * `undefined` when the mount table could not be read, which is a different
   * answer from an empty list: one is "nobody looked", the other is "there is
   * nothing unusual here". A caller that collapses the two would tell somebody
   * their access times are reliable on the strength of a reading that failed.
   *
   * This is a separate call rather than a field on `Filesystem` because the
   * options belong to a mount, not to a filesystem: one filesystem can be
   * mounted twice with different options, and the answer depends on which of
   * those mounts holds the path being asked about.
   */
  mountOptionsFor(path: RawPath): Promise<readonly string[] | undefined>;
}
