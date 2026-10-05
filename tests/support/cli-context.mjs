/** A CLI context backed by fixed readings, so a test never depends on the host's disks. */
import { createReportService } from "../../dist/application/report.js";

export function rawPath(display) {
  return { bytesBase64: Buffer.from(display, "utf8").toString("base64"), display, utf8: display };
}

export const ROOT_FILESYSTEM = {
  id: "fs-259-2",
  type: "ext4",
  source: "/dev/nvme0n1p2",
  mounts: [rawPath("/"), rawPath("/home")],
  totalBytes: 1_000_000_000_000n,
  freeBytes: 500_000_000_000n,
  availableBytes: 450_000_000_000n,
  totalInodes: 61_054_976n,
  freeInodes: 58_120_993n,
  network: false,
  removable: false,
  readOnly: false,
  deviceId: "nvme0n1",
};

export const REMOVABLE_FILESYSTEM = {
  id: "fs-8-17",
  type: "exfat",
  source: "/dev/sdb1",
  mounts: [rawPath("/media/usb")],
  totalBytes: 31_020_023_808n,
  freeBytes: 9_932_111_872n,
  availableBytes: 9_932_111_872n,
  network: false,
  removable: true,
  readOnly: false,
  deviceId: "sdb",
};

export const FIXTURE_DEVICES = [
  {
    id: "nvme0n1",
    name: "nvme0n1",
    kind: "unknown",
    removable: false,
    sizeBytes: 1_000_204_886_016n,
    model: "Example NVMe 1TB",
    transport: "nvme",
    partitions: ["nvme0n1p1", "nvme0n1p2"],
  },
  { id: "sdb", name: "sdb", kind: "hdd", removable: true, sizeBytes: 31_029_460_992n, transport: "usb", partitions: ["sdb1"] },
];

export const FIXTURE_VIEW = {
  capability: { status: "available", explanation: "lsblk, mountinfo, and statfs all responded." },
  devices: FIXTURE_DEVICES,
  filesystems: [ROOT_FILESYSTEM, REMOVABLE_FILESYSTEM],
  unmounted: [
    { id: "nvme0n1p3", devicePath: "/dev/nvme0n1p3", deviceId: "nvme0n1", sizeBytes: 547_094_528_000n, filesystemType: "ntfs", label: "Windows-SSD", state: "unmounted" },
    { id: "sdc2", devicePath: "/dev/sdc2", deviceId: "sdc", sizeBytes: 4_095_729_467_392n, filesystemType: "crypto_LUKS", state: "locked" },
  ],
  alerts: [],
  warnings: [],
  complete: true,
};

export const FIXTURE_SCAN = {
  scanId: "scan-1759190400-0a1b2c3d",
  accounting: "allocated",
  roots: [rawPath("/home/example/projects")],
  completeness: { complete: true, scannedEntries: 431204n, inaccessibleDirectories: 0n, excludedMounts: [], warnings: [] },
  totals: { allocatedBytes: 91_268_055_040n, apparentBytes: 90_993_422_336n, sharedBytes: 2_097_152n },
};

export const FIXTURE_ENTRY = {
  id: "9182",
  parentId: "41",
  path: rawPath("/home/example/projects/node_modules"),
  kind: "directory",
  device: 2049n,
  inode: 1_442_113n,
  mountId: "29",
  linkCount: 14n,
  apparentBytes: 19_756_775_424n,
  allocatedBytes: 19_757_268_992n,
  ownerId: 1000n,
  modifiedNanoseconds: 1_759_190_400_123_456_789n,
  shared: false,
};

export const FIXTURE_SNAPSHOT = {
  version: 1,
  id: "snap-2026-09-29T08-15-04-117Z-0a1b2c3d",
  scanId: FIXTURE_SCAN.scanId,
  scannedAt: "2026-09-29T08:15:04.117Z",
  scope: {
    roots: FIXTURE_SCAN.roots,
    excludes: [rawPath("/proc")],
    accounting: "allocated",
    crossFilesystems: false,
    filesystems: ["fs-259-2"],
  },
  totals: FIXTURE_SCAN.totals,
  completeness: FIXTURE_SCAN.completeness,
  directories: [{ path: FIXTURE_ENTRY.path, allocatedBytes: 19_757_268_992n, apparentBytes: 19_756_775_424n, entries: 0n }],
};

/** Storage services backed by fixed readings, so no test touches a real disk. */
function fakeStorage(overrides = {}, recorded = {}) {
  const snapshots = overrides.snapshots ?? [FIXTURE_SNAPSHOT];
  return {
    scan: {
      async run(roots, scanOverrides, signal, onProgress) {
        recorded.scanOverrides = scanOverrides;
        onProgress?.({ scannedEntries: 1000n, processedBytes: 4096n, inaccessibleDirectories: 0n });
        return overrides.scanOutcome ?? { kind: "scanned", summary: { ...FIXTURE_SCAN, roots } };
      },
    },
    explore: {
      async page(query) {
        return (
          overrides.explorePage ?? {
            kind: "page",
            page: { entries: [FIXTURE_ENTRY], ...(query.includeTypeTotals === true ? { typeTotals: [{ extension: "log", entries: 12n, allocatedBytes: 4096n, apparentBytes: 4000n }] } : {}) },
          }
        );
      },
    },
    snapshots: {
      async record() {
        return FIXTURE_SNAPSHOT;
      },
      async list() {
        return snapshots;
      },
      async latestFor() {
        return snapshots[0];
      },
      async diff(earlier, later) {
        return overrides.diff ?? { kind: "missing", id: later ?? earlier };
      },
      async prune() {
        return 0;
      },
    },
    elevated: {
      async recorded() {
        return overrides.elevatedRecord;
      },
      async unreadable() {
        return { paths: [], more: false };
      },
      async measure(snapshot, options) {
        recorded.elevated = { scanId: snapshot.scanId, interactive: options.interactive };
        return overrides.elevatedOutcome ?? { kind: "nothing-unreadable" };
      },
    },
    defaults: {
      accounting: "allocated",
      crossFilesystems: false,
      excludes: [rawPath("/proc")],
      retention: { keepLatest: 20 },
    },
    async filesystemsUnder() {
      return ["fs-259-2"];
    },
  };
}

/**
 * Ctrl+C as a test drives it: `interrupt()` calls whatever a command is
 * listening with, and `listening()` says how many listeners are still
 * registered, which must be none once the command has returned.
 */
export function interruptSource() {
  const handlers = new Set();
  return {
    listen: (handler) => handlers.add(handler),
    stop: (handler) => handlers.delete(handler),
    interrupt: () => {
      for (const handler of [...handlers]) {
        handler();
      }
    },
    listening: () => handlers.size,
  };
}

export function fakeContext(overrides = {}) {
  const view = overrides.view ?? FIXTURE_VIEW;
  const captured = { stdout: "", stderr: "" };
  const recorded = {};
  const context = {
    version: "1.2.3",
    output: {
      stdout: (message) => { captured.stdout += message; },
      stderr: (message) => { captured.stderr += message; },
    },
    settings: { units: "iec", thresholds: { spacePercent: 90, inodePercent: 90 } },
    dashboard: {
      async dashboard() {
        const { devices, ...rest } = view;
        void devices;
        return rest;
      },
      async inventory() {
        return view;
      },
    },
    storage: overrides.storage ?? fakeStorage(overrides, recorded),
    // Every handler receives the action pipeline; a test that does not exercise
    // it still has to be handed one, because no handler may reach around it.
    actions: overrides.actions ?? {
      async plan() {
        return { kind: "refused", failure: { code: "invalid-input", message: "No finding was discovered." } };
      },
      async apply() {
        return { kind: "refused", failure: { code: "invalid-plan", message: "No reviewed plan is stored." } };
      },
      async history() {
        return { records: [], reconciled: 0n };
      },
      async restore() {
        return { kind: "refused", failure: { code: "invalid-input", message: "No action is in the journal." } };
      },
      async find() {
        return { kind: "found", entries: [] };
      },
    },
    recorded,
    // The real report service over these same fake readings; only the file it
    // would write is kept in memory, in `written`, unless a test hands it a
    // port of its own.
    report: undefined,
    written: [],
    startupWarnings: overrides.startupWarnings ?? [],
    signals: interruptSource(),
    resolvePath: (path) => (path === "." ? "/home/example/projects" : path),
    now: () => new Date("2026-09-29T08:15:04.117Z"),
    interactive: overrides.interactive ?? false,
    progress: overrides.progress ?? false,
    async launchTui(settings) {
      context.launched += 1;
      context.launchedWithUnits = settings.units;
      return 0;
    },
    captured,
    launched: 0,
    launchedWithUnits: undefined,
  };
  context.report =
    overrides.report ??
    createReportService({
      dashboard: context.dashboard,
      snapshots: context.storage.snapshots,
      explore: context.storage.explore,
      // Read late, so a test that sets `context.footprint` afterwards is heard.
      footprint: { discover: (request, signal) => context.footprint.discover(request, signal) },
      files: overrides.reportFiles ?? memoryReportFiles(context.written),
      effectiveUserId: overrides.effectiveUserId ?? 1000,
    });
  return context;
}

/** A report file port that keeps what it was given and refuses a name twice. */
export function memoryReportFiles(written = []) {
  const taken = (target) => written.some((file) => file.target.bytesBase64 === target.bytesBase64);
  const exists = (target) => ({
    kind: "refused",
    failure: { code: "invalid-input", message: `${target.display} already exists.` },
  });
  return {
    async check(target) {
      return taken(target) ? exists(target) : { kind: "clear" };
    },
    async createExclusive(target, content) {
      if (taken(target)) {
        return exists(target);
      }
      written.push({ target, text: Buffer.from(content).toString("utf8") });
      return { kind: "written", bytesWritten: BigInt(content.byteLength), warnings: [] };
    },
  };
}
