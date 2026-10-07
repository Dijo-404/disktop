import { readFile } from "node:fs/promises";
import type { Capability, Filesystem, RawPath, StorageDevice, StorageVolume, UnmountedVolume, Warning } from "../../../domain/models.js";
import { isWithin, pathBytes } from "../../../domain/paths.js";
import type { InventoryPort, InventoryResult } from "../../../ports/inventory.js";
import { LSBLK_ARGUMENTS, deviceKindOf, isMemoryBackedDevice, parseLsblk, type BlockDevice } from "./lsblk.js";
import { filesystemIdOf, parseMountinfo, type MountEntry } from "./mountinfo.js";
import { isLoopImage, isNetworkFilesystem, isPseudoFilesystem, isWindowsMount } from "./filesystem-kinds.js";
import { runFixedCommand, type CommandOutcome } from "../process.js";
import { createStatfsReader } from "./statfs.js";

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
  statfs: createStatfsReader(),
  async detectWindowsSubsystem() {
    try {
      return /microsoft|wsl/i.test(await readFile(VERSION_PATH, "utf8"));
    } catch {
      return false;
    }
  },
};

export interface InventoryOptions {
  /** How long one statfs may take before its mount is left out. */
  readonly statfsTimeoutMilliseconds?: number;
}

const STATFS_TIMEOUT_MILLISECONDS = 5_000;

export function createLinuxInventory(
  sources: InventorySources = linuxInventorySources,
  options: InventoryOptions = {},
): InventoryPort {
  const capacity: CapacityReader = {
    sources,
    timeoutMilliseconds: options.statfsTimeoutMilliseconds ?? STATFS_TIMEOUT_MILLISECONDS,
    pending: new Map(),
    stuck: new Set(),
  };
  return {
    list: () => collect(capacity),
    mountOptionsFor: (path) => mountOptionsFor(sources, path),
  };
}

/**
 * statfs with a bound, and a memory of the mounts that did not answer.
 *
 * statfs on a hard NFS mount whose server has gone blocks in the kernel, and
 * Node cannot cancel it: the call holds one of libuv's few worker threads until
 * the kernel lets go. The reading therefore gives up on it after a bound, and a
 * mount still stuck is not asked again in this process, because every repeat
 * would take another worker and eventually every file operation would wait.
 */
interface CapacityReader {
  readonly sources: InventorySources;
  readonly timeoutMilliseconds: number;
  /** Mount points, by their bytes, whose statfs has not returned yet. */
  readonly stuck: Set<string>;
  readonly pending: Map<string, Promise<CapacityReading>>;
}

type CapacityReading =
  | { readonly kind: "read"; readonly reading: StatfsReading }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "timed-out" };

async function readCapacity(reader: CapacityReader, mountPoint: RawPath): Promise<CapacityReading> {
  const key = mountPoint.bytesBase64;
  if (reader.stuck.has(key)) {
    return { kind: "timed-out" };
  }
  let pending = reader.pending.get(key);
  if (pending === undefined) {
    pending = reader.sources.statfs(pathBytes(mountPoint)).then(
    (reading): CapacityReading => ({ kind: "read", reading }),
    (error: unknown): CapacityReading => (error as NodeJS.ErrnoException).code === "ETIMEDOUT"
      ? { kind: "timed-out" } : { kind: "failed", error },
    );
    reader.pending.set(key, pending);
    const current = pending;
    // A concurrent inventory shares this reading. It is considered stuck
    // only after its timeout, rather than while a healthy call is in flight.
    void pending.finally(() => {
      if (reader.pending.get(key) === current) reader.pending.delete(key);
      reader.stuck.delete(key);
    });
  }

  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<CapacityReading>((resolve) => {
    timer = setTimeout(() => {
      reader.stuck.add(key);
      resolve({ kind: "timed-out" });
    }, reader.timeoutMilliseconds);
  });
  try {
    return await Promise.race([pending, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The options of the deepest mount point containing this path.
 *
 * Deepest wins because mounts nest: `/home/example/work` mounted inside `/home`
 * answers for paths under it, and the options that matter are the ones the
 * kernel is actually applying to the file.
 */
async function mountOptionsFor(
  sources: InventorySources,
  path: RawPath,
): Promise<readonly string[] | undefined> {
  let mounts: readonly MountEntry[];
  try {
    mounts = parseMountinfo(await sources.readMountinfo()).mounts;
  } catch {
    return undefined;
  }
  if (mounts.length === 0) {
    return undefined;
  }

  const target = pathBytes(path);
  let best: MountEntry | undefined;
  for (const mount of mounts) {
    const point = pathBytes(mount.mountPoint);
    if (!isWithin(point, target)) {
      continue;
    }
    if (best === undefined || point.length > pathBytes(best.mountPoint).length) {
      best = mount;
    }
  }
  // Options are the mount's own; `superOptions` belong to the superblock and
  // say the same thing for atime on every filesystem that reports it, so both
  // are offered and the caller reads whichever names what it is looking for.
  return best === undefined ? undefined : [...best.options, ...best.superOptions];
}

async function collect(capacity: CapacityReader): Promise<InventoryResult> {
  const sources = capacity.sources;
  const warnings: Warning[] = [];
  const mounts = await readMounts(sources, warnings);
  const blockDevices = await readBlockDevices(sources, warnings);
  const windowsSubsystem = await sources.detectWindowsSubsystem();

  const filesystems = await joinFilesystems(capacity, mounts, blockDevices, windowsSubsystem, warnings);
  const devices = buildDevices(blockDevices.devices);

  return {
    devices,
    volumes: buildVolumes(mounts, blockDevices),
    filesystems,
    unmounted: findUnmounted(mounts, blockDevices),
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
  capacity: CapacityReader,
  mounts: readonly MountEntry[],
  topology: BlockTopology,
  windowsSubsystem: boolean,
  warnings: Warning[],
): Promise<readonly Filesystem[]> {
  const grouped = new Map<string, MountEntry[]>();
  for (const mount of mounts) {
    const sourceDisplay = mount.source.display;
    if (isPseudoFilesystem(mount.filesystemType) || isLoopImage(sourceDisplay)) {
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
    const reading = await firstReadableStatfs(capacity, group, warnings);
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
  capacity: CapacityReader,
  group: readonly MountEntry[],
  warnings: Warning[],
): Promise<StatfsReading | undefined> {
  for (const mount of group) {
    const answer = await readCapacity(capacity, mount.mountPoint);
    if (answer.kind === "read") {
      return answer.reading;
    }
    if (answer.kind === "timed-out") {
      warnings.push({
        code: "statfs-timeout",
        message: `Capacity for this mount did not answer within ${capacity.timeoutMilliseconds} ms, as a network filesystem whose server has gone does; it is left out rather than reported as zero.`,
        path: mount.mountPoint,
      });
      // Every mount in the group is the same filesystem behind the same
      // server; asking through another one would only wait again.
      return undefined;
    }
    warnings.push({
      code: "statfs-unreadable",
      message: `Capacity for this mount could not be read (${describe(answer.error)}); it is left out rather than reported as zero.`,
      path: mount.mountPoint,
    });
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
  return wholeDiskNames(device, byKernelName)[0] ?? device.kernelName;
}

/** lsblk is a graph: one RAID or LVM volume can occur below several physical disks. */
function wholeDiskNames(device: BlockDevice, byKernelName: ReadonlyMap<string, BlockDevice>): readonly string[] {
  const seen = new Set<string>();
  const disks = new Set<string>();
  const pending = [device];
  while (pending.length > 0) {
    const current = pending.pop() as BlockDevice;
    if (seen.has(current.kernelName)) {
      continue;
    }
    seen.add(current.kernelName);
    if (current.type === "disk" || current.type === "rom") {
      if (!isMemoryBackedDevice(current)) {
        disks.add(current.kernelName);
      }
      continue;
    }
    for (const name of [...current.parentNames].reverse()) {
      const parent = byKernelName.get(name);
      if (parent !== undefined) {
        pending.push(parent);
      }
    }
  }
  return [...disks];
}

/** Hardware topology is visible even when capacity cannot be read or a volume is not mounted. */
function buildVolumes(mounts: readonly MountEntry[], topology: BlockTopology): readonly StorageVolume[] {
  const children = new Set(topology.devices.flatMap((device) => [...device.parentNames]));
  const mountsByDevice = new Map<string, MountEntry[]>();
  for (const mount of mounts) {
    const device = backingDevice(mount, topology);
    if (device !== undefined) {
      const group = mountsByDevice.get(device.kernelName) ?? [];
      group.push(mount);
      mountsByDevice.set(device.kernelName, group);
    }
  }
  return topology.devices.filter((device) =>
    !isMemoryBackedDevice(device) && device.type !== "loop" &&
    ((device.type !== "disk" && device.type !== "rom") || !children.has(device.kernelName)) &&
    (wholeDiskNames(device, topology.byKernelName).length > 0 || device.parentNames.length === 0),
  ).map((device) => {
    const group = mountsByDevice.get(device.kernelName) ?? [];
    const type = device.filesystemType;
    const state: StorageVolume["state"] = type === "swap" || device.mountPoint === "[SWAP]" ? "swap"
      : group.length > 0 || device.mountPoint !== undefined ? "mounted"
        : children.has(device.kernelName) ? "in-use"
          : type === undefined ? "unknown"
            : ENCRYPTED_CONTAINERS.has(type) ? "locked" : "unmounted";
    const deviceIds = wholeDiskNames(device, topology.byKernelName);
    return {
      id: device.kernelName,
      devicePath: device.path ?? `/dev/${device.kernelName}`,
      deviceId: deviceIds[0] ?? device.kernelName,
      deviceIds,
      type: device.type,
      sizeBytes: device.sizeBytes,
      ...(type === undefined ? {} : { filesystemType: type }),
      ...(device.label === undefined ? {} : { label: device.label }),
      mounts: dedupeMountPoints(group),
      state,
    };
  });
}

/**
 * Partition types that hold a firmware or recovery environment rather than
 * anybody's data: EFI system, Microsoft reserved, Windows recovery, BIOS boot,
 * and Linux swap. A file manager hides them for the same reason.
 */
const SYSTEM_PARTITION_TYPES: ReadonlySet<string> = new Set([
  "c12a7328-f81f-11d2-ba4b-00a0c93ec93b",
  "e3c9e316-0b5c-4db8-817d-f92df00215ae",
  "de94bba4-06d1-4d40-a16a-bfd50179d6ac",
  "21686148-6449-6e6f-744e-656564454649",
  "0657fd6d-a4ab-43c4-84e5-0933c84b4f4f",
  // MBR: EFI system, Windows recovery, and Linux swap.
  "0xef",
  "0x27",
  "0x82",
]);

const ENCRYPTED_CONTAINERS: ReadonlySet<string> = new Set(["crypto_LUKS", "BitLocker"]);

/**
 * Leaves of the block tree that hold data and are not in use.
 *
 * A device is in use when a mount reaches it, when lsblk names a place it is
 * used (swap included), or when anything below it is; a LUKS partition whose
 * opened container holds `/` is therefore in use, and only its container is
 * considered. A device with no filesystem signature is never listed, because
 * nothing says it holds anything at all.
 */
function findUnmounted(mounts: readonly MountEntry[], topology: BlockTopology): readonly UnmountedVolume[] {
  const used = new Set<string>();
  const markUsed = (device: BlockDevice | undefined): void => {
    const seen = new Set<string>();
    const pending = device === undefined ? [] : [device];
    while (pending.length > 0) {
      const current = pending.pop() as BlockDevice;
      if (seen.has(current.kernelName)) {
        continue;
      }
      seen.add(current.kernelName);
      used.add(current.kernelName);
      for (const name of current.parentNames) {
        const parent = topology.byKernelName.get(name);
        if (parent !== undefined) {
          pending.push(parent);
        }
      }
    }
  };
  for (const mount of mounts) {
    markUsed(backingDevice(mount, topology));
  }
  const parents = new Set<string>();
  for (const device of topology.devices) {
    if (device.mountPoint !== undefined) {
      markUsed(device);
    }
    for (const name of device.parentNames) {
      parents.add(name);
    }
  }

  const volumes: UnmountedVolume[] = [];
  for (const device of topology.devices) {
    const type = device.filesystemType;
    if (
      type === undefined ||
      type === "swap" ||
      used.has(device.kernelName) ||
      parents.has(device.kernelName) ||
      isMemoryBackedDevice(device) ||
      device.type === "loop" ||
      device.type === "rom" ||
      (device.partitionType !== undefined && SYSTEM_PARTITION_TYPES.has(device.partitionType))
    ) {
      continue;
    }
    volumes.push({
      id: device.kernelName,
      devicePath: device.path ?? `/dev/${device.kernelName}`,
      deviceId: wholeDiskName(device, topology.byKernelName),
      sizeBytes: device.sizeBytes,
      filesystemType: type,
      ...(device.label === undefined ? {} : { label: device.label }),
      state: ENCRYPTED_CONTAINERS.has(type) ? "locked" : "unmounted",
    });
  }
  return volumes;
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
    .filter((device) => (device.type === "disk" || device.type === "rom") && !isMemoryBackedDevice(device))
    .map((device) => ({
      id: device.kernelName,
      name: device.name,
      kind: device.type === "rom" ? "unknown" : deviceKindOf(device),
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
