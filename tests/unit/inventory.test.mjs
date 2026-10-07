import assert from "node:assert/strict";
import { test } from "node:test";
import { createLinuxInventory } from "../../dist/platform/linux/inventory/index.js";

const MOUNTINFO = [
  // Pseudo filesystems report capacity but hold no disk space.
  "25 30 0:23 / /proc rw,nosuid,relatime shared:5 - proc proc rw",
  "26 30 0:24 / /sys rw,nosuid,relatime shared:6 - sysfs sysfs rw",
  "27 30 0:25 / /dev rw,nosuid shared:7 - devtmpfs udev rw",
  // One ext4 filesystem reached through two mount points.
  "30 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw",
  "48 30 259:2 /home /home rw,relatime shared:2 - ext4 /dev/nvme0n1p2 rw",
  // A separate small filesystem on the same physical disk.
  "52 30 259:1 / /boot/efi ro,relatime shared:9 - vfat /dev/nvme0n1p1 ro",
  // A removable disk.
  "60 30 8:17 / /media/usb rw,relatime shared:11 - exfat /dev/sdb1 rw",
  // A network mount: listed, never counted as local capacity.
  "70 30 0:60 / /mnt/data rw,relatime shared:13 - nfs4 fileserver:/export rw",
  // A Snap revision: real bytes, but already counted inside its backing file.
  "80 30 7:0 / /snap/core/1 ro,nodev,relatime shared:15 - squashfs /dev/loop0 ro",
  // btrfs on LUKS. btrfs reports a synthetic device number, not the block device's.
  "85 30 0:28 /@data /data rw,relatime shared:16 - btrfs /dev/mapper/vault rw,subvol=/@data",
].join("\n");

const LSBLK = JSON.stringify({
  blockdevices: [
    {
      name: "nvme0n1", kname: "nvme0n1", type: "disk", size: 1000204886016, rota: false, rm: false,
      model: "Example NVMe 1TB", tran: "nvme", "maj:min": "259:0",
      children: [
        { name: "nvme0n1p1", kname: "nvme0n1p1", type: "part", size: 536870912, rota: false, rm: false, "maj:min": "259:1", pkname: "nvme0n1" },
        { name: "nvme0n1p2", kname: "nvme0n1p2", type: "part", size: 999667990528, rota: false, rm: false, "maj:min": "259:2", pkname: "nvme0n1" },
      ],
    },
    {
      name: "sdb", kname: "sdb", type: "disk", size: 31029460992, rota: null, rm: true, tran: "usb", "maj:min": "8:16",
      children: [{ name: "sdb1", kname: "sdb1", type: "part", size: 31020023808, rm: true, "maj:min": "8:17", pkname: "sdb" }],
    },
    {
      name: "sdc", kname: "sdc", path: "/dev/sdc", type: "disk", size: 512110190592, rota: false, rm: false, tran: "sata", "maj:min": "8:32",
      children: [
        {
          name: "sdc1", kname: "sdc1", path: "/dev/sdc1", type: "part", size: 512103899136, rm: false, "maj:min": "8:33", pkname: "sdc",
          children: [{ name: "vault", kname: "dm-0", path: "/dev/mapper/vault", type: "crypt", size: 512102850560, rm: false, "maj:min": "254:0", pkname: "sdc1" }],
        },
      ],
    },
    { name: "loop0", kname: "loop0", path: "/dev/loop0", type: "loop", size: 129654784, rota: false, rm: false, "maj:min": "7:0" },
    // zram is a block device backed by memory, not a disk anyone can clean up.
    { name: "zram0", kname: "zram0", path: "/dev/zram0", type: "disk", size: 16482418688, rota: false, rm: false, "maj:min": "253:0" },
  ],
});

const READINGS = new Map([
  ["/", { blockSize: 4096n, blocks: 244_000_000n, freeBlocks: 30_000_000n, availableBlocks: 17_000_000n, totalInodes: 61_054_976n, freeInodes: 58_120_993n }],
  ["/boot/efi", { blockSize: 512n, blocks: 1_046_496n, freeBlocks: 897_472n, availableBlocks: 897_472n, totalInodes: 0n, freeInodes: 0n }],
  ["/media/usb", { blockSize: 4096n, blocks: 7_573_248n, freeBlocks: 2_424_832n, availableBlocks: 2_424_832n, totalInodes: 0n, freeInodes: 0n }],
  ["/mnt/data", { blockSize: 4096n, blocks: 10_000_000n, freeBlocks: 9_000_000n, availableBlocks: 9_000_000n, totalInodes: 100n, freeInodes: 90n }],
  ["/data", { blockSize: 4096n, blocks: 125_000_000n, freeBlocks: 60_000_000n, availableBlocks: 58_000_000n, totalInodes: 0n, freeInodes: 0n }],
]);

function sources(overrides = {}) {
  return {
    readMountinfo: async () => new Uint8Array(Buffer.from(overrides.mountinfo ?? MOUNTINFO, "utf8")),
    runLsblk: async () =>
      overrides.lsblk ?? { capability: { status: "available", explanation: "ok" }, stdout: LSBLK, stderr: "", exitCode: 0 },
    statfs: async (bytes) => {
      const point = Buffer.from(bytes).toString("utf8");
      const reading = (overrides.readings ?? READINGS).get(point);
      if (reading === undefined) {
        const error = new Error("EACCES");
        error.code = "EACCES";
        throw error;
      }
      return reading;
    },
    detectWindowsSubsystem: async () => overrides.wsl ?? false,
  };
}

test("simultaneous inventory refreshes share a healthy capacity probe instead of calling it stuck", async () => {
  let calls = 0;
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const injected = sources({ mountinfo: "30 1 259:2 / / rw - ext4 /dev/nvme0n1p2 rw" });
  injected.statfs = () => { calls += 1; return pending; };
  const inventory = createLinuxInventory(injected, { statfsTimeoutMilliseconds: 500 });
  const first = inventory.list();
  const second = inventory.list();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  finish(READINGS.get("/"));
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.filesystems.length, 1);
    assert.ok(!result.warnings.some((warning) => warning.code === "statfs-timeout"));
  }
});

test("physical disks are counted once and carry their own partitions", async () => {
  const result = await createLinuxInventory(sources()).list();
  assert.deepEqual(result.devices.map((device) => device.id), ["nvme0n1", "sdb", "sdc"]);
  assert.deepEqual(result.devices[0].partitions, ["nvme0n1p1", "nvme0n1p2"]);
  assert.deepEqual(result.devices[1].partitions, ["sdb1"]);
  // A loop device is not a disk a user can fill.
  assert.ok(!result.devices.some((device) => device.id === "loop0"));
});

test("a memory-backed block device is not counted as storage", async () => {
  const result = await createLinuxInventory(sources()).list();
  // zram is type `disk` and not rotational, so without a rule it would read as an SSD.
  assert.ok(!result.devices.some((device) => device.id === "zram0"));
});

test("a filesystem reporting a synthetic device number is still traced to its disk", async () => {
  const result = await createLinuxInventory(sources()).list();
  const vault = result.filesystems.find((filesystem) => filesystem.type === "btrfs");
  // btrfs on LUKS on a partition on a disk: only the disk is a thing to point at.
  assert.equal(vault.deviceId, "sdc");
  assert.equal(vault.totalBytes, 125_000_000n * 4096n);
});

test("a removable disk with no rotation flag is removable and of unknown kind", async () => {
  const result = await createLinuxInventory(sources()).list();
  const usb = result.devices.find((device) => device.id === "sdb");
  assert.equal(usb.removable, true);
  assert.equal(usb.kind, "unknown");
  assert.equal(result.devices[0].kind, "ssd");
});

test("two mounts of one filesystem are one filesystem with two mount points", async () => {
  const result = await createLinuxInventory(sources()).list();
  const root = result.filesystems.find((filesystem) => filesystem.id === "fs-259-2");
  assert.deepEqual(root.mounts.map((mount) => mount.display), ["/", "/home"]);
  // Counting it twice would double this machine's reported capacity.
  assert.equal(result.filesystems.filter((filesystem) => filesystem.id === "fs-259-2").length, 1);
});

test("pseudo filesystems and loop-backed images are left out of the capacity picture", async () => {
  const result = await createLinuxInventory(sources()).list();
  const ids = result.filesystems.map((filesystem) => filesystem.type);
  for (const excluded of ["proc", "sysfs", "devtmpfs", "squashfs"]) {
    assert.ok(!ids.includes(excluded), `${excluded} should not be counted as storage`);
  }
});

test("capacity is block count times block size, in exact bytes", async () => {
  const result = await createLinuxInventory(sources()).list();
  const root = result.filesystems.find((filesystem) => filesystem.id === "fs-259-2");
  assert.equal(root.totalBytes, 244_000_000n * 4096n);
  assert.equal(root.availableBytes, 17_000_000n * 4096n);
  assert.equal(root.totalInodes, 61_054_976n);
});

test("a filesystem reporting no inodes carries no inode fields rather than zeros", async () => {
  const result = await createLinuxInventory(sources()).list();
  const efi = result.filesystems.find((filesystem) => filesystem.id === "fs-259-1");
  assert.equal(efi.totalInodes, undefined);
  assert.equal(efi.freeInodes, undefined);
  assert.equal(efi.readOnly, true);
});

test("a network mount is listed and flagged, not silently dropped", async () => {
  const result = await createLinuxInventory(sources()).list();
  const share = result.filesystems.find((filesystem) => filesystem.type === "nfs4");
  assert.equal(share.network, true);
});

test("a filesystem is linked to the whole disk that backs it", async () => {
  const result = await createLinuxInventory(sources()).list();
  assert.equal(result.filesystems.find((filesystem) => filesystem.id === "fs-259-2").deviceId, "nvme0n1");
  assert.equal(result.filesystems.find((filesystem) => filesystem.id === "fs-8-17").deviceId, "sdb");
});

test("a mount that cannot be measured is warned about and left out, never reported as zero", async () => {
  const readings = new Map(READINGS);
  readings.delete("/media/usb");
  const result = await createLinuxInventory(sources({ readings })).list();
  assert.ok(!result.filesystems.some((filesystem) => filesystem.id === "fs-8-17"));
  assert.ok(result.warnings.some((warning) => warning.code === "statfs-unreadable"));
});

test("a filesystem with several mounts is measured through whichever one is readable", async () => {
  const readings = new Map(READINGS);
  readings.delete("/");
  readings.set("/home", READINGS.get("/"));
  const result = await createLinuxInventory(sources({ readings })).list();
  const root = result.filesystems.find((filesystem) => filesystem.id === "fs-259-2");
  assert.equal(root.totalBytes, 244_000_000n * 4096n);
});

test("without lsblk the capacity picture survives and says the topology does not", async () => {
  const result = await createLinuxInventory(
    sources({ lsblk: { capability: { status: "missing-tool", explanation: "lsblk was not found." }, stdout: "", stderr: "", exitCode: null } }),
  ).list();
  assert.deepEqual(result.devices, []);
  assert.ok(result.filesystems.length > 0);
  assert.equal(result.capability.status, "missing-tool");
  assert.ok(result.warnings.some((warning) => warning.code === "lsblk-unavailable"));
});

test("under WSL a Windows drive is listed with a warning that it is not scanned", async () => {
  const mountinfo = `${MOUNTINFO}\n90 30 0:70 / /mnt/c rw,relatime shared:17 - 9p C:\\ rw`;
  const result = await createLinuxInventory(sources({ mountinfo, wsl: true, readings: new Map(READINGS) })).list();
  assert.ok(result.warnings.some((warning) => warning.code === "windows-mount-not-scanned"));
});

test("an unreadable mountinfo is an explicit unsupported state, not an empty success", async () => {
  const failing = sources();
  failing.readMountinfo = async () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  const result = await createLinuxInventory(failing).list();
  assert.deepEqual(result.filesystems, []);
  assert.equal(result.capability.status, "unsupported-kernel");
  assert.ok(result.warnings.some((warning) => warning.code === "mountinfo-unreadable"));
});

test("a mount whose statfs never answers is left out after a bound, not waited on forever", async () => {
  // A hard NFS mount whose server has gone blocks statfs in the kernel; the
  // dashboard must still answer for every other filesystem.
  const hanging = sources();
  const asked = [];
  hanging.statfs = async (bytes) => {
    const point = Buffer.from(bytes).toString("utf8");
    asked.push(point);
    if (point === "/mnt/data") {
      return new Promise(() => {});
    }
    return READINGS.get(point);
  };
  const inventory = createLinuxInventory(hanging, { statfsTimeoutMilliseconds: 100 });
  const begun = Date.now();
  const result = await inventory.list();
  assert.ok(Date.now() - begun < 2_000, `the inventory waited ${Date.now() - begun} ms`);
  assert.ok(!result.filesystems.some((filesystem) => filesystem.id === "fs-0-60"), "an unanswered mount is not reported");
  assert.ok(result.filesystems.some((filesystem) => filesystem.id === "fs-259-2"), "every other filesystem still is");
  const warning = result.warnings.find((entry) => entry.code === "statfs-timeout");
  assert.ok(warning, "the missing mount is named");
  assert.equal(warning.path.display, "/mnt/data");

  // The stuck call still holds a worker thread, so a second reading in the
  // same process does not ask that mount again and pile up more of them.
  asked.length = 0;
  const again = await inventory.list();
  assert.ok(!asked.includes("/mnt/data"), "a mount still stuck is not asked again");
  assert.ok(again.warnings.some((entry) => entry.code === "statfs-timeout"));
});

test("device and filesystem text from lsblk and mountinfo cannot command a terminal", async () => {
  const hostileLsblk = JSON.stringify({
    blockdevices: [
      {
        name: "sdz", kname: "sdz", path: "/dev/sdz", type: "disk", size: 1000, rota: true, rm: true,
        model: "USB\u001b]0;owned\u0007 Stick\u009b2J", tran: "usb\u001b[31m", "maj:min": "8:240",
        children: [{ name: "sdz1", kname: "sdz1", path: "/dev/sdz1", type: "part", size: 900, rm: true, "maj:min": "8:241", pkname: "sdz" }],
      },
    ],
  });
  const mountinfo = "60 30 8:241 / /media/stick rw,relatime shared:11 - fuse.evil\u001b[2J /dev/sdz1 rw";
  const readings = new Map([["/media/stick", READINGS.get("/media/usb")]]);
  const result = await createLinuxInventory(
    sources({
      mountinfo,
      readings,
      lsblk: { capability: { status: "available", explanation: "ok" }, stdout: hostileLsblk, stderr: "", exitCode: 0 },
    }),
  ).list();

  const [device] = result.devices;
  const [filesystem] = result.filesystems;
  for (const text of [device.model, device.transport, filesystem.type]) {
    assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f]/, JSON.stringify(text));
  }
  assert.equal(filesystem.deviceId, "sdz", "sanitizing does not break the join from mount to disk");

  const { deviceLines, filesystemLines } = await import("../../dist/cli/text.js");
  for (const line of [...deviceLines(result.devices, "iec"), ...filesystemLines(result.filesystems, "iec")]) {
    assert.doesNotMatch(line, /[\u001b\u0007\u009b]/, JSON.stringify(line));
  }
});

// This machine's own layout: Windows beside an encrypted Linux root on one
// disk, and a second disk holding one locked encrypted partition.
const DUAL_BOOT_MOUNTINFO = [
  "30 1 0:28 /@ / rw,relatime shared:1 - btrfs /dev/mapper/root rw,subvolid=256,subvol=/@",
  "48 30 0:28 /@home /home rw,relatime shared:113 - btrfs /dev/mapper/root rw,subvolid=257,subvol=/@home",
  "156 30 259:7 / /boot rw,relatime shared:129 - vfat /dev/nvme0n1p4 rw",
].join("\n");

const DUAL_BOOT_LSBLK = JSON.stringify({
  blockdevices: [
    { name: "zram0", kname: "zram0", path: "/dev/zram0", type: "disk", size: 16520314880, rota: false, rm: false, "maj:min": "253:0", fstype: "swap", mountpoint: "[SWAP]" },
    {
      name: "nvme1n1", kname: "nvme1n1", path: "/dev/nvme1n1", type: "disk", size: 4096805658624, rota: false, rm: false, model: "Lexar SSD ARES 4TB", tran: "nvme", "maj:min": "259:8",
      children: [
        { name: "nvme1n1p1", kname: "nvme1n1p1", path: "/dev/nvme1n1p1", type: "part", size: 1073741824, rm: false, "maj:min": "259:9", pkname: "nvme1n1", fstype: "vfat", parttype: "c12a7328-f81f-11d2-ba4b-00a0c93ec93b" },
        { name: "nvme1n1p2", kname: "nvme1n1p2", path: "/dev/nvme1n1p2", type: "part", size: 4095729467392, rm: false, "maj:min": "259:10", pkname: "nvme1n1", fstype: "crypto_LUKS", parttype: "4f68bce3-e8cd-4db1-96e7-fbcaf984b709" },
      ],
    },
    {
      name: "nvme0n1", kname: "nvme0n1", path: "/dev/nvme0n1", type: "disk", size: 1024209543168, rota: false, rm: false, model: "SAMSUNG MZAL81T0HDLB-00BL2", tran: "nvme", "maj:min": "259:0",
      children: [
        { name: "nvme0n1p1", kname: "nvme0n1p1", path: "/dev/nvme0n1p1", type: "part", size: 272629760, rm: false, "maj:min": "259:1", pkname: "nvme0n1", fstype: "vfat", label: "SYSTEM_DRV", parttype: "c12a7328-f81f-11d2-ba4b-00a0c93ec93b" },
        { name: "nvme0n1p2", kname: "nvme0n1p2", path: "/dev/nvme0n1p2", type: "part", size: 16777216, rm: false, "maj:min": "259:2", pkname: "nvme0n1", parttype: "de94bba4-06d1-4d40-a16a-bfd50179d6ac" },
        { name: "nvme0n1p3", kname: "nvme0n1p3", path: "/dev/nvme0n1p3", type: "part", size: 547094528000, rm: false, "maj:min": "259:3", pkname: "nvme0n1", fstype: "ntfs", label: "Windows-SSD", parttype: "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7" },
        { name: "nvme0n1p4", kname: "nvme0n1p4", path: "/dev/nvme0n1p4", type: "part", size: 1073741824, rm: false, "maj:min": "259:7", pkname: "nvme0n1", fstype: "vfat", parttype: "c12a7328-f81f-11d2-ba4b-00a0c93ec93b", mountpoint: "/boot" },
        { name: "nvme0n1p5", kname: "nvme0n1p5", path: "/dev/nvme0n1p5", type: "part", size: 8589934592, rm: false, "maj:min": "259:5", pkname: "nvme0n1", fstype: "swap", parttype: "0657fd6d-a4ab-43c4-84e5-0933c84b4f4f", mountpoint: "[SWAP]" },
        {
          name: "nvme0n1p6", kname: "nvme0n1p6", path: "/dev/nvme0n1p6", type: "part", size: 467160530944, rm: false, "maj:min": "259:6", pkname: "nvme0n1", fstype: "crypto_LUKS", parttype: "4f68bce3-e8cd-4db1-96e7-fbcaf984b709",
          children: [{ name: "root", kname: "dm-0", path: "/dev/mapper/root", type: "crypt", size: 467143753728, rm: false, "maj:min": "254:0", pkname: "nvme0n1p6", fstype: "btrfs", mountpoint: "/" }],
        },
      ],
    },
  ],
});

test("a partition holding data that nothing has mounted is listed, so its space is not invisible", async () => {
  const result = await createLinuxInventory(
    sources({
      mountinfo: DUAL_BOOT_MOUNTINFO,
      lsblk: { capability: { status: "available", explanation: "ok" }, stdout: DUAL_BOOT_LSBLK, stderr: "", exitCode: 0 },
      readings: new Map([
        ["/", READINGS.get("/")],
        ["/home", READINGS.get("/")],
        ["/boot", READINGS.get("/boot/efi")],
      ]),
    }),
  ).list();

  assert.deepEqual(
    result.unmounted.map((volume) => [volume.id, volume.filesystemType, volume.label, volume.state, volume.deviceId, volume.sizeBytes]),
    [
      ["nvme1n1p2", "crypto_LUKS", undefined, "locked", "nvme1n1", 4095729467392n],
      ["nvme0n1p3", "ntfs", "Windows-SSD", "unmounted", "nvme0n1", 547094528000n],
    ],
    "EFI, recovery, swap, the opened LUKS container, and every mounted partition are left out",
  );
  assert.equal(result.unmounted[1].devicePath, "/dev/nvme0n1p3");
});

test("without lsblk's filesystem columns no partition is guessed to hold data", async () => {
  const result = await createLinuxInventory(sources()).list();
  assert.deepEqual(result.unmounted, []);
});

test("every firmware, recovery, swap and unknown-signature partition is visible across separate SSDs", async () => {
  const result = await createLinuxInventory(sources({
    mountinfo: DUAL_BOOT_MOUNTINFO,
    lsblk: { capability: { status: "available", explanation: "ok" }, stdout: DUAL_BOOT_LSBLK, stderr: "", exitCode: 0 },
    readings: new Map([["/", READINGS.get("/")], ["/boot", READINGS.get("/boot/efi")]]),
  })).list();
  assert.deepEqual(result.devices.map((device) => device.id), ["nvme1n1", "nvme0n1"]);
  assert.deepEqual(result.volumes.map((volume) => volume.id), [
    "nvme1n1p1", "nvme1n1p2", "nvme0n1p1", "nvme0n1p2", "nvme0n1p3", "nvme0n1p4", "nvme0n1p5", "nvme0n1p6", "dm-0",
  ]);
  assert.equal(result.volumes.find((volume) => volume.id === "nvme0n1p2").state, "unknown");
  assert.equal(result.volumes.find((volume) => volume.id === "nvme0n1p5").state, "swap");
  assert.equal(result.volumes.find((volume) => volume.id === "nvme1n1p2").state, "locked");
  assert.equal(result.volumes.find((volume) => volume.id === "nvme0n1p6").state, "in-use");
  assert.deepEqual(result.volumes.find((volume) => volume.id === "dm-0").mounts.map((mount) => mount.display), ["/", "/home"]);
});

test("a mounted partition remains visible when capacity cannot be read", async () => {
  const readings = new Map(READINGS);
  readings.delete("/media/usb");
  const result = await createLinuxInventory(sources({ readings })).list();
  const volume = result.volumes.find((volume) => volume.id === "sdb1");
  assert.equal(volume.state, "mounted");
  assert.deepEqual(volume.mounts.map((mount) => mount.display), ["/media/usb"]);
  assert.equal(volume.availableBytes, undefined, "capacity is never fabricated from partition size");
  assert.ok(result.warnings.some((warning) => warning.code === "statfs-unreadable"));
});

test("optical drives and blank whole disks remain visible without pretending they are SSDs", async () => {
  const lsblk = JSON.stringify({ blockdevices: [
    { name: "sr0", kname: "sr0", type: "rom", size: 0, rota: false, rm: true, tran: "sata" },
    { name: "sdd", kname: "sdd", type: "disk", size: 1024, rota: false, rm: true, tran: "usb" },
  ] });
  const result = await createLinuxInventory(sources({
    lsblk: { capability: { status: "available", explanation: "ok" }, stdout: lsblk, stderr: "", exitCode: 0 },
  })).list();
  assert.deepEqual(result.devices.map((device) => [device.id, device.kind]), [["sr0", "unknown"], ["sdd", "ssd"]]);
  assert.deepEqual(result.volumes.map((volume) => [volume.id, volume.state]), [["sr0", "unknown"], ["sdd", "unknown"]]);
});

test("shared RAID and LVM topology is deduplicated and retains every backing disk", async () => {
  const shared = { name: "archive", kname: "dm-0", path: "/dev/mapper/archive", type: "lvm", size: 2048, "maj:min": "253:0", fstype: "ext4", mountpoint: "/archive" };
  const lsblk = JSON.stringify({ blockdevices: [
    { name: "sda", kname: "sda", type: "disk", size: 4096, children: [{ name: "sda1", kname: "sda1", type: "part", size: 4000, children: [shared] }] },
    { name: "sdb", kname: "sdb", type: "disk", size: 4096, children: [{ name: "sdb1", kname: "sdb1", type: "part", size: 4000, children: [shared] }] },
  ] });
  const result = await createLinuxInventory(sources({
    mountinfo: "30 1 253:0 / /archive rw,relatime - ext4 /dev/mapper/archive rw",
    lsblk: { capability: { status: "available", explanation: "ok" }, stdout: lsblk, stderr: "", exitCode: 0 },
    readings: new Map([["/archive", READINGS.get("/")]]),
  })).list();
  assert.equal(result.volumes.filter((volume) => volume.id === "dm-0").length, 1);
  assert.deepEqual(result.volumes.find((volume) => volume.id === "dm-0").deviceIds, ["sda", "sdb"]);
  assert.equal(result.filesystems.length, 1, "a shared logical filesystem is measured once");
});

test("compressed read-only filesystems on real devices remain visible", async () => {
  const result = await createLinuxInventory(sources({
    mountinfo: "30 1 8:17 / /media/appliance ro - erofs /dev/sdb1 ro",
    readings: new Map([["/media/appliance", READINGS.get("/media/usb")]]),
  })).list();
  assert.equal(result.filesystems[0].type, "erofs");
  assert.equal(result.filesystems[0].deviceId, "sdb");
  assert.equal(result.filesystems[0].readOnly, true);
});
