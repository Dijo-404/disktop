import assert from "node:assert/strict";
import { test } from "node:test";
import { rawPathFromBytes, rawPathFromUtf8 } from "../../dist/domain/paths.js";
import { PROTECTED_ROOTS, classifyGenericTarget } from "../../dist/domain/protected-paths.js";

const context = {
  homeDirectory: rawPathFromUtf8("/home/example"),
  allowedRoots: [rawPathFromUtf8("/home/example"), rawPathFromUtf8("/media/work")],
  mountRoots: [rawPathFromUtf8("/"), rawPathFromUtf8("/home"), rawPathFromUtf8("/media/work")],
  excludedRoots: [
    rawPathFromUtf8("/home/example/.local/share/Trash"),
    rawPathFromUtf8("/home/example/.local/state/disktop"),
  ],
};

const verdict = (path) => classifyGenericTarget(rawPathFromUtf8(path), context);

test("user-owned targets under an allowed root are eligible", () => {
  assert.deepEqual(verdict("/home/example/.cache/pip"), { allowed: true });
  assert.deepEqual(verdict("/media/work/build-output"), { allowed: true });
  assert.deepEqual(
    classifyGenericTarget(rawPathFromBytes(Uint8Array.from([0x2f, 0x68, 0x6f, 0x6d, 0x65, 0x2f, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x2f, 0xff])), context),
    { allowed: true },
  );
});

test("protected system roots and their descendants are refused", () => {
  for (const root of PROTECTED_ROOTS) {
    assert.equal(verdict(root).allowed, false, root);
  }
  for (const path of ["/", "/usr/lib/systemd", "/etc/passwd", "/boot/vmlinuz", "/var/log/syslog"]) {
    const result = verdict(path);
    assert.equal(result.allowed, false, path);
    assert.equal(result.code, "protected-path");
  }
});

test("the home directory itself is refused while its contents are not", () => {
  assert.equal(verdict("/home/example").allowed, false);
  assert.equal(verdict("/home/example/Downloads").allowed, true);
});

test("a mount root is refused even when it sits under an allowed root", () => {
  assert.equal(verdict("/media/work").allowed, false);
});

test("Trash and Disktop's own state are refused", () => {
  for (const path of [
    "/home/example/.local/share/Trash",
    "/home/example/.local/share/Trash/files/old",
    "/home/example/.local/state/disktop/journal",
  ]) {
    assert.equal(verdict(path).allowed, false, path);
  }
});

test("targets outside every allowed root are refused", () => {
  assert.equal(verdict("/home/other/Downloads").allowed, false);
  assert.equal(verdict("/srv/data").allowed, false);
});

test("traversal, relative, and unnormalized targets are refused rather than resolved", () => {
  for (const path of ["/home/example/../../etc", "home/example/x", "/home/example/", "/home/example//x"]) {
    const result = verdict(path);
    assert.equal(result.allowed, false, path);
    assert.equal(result.code, "invalid-plan");
  }
});

test("a prefix that is not a path boundary does not grant access", () => {
  assert.equal(verdict("/home/example-backup/data").allowed, false);
  assert.equal(verdict("/usrlocal/data").allowed, false);
});
