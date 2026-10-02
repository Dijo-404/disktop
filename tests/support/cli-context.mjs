/** A CLI context backed by fixed readings, so a test never depends on the host's disks. */

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
    startupWarnings: overrides.startupWarnings ?? [],
    signals: { listen() {}, stop() {} },
    resolvePath: (path) => (path === "." ? "/home/example/projects" : path),
    now: () => new Date("2026-09-29T08:15:04.117Z"),
    interactive: overrides.interactive ?? false,
    async launchTui(settings) {
      context.launched += 1;
      context.launchedWithUnits = settings.units;
      return 0;
    },
    captured,
    launched: 0,
    launchedWithUnits: undefined,
  };
  return context;
}
