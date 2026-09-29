import type { Capability, Filesystem, StorageDevice } from "../domain/models.js";

export interface InventoryResult {
  readonly devices: readonly StorageDevice[];
  readonly filesystems: readonly Filesystem[];
  readonly warnings: readonly string[];
  readonly capability: Capability;
}

export interface InventoryPort {
  list(): Promise<InventoryResult>;
}
