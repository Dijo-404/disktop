import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseJournalUsage,
  parseOpenDeleted,
  parseSmartHealth,
  parseSmartScan,
} from "../../dist/platform/linux/diagnostics/parsers.js";

const LSOF = [
  "p1842",
  "cjournald",
  "s1073741824",
  "L0",
  "n/var/log/journal/old.journal (deleted)",
  "s512",
  "L0",
  "n/tmp/scratch file with spaces (deleted)",
  "p9001",
  "cfirefox",
  "s8388608",
  "L0",
  "n/home/example/.cache/mozilla/entry",
  "",
].join("\n");

const SCAN = JSON.stringify({
  devices: [
    { name: "/dev/nvme0n1", type: "nvme" },
    { name: "/dev/sda", type: "sat" },
    { type: "missing name" },
  ],
});

const NVME_HEALTH = JSON.stringify({
  model_name: "Example NVMe 1TB",
  smart_status: { passed: true },
  nvme_smart_health_information_log: { power_on_hours: 8123, percentage_used: 4 },
});

const ATA_HEALTH = JSON.stringify({
  model_name: "Example HDD",
  smart_status: { passed: false },
  ata_smart_attributes: { table: [{ id: 9, raw: { value: 41000 } }, { id: 5, raw: { value: 128 } }] },
});

test("lsof's field format keeps a path that contains spaces", () => {
  const files = parseOpenDeleted(LSOF);

  assert.deepEqual(
    files.map((file) => file.path),
    ["/var/log/journal/old.journal", "/tmp/scratch file with spaces", "/home/example/.cache/mozilla/entry"],
  );
  assert.equal(files[0].command, "journald");
  assert.equal(files[0].processId, "1842");
  assert.equal(files[0].bytes, 1_073_741_824n);
});

test("a file that still has a link is not reported as deleted-but-open", () => {
  const files = parseOpenDeleted(["p7", "cbash", "s100", "L2", "n/home/example/notes.txt", ""].join("\n"));

  assert.deepEqual(files, []);
});

test("the SMART scan skips a device with no name", () => {
  assert.deepEqual(
    parseSmartScan(SCAN).map((device) => device.name),
    ["/dev/nvme0n1", "/dev/sda"],
  );
});

test("NVMe and ATA health documents are both understood", () => {
  const nvme = parseSmartHealth(NVME_HEALTH);
  assert.deepEqual(nvme, {
    passed: true,
    model: "Example NVMe 1TB",
    powerOnHours: 8123n,
    percentageUsed: 4n,
  });

  const ata = parseSmartHealth(ATA_HEALTH);
  assert.equal(ata.passed, false);
  assert.equal(ata.reallocatedSectors, 128n);
});

test("a truncated SMART document is absent rather than a throw", () => {
  for (const text of ['{"smart_status":', "", "null", "[]", "{}"]) {
    assert.equal(parseSmartHealth(text), undefined, JSON.stringify(text));
    assert.deepEqual(parseSmartScan(text), []);
  }
});

test("journalctl's disk usage is read in the units it printed", () => {
  assert.equal(parseJournalUsage("Archived and active journals take up 1.2G in the file system."), 1_200_000_000n);
  assert.equal(parseJournalUsage("Archived and active journals take up 512.0M in the file system."), 512_000_000n);
  assert.equal(parseJournalUsage("Archived and active journals take up 4.0GiB in the file system."), 4_294_967_296n);
  assert.equal(parseJournalUsage("nothing resembling a size"), undefined);
});

test("every diagnostic parser is total on hostile input", () => {
  const inputs = ["", "\n\n", "{", "[", "p", "n", "n (deleted)", "x".repeat(5000), "\u0000\u0001"];
  for (const parse of [parseOpenDeleted, parseSmartScan]) {
    for (const input of inputs) {
      assert.ok(Array.isArray(parse(input)), `${parse.name} on ${JSON.stringify(input.slice(0, 12))}`);
    }
  }
  for (const input of inputs) {
    const health = parseSmartHealth(input);
    assert.ok(health === undefined || typeof health === "object");
    const usage = parseJournalUsage(input);
    assert.ok(usage === undefined || typeof usage === "bigint");
  }
});

test("memfds and shared memory are not counted as deleted files on a disk", () => {
  const files = parseOpenDeleted(
    [
      "p700",
      "cniri",
      "s29360128",
      "L0",
      "n/memfd:awww-ipc (deleted)",
      "s4096",
      "L0",
      "n/dev/shm/wayland.1 (deleted)",
      "s1024",
      "L0",
      "n/[aio] (deleted)",
      "s2048",
      "L0",
      "n/home/example/real.db (deleted)",
      "",
    ].join("\n"),
  );

  assert.deepEqual(
    files.map((file) => file.path),
    ["/home/example/real.db"],
    "those bytes were never on a disk, so restarting the process returns none of them",
  );
});
