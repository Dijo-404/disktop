/** A CLI context backed by fixed readings, so a test never depends on the host's disks. */

function rawPath(display) {
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

export function fakeContext(overrides = {}) {
  const view = overrides.view ?? FIXTURE_VIEW;
  const captured = { stdout: "", stderr: "" };
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
