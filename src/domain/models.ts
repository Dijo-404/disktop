/** Filesystem identifiers and byte counts stay lossless in application memory. */
export type Bytes = bigint;

/** `bytesBase64` is the authority for filesystem operations; `display` is UI-only. */
export interface RawPath {
  readonly bytesBase64: string;
  readonly display: string;
  readonly utf8?: string;
}

export type CapabilityStatus =
  | "available"
  | "missing-tool"
  | "permission-denied"
  | "unsupported-kernel"
  | "unsupported-filesystem"
  | "unsupported-architecture";

export interface Capability {
  readonly status: CapabilityStatus;
  readonly explanation: string;
}

export interface StorageDevice {
  readonly id: string;
  readonly name: string;
  readonly kind: "ssd" | "hdd" | "unknown";
  readonly removable: boolean;
  readonly partitions: readonly string[];
}

export interface Filesystem {
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly mounts: readonly string[];
  readonly totalBytes: Bytes;
  readonly freeBytes: Bytes;
  readonly availableBytes: Bytes;
  readonly totalInodes?: bigint;
  readonly freeInodes?: bigint;
  readonly network: boolean;
  readonly removable: boolean;
}

export interface ScanCompleteness {
  readonly complete: boolean;
  readonly scannedEntries: bigint;
  readonly inaccessibleDirectories: bigint;
  readonly excludedMounts: readonly string[];
  readonly warnings: readonly string[];
}

export interface IndexedEntry {
  readonly id: string;
  readonly parentId?: string;
  readonly path: RawPath;
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly device: bigint;
  readonly inode: bigint;
  readonly mountId: string;
  readonly linkCount: bigint;
  readonly apparentBytes: Bytes;
  readonly allocatedBytes: Bytes;
  readonly ownerId: bigint;
  readonly modifiedNanoseconds: bigint;
}

export interface Finding {
  readonly id: string;
  readonly providerId: string;
  readonly category: string;
  readonly title: string;
  readonly evidence: readonly string[];
  readonly estimatedBytes?: Bytes;
  readonly capability: Capability;
  readonly availableActionIds: readonly string[];
}
