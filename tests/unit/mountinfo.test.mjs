import assert from "node:assert/strict";
import { test } from "node:test";
import { filesystemIdOf, parseMountinfo } from "../../dist/platform/linux/inventory/mountinfo.js";

function parse(text) {
  return parseMountinfo(new Uint8Array(Buffer.from(text, "utf8")));
}

const REAL_SAMPLE = [
  "25 30 0:23 / /proc rw,nosuid,nodev,noexec,relatime shared:5 - proc proc rw",
  "30 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw,errors=remount-ro",
  "48 30 259:2 /home /home rw,relatime shared:2 - ext4 /dev/nvme0n1p2 rw,errors=remount-ro",
  "52 30 259:1 / /boot/efi rw,relatime shared:9 - vfat /dev/nvme0n1p1 ro,fmask=0077",
].join("\n");

test("a real mountinfo sample yields one entry per mount with its own identity", () => {
  const { mounts, warnings } = parse(REAL_SAMPLE);
  assert.deepEqual(warnings, []);
  assert.equal(mounts.length, 4);

  const root = mounts[1];
  assert.equal(root.mountPoint.display, "/");
  assert.equal(root.filesystemType, "ext4");
  assert.equal(root.source.display, "/dev/nvme0n1p2");
  assert.deepEqual([root.major, root.minor], [259, 2]);
  assert.ok(root.options.includes("relatime"));

  // A second mount of the same device is the same filesystem, not another one.
  assert.equal(filesystemIdOf(mounts[1]), filesystemIdOf(mounts[2]));
  assert.notEqual(filesystemIdOf(mounts[1]), filesystemIdOf(mounts[3]));
});

test("octal escapes decode back to the exact bytes of the mount point", () => {
  const { mounts } = parse("36 30 8:1 / /mnt/two\\040words rw - ext4 /dev/sda1 rw");
  const point = mounts[0].mountPoint;
  assert.equal(point.utf8, "/mnt/two words");
  assert.deepEqual(Buffer.from(point.bytesBase64, "base64"), Buffer.from("/mnt/two words", "utf8"));
});

test("a newline, a tab, and a backslash in a mount point survive as bytes and are safe on screen", () => {
  const { mounts } = parse("36 30 8:1 / /mnt/a\\012b\\011c\\134d rw - ext4 /dev/sda1 rw");
  const point = mounts[0].mountPoint;
  assert.deepEqual(Buffer.from(point.bytesBase64, "base64"), Buffer.from("/mnt/a\nb\tc\\d", "utf8"));
  // The display form carries no character that can command a terminal.
  assert.doesNotMatch(point.display, /[\u0000-\u001F\u007F]/);
});

test("an invalid UTF-8 mount point keeps its bytes and offers no utf8 form", () => {
  const line = Buffer.concat([
    Buffer.from("36 30 8:1 / /mnt/", "utf8"),
    Buffer.from([0xff, 0xfe]),
    Buffer.from(" rw - ext4 /dev/sda1 rw", "utf8"),
  ]);
  const { mounts } = parseMountinfo(new Uint8Array(line));
  const point = mounts[0].mountPoint;
  assert.equal(point.utf8, undefined);
  assert.deepEqual(Buffer.from(point.bytesBase64, "base64").subarray(-2), Buffer.from([0xff, 0xfe]));
});

test("optional fields before the separator do not shift the filesystem type", () => {
  const { mounts } = parse("36 30 8:1 / /mnt rw shared:1 master:2 propagate_from:3 - btrfs /dev/sda1 rw,subvol=/data");
  assert.equal(mounts[0].filesystemType, "btrfs");
  assert.equal(mounts[0].source.display, "/dev/sda1");
  assert.deepEqual(mounts[0].optionalFields, ["shared:1", "master:2", "propagate_from:3"]);
  assert.ok(mounts[0].superOptions.includes("subvol=/data"));
});

test("a malformed line is skipped with a warning rather than guessed at", () => {
  const { mounts, warnings } = parse(["nonsense", "30 1 259:2 / / rw - ext4 /dev/nvme0n1p2 rw"].join("\n"));
  assert.equal(mounts.length, 1);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "mountinfo-malformed-line");
});

test("empty input produces no mounts and no invented ones", () => {
  assert.deepEqual(parse("").mounts, []);
});
