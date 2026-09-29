import { readFile, statfs } from "node:fs/promises";
import type { Capability, Filesystem, RawPath, StorageDevice, Warning } from "../../../domain/models.js";
import { pathBytes } from "../../../domain/paths.js";
import type { InventoryPort, InventoryResult } from "../../../ports/inventory.js";
import { LSBLK_ARGUMENTS, deviceKindOf, isMemoryBackedDevice, parseLsblk, type BlockDevice } from "./lsblk.js";
import { filesystemIdOf, parseMountinfo, type MountEntry } from "./mountinfo.js";
import { isLoopImage, isNetworkFilesystem, isPseudoFilesystem, isWindowsMount } from "./filesystem-kinds.js";
import { runFixedCommand, type CommandOutcome } from "../process.js";

const MOUNTINFO_PATH = "/proc/self/mountinfo";
const VERSION_PATH = "/proc/version";

/** Every reading the adapter needs, so the join can be tested without a Linux host. */
export interface InventorySources {
  readMountinfo(): Promise<Uint8Array>;
  runLsblk(): Promise<CommandOutcome>;
  statfs(mountPoint: Uint8Array): Promise<StatfsReading>;
  detectWindowsSubsystem(): Promise<boolean>;
}

export interface StatfsReading {
  readonly blockSize: bigint;
  readonly blocks: bigint;
  readonly freeBlocks: bigint;
  readonly availableBlocks: bigint;
  readonly totalInodes: bigint;
  readonly freeInodes: bigint;
}

export const linuxInventorySources: InventorySources = {
  async readMountinfo() {
    return new Uint8Array(await readFile(MOUNTINFO_PATH));
  },
  async runLsblk() {
    return runFixedCommand("lsblk", LSBLK_ARGUMENTS);
  },
  async statfs(mountPoint) {
    // statfs is given the mount point's bytes, never its display text.
    const reading = await statfs(Buffer.from(mountPoint), { bigint: true });
    return {
      blockSize: reading.bsize,
      blocks: reading.blocks,
      freeBlocks: reading.bfree,
      availableBlocks: reading.bavail,
      totalInodes: reading.files,
      freeInodes: reading.ffree,
    };
  },
  async detectWindowsSubsystem() {
    try {
      return /microsoft|wsl/i.test(await readFile(VERSION_PATH, "utf8"));
    } catch {
      return false;
    }
  },
};

export function createLinuxInventory(sources: InventorySources = linuxInventorySources): InventoryPort {
  return { list: () => collect(sources) };
}

async function collect(sources: InventorySources): Promise<InventoryResult> {
  const warnings: Warning[] = [];
  const mounts = await readMounts(sources, warnings);
  const blockDevices = await readBlockDevices(sources, warnings);
  const windowsSubsystem = await sources.detectWindowsSubsystem();

  const filesystems = await joinFilesystems(sources, mounts, blockDevices, windowsSubsystem, warnings);
  const devices = buildDevices(blockDevices.devices);

  return {
    devices,
    filesystems,
    warnings,
    capability: overallCapability(mounts.length > 0, blockDevices.capability, filesystems.length),
  };
}

async function readMounts(sources: InventorySources, warnings: Warning[]): Promise<readonly MountEntry[]> {
  try {
    const parsed = parseMountinfo(await sources.readMountinfo());
    warnings.push(...parsed.warnings);
    return parsed.mounts;
  } catch (error) {
    warnings.push({
      code: "mountinfo-unreadable",
      message: `${MOUNTINFO_PATH} could not be read (${describe(error)}); no mount or capacity information is available.`,
    });
    return [];
  }
}

interface BlockTopology {
  readonly devices: readonly BlockDevice[];
  readonly byDeviceNumber: ReadonlyMap<string, BlockDevice>;
  /** Keyed by the node under `/dev`, which is how a mount names its source. */
  readonly byPath: ReadonlyMap<string, BlockDevice>;
  readonly byKernelName: ReadonlyMap<string, BlockDevice>;
  readonly capability: Capability;
}

async function readBlockDevices(sources: InventorySources, warnings: Warning[]): Promise<BlockTopology> {
  const outcome = await sources.runLsblk();
  if (outcome.capability.status !== "available") {
    warnings.push({
      code: "lsblk-unavailable",
      message: `Block device topology is unavailable: ${outcome.capability.explanation} Filesystems are still listed from ${MOUNTINFO_PATH}.`,
    });
    return { devices: [], byDeviceNumber: new Map(), byPath: new Map(), byKernelName: new Map(), capability: outcome.capability };
  }

  const parsed = parseLsblk(outcome.stdout);
  warnings.push(...parsed.warnings);

  const byDeviceNumber = new Map<string, BlockDevice>();
  const byPath = new Map<string, BlockDevice>();
  const byKernelName = new Map<string, BlockDevice>();
  for (const device of parsed.devices) {
    if (device.major !== undefined && device.minor !== undefined) {
      byDeviceNumber.set(`${device.major}:${device.minor}`, device);
    }
    byKernelName.set(device.kernelName, device);
    if (device.path !== undefined) {
      byPath.set(device.path, device);
    }
    byPath.set(`/dev/${device.kernelName}`, device);
  }
  return { devices: parsed.devices, byDeviceNumber, byPath, byKernelName, capability: outcome.capability };
}

/**
 * One `Filesystem` per kernel device number, carrying every mount point that
 * reaches it. A bind mount is another way into a filesystem, not another
 * filesystem, and counting it twice would double the reported capacity.
 */
async function joinFilesystems(
  sources: InventorySources,
  mounts: readonly MountEntry[],
  topology: BlockTopology,
  windowsSubsystem: boolean,
  warnings: Warning[],
): Promise<readonly Filesystem[]> {
  const grouped = new Map<string, MountEntry[]>();
  for (const mount of mounts) {
    const sourceDisplay = mount.source.display;
    if (isPseudoFilesystem(mount.filesystemType) || isLoopImage(mount.filesystemType, sourceDisplay)) {
      continue;
    }
    if (windowsSubsystem && isWindowsMount(mount.filesystemType, mount.mountPoint.display)) {
      warnings.push({
        code: "windows-mount-not-scanned",
        message: "A Windows drive is listed but excluded from scans by default under the Windows Subsystem for Linux.",
        path: mount.mountPoint,
      });
    }
    const key = filesystemIdOf(mount);
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, [mount]);
    } else {
      existing.push(mount);
    }
  }

  const filesystems: Filesystem[] = [];
  for (const [id, group] of grouped) {
    const primary = group[0] as MountEntry;
    const reading = await firstReadableStatfs(sources, group, warnings);
    if (reading === undefined) {
      continue;
    }

    const blockDevice = backingDevice(primary, topology);
    const network = isNetworkFilesystem(primary.filesystemType);
    filesystems.push({
      id,
      type: primary.filesystemType,
      source: primary.source.display,
      mounts: dedupeMountPoints(group),
      totalBytes: reading.blocks * reading.blockSize,
      freeBytes: reading.freeBlocks * reading.blockSize,
      availableBytes: reading.availableBlocks * reading.blockSize,
      ...(reading.totalInodes > 0n ? { totalInodes: reading.totalInodes, freeInodes: reading.freeInodes } : {}),
      network,
      removable: blockDevice?.removable ?? false,
      readOnly: group.every((mount) => mount.options.includes("ro")),
      ...(blockDevice === undefined ? {} : { deviceId: wholeDiskName(blockDevice, topology.byKernelName) }),
    });
  }

  return filesystems;
}

async function firstReadableStatfs(
  sources: InventorySources,
  group: readonly MountEntry[],
  warnings: Warning[],
): Promise<StatfsReading | undefined> {
  for (const mount of group) {
    try {
      return await sources.statfs(pathBytes(mount.mountPoint));
    } catch (error) {
      warnings.push({
        code: "statfs-unreadable",
        message: `Capacity for this mount could not be read (${describe(error)}); it is left out rather than reported as zero.`,
        path: mount.mountPoint,
      });
    }
  }
  return undefined;
}

function dedupeMountPoints(group: readonly MountEntry[]): readonly RawPath[] {
  const seen = new Set<string>();
  const points: RawPath[] = [];
  for (const mount of group) {
    if (!seen.has(mount.mountPoint.bytesBase64)) {
      seen.add(mount.mountPoint.bytesBase64);
      points.push(mount.mountPoint);
    }
  }
  return points;
}

/**
 * Find the block device behind a mount.
 *
 * The kernel's device number is the direct answer, but btrfs and ZFS report a
 * synthetic one, so their mounts fall back to matching the source node under
 * `/dev`. Without that, exactly the filesystems this tool cares about most
 * would show no device at all.
 */
function backingDevice(mount: MountEntry, topology: BlockTopology): BlockDevice | undefined {
  return topology.byDeviceNumber.get(`${mount.major}:${mount.minor}`) ?? topology.byPath.get(mount.source.display);
}

/**
 * Walk up to the whole disk, which is what a user counts as a device. A
 * filesystem on LUKS sits on a mapper device, on a partition, on a disk, and
 * only the disk is a thing anyone can point at.
 */
function wholeDiskName(device: BlockDevice, byKernelName: ReadonlyMap<string, BlockDevice>): string {
  const seen = new Set<string>();
  let current = device;
  while (current.type !== "disk") {
    const parentName = current.parentName;
    if (parentName === undefined || seen.has(parentName)) {
      break;
    }
    seen.add(parentName);
    const parent = byKernelName.get(parentName);
    if (parent === undefined) {
      break;
    }
    current = parent;
  }
  return current.kernelName;
}

/** Physical disks only, counted once. Partitions belong to their disk, not beside it. */
function buildDevices(blockDevices: readonly BlockDevice[]): readonly StorageDevice[] {
  const partitionsByParent = new Map<string, string[]>();
  for (const device of blockDevices) {
    if (device.type !== "part") {
      continue;
    }
    const parent = device.parentName;
    if (parent === undefined) {
      continue;
    }
    const existing = partitionsByParent.get(parent);
    if (existing === undefined) {
      partitionsByParent.set(parent, [device.kernelName]);
    } else {
      existing.push(device.kernelName);
    }
  }

  return blockDevices
    .filter((device) => device.type === "disk" && !isMemoryBackedDevice(device))
    .map((device) => ({
      id: device.kernelName,
      name: device.name,
      kind: deviceKindOf(device),
      removable: device.removable,
      sizeBytes: device.sizeBytes,
      ...(device.model === undefined ? {} : { model: device.model }),
      ...(device.transport === undefined ? {} : { transport: device.transport }),
      partitions: partitionsByParent.get(device.kernelName) ?? [],
    }));
}

function overallCapability(haveMounts: boolean, blockCapability: Capability, filesystemCount: number): Capability {
  if (!haveMounts) {
    return { status: "unsupported-kernel", explanation: `${MOUNTINFO_PATH} produced no mounts; this does not look like a running Linux system.` };
  }
  if (blockCapability.status !== "available") {
    return {
      status: blockCapability.status,
      explanation: `${blockCapability.explanation} Capacity is still reported for ${filesystemCount} filesystems; device topology is not.`,
    };
  }
  return { status: "available", explanation: "lsblk, mountinfo, and statfs all responded." };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ?? error.message;
  }
  return "unknown error";
}
