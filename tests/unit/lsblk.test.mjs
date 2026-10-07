import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceKindOf, parseLsblk } from "../../dist/platform/linux/inventory/lsblk.js";

const SAMPLE = JSON.stringify({
  blockdevices: [
    {
      name: "nvme0n1",
      kname: "nvme0n1",
      type: "disk",
      size: 1000204886016,
      rota: false,
      rm: false,
      model: "Example NVMe 1TB",
      tran: "nvme",
      "maj:min": "259:0",
      pkname: null,
      children: [
        { name: "nvme0n1p1", kname: "nvme0n1p1", type: "part", size: 536870912, rota: false, rm: false, "maj:min": "259:1", pkname: "nvme0n1" },
        { name: "nvme0n1p2", kname: "nvme0n1p2", type: "part", size: 999667990528, rota: false, rm: false, "maj:min": "259:2", pkname: "nvme0n1" },
      ],
    },
    { name: "sda", kname: "sda", type: "disk", size: 4000787030016, rota: true, rm: false, tran: "sata", "maj:min": "8:0" },
    { name: "loop0", kname: "loop0", type: "loop", size: 129654784, rota: false, rm: false, "maj:min": "7:0" },
  ],
});

test("the nested tree flattens to one row per device, partitions included", () => {
  const { devices, warnings } = parseLsblk(SAMPLE);
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    devices.map((device) => device.name),
    ["nvme0n1", "nvme0n1p1", "nvme0n1p2", "sda", "loop0"],
  );
  assert.equal(devices[0].sizeBytes, 1000204886016n);
  assert.equal(devices[1].parentName, "nvme0n1");
});

test("rotation decides the kind, and its absence means unknown rather than a guess", () => {
  const { devices } = parseLsblk(SAMPLE);
  assert.equal(deviceKindOf(devices[0]), "ssd");
  assert.equal(deviceKindOf(devices[3]), "hdd");

  const noRotation = parseLsblk(JSON.stringify({ blockdevices: [{ name: "vda", type: "disk", size: 1, rota: null }] }));
  assert.equal(deviceKindOf(noRotation.devices[0]), "unknown");
});

test("booleans are read whether lsblk writes them as JSON booleans or as strings", () => {
  const { devices } = parseLsblk(
    JSON.stringify({ blockdevices: [{ name: "sdb", type: "disk", size: 8, rota: "1", rm: "1" }] }),
  );
  assert.equal(devices[0].removable, true);
  assert.equal(deviceKindOf(devices[0]), "hdd");
});

test("a SIZE numeric token above 2^53 survives before JSON rounds it", () => {
  const { devices, warnings } = parseLsblk('{"blockdevices":[{"name":"huge","type":"disk","size":9007199254740993}]}');
  assert.equal(devices[0].sizeBytes, 9007199254740993n);
  assert.deepEqual(warnings, []);
});

test("exponents, negative sizes and fractional sizes are refused instead of guessed", () => {
  for (const size of ["1e3", "-1", "1.5"]) {
    const { devices, warnings } = parseLsblk(`{"blockdevices":[{"name":"huge","type":"disk","size":${size}}]}`);
    assert.deepEqual(devices, []);
    assert.equal(warnings[0].code, "lsblk-unreadable-size");
  }
});

test("unusable output produces a warning and no invented topology", () => {
  assert.equal(parseLsblk("not json").warnings[0].code, "lsblk-invalid-json");
  assert.equal(parseLsblk("{}").warnings[0].code, "lsblk-unexpected-shape");
  assert.deepEqual(parseLsblk("not json").devices, []);
});

test("shared block nodes are emitted once with all kernel-name parents", () => {
  const child = { name: "friendly-name", kname: "dm-0", type: "crypt", size: 1 };
  const result = parseLsblk(JSON.stringify({ blockdevices: [
    { name: "disk-a", kname: "sda", type: "disk", size: 2, children: [child] },
    { name: "disk-b", kname: "sdb", type: "disk", size: 2, children: [child] },
  ] }));
  assert.equal(result.devices.filter((device) => device.kernelName === "dm-0").length, 1);
  assert.deepEqual(result.devices.find((device) => device.kernelName === "dm-0").parentNames, ["sda", "sdb"]);
});
