import type { Capability, Filesystem, StorageDevice, Warning } from "../domain/models.js";

export interface InventoryResult {
  readonly devices: readonly StorageDevice[];
  readonly filesystems: readonly Filesystem[];
  readonly warnings: readonly Warning[];
  readonly capability: Capability;
}

export interface InventoryPort {
  list(): Promise<InventoryResult>;
}
