import assert from "node:assert/strict";
import { test } from "node:test";
import { rawPathFromBytes, rawPathFromUtf8 } from "../../dist/domain/paths.js";
import {
  PROTECTED_ROOTS,
  classifyDestination,
  classifyGenericTarget,
  isRefusedAsAllowedRoot,
} from "../../dist/domain/protected-paths.js";

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

test("an allowed root is never itself a target", () => {
  const withPlainRoot = {
    ...context,
    allowedRoots: [rawPathFromUtf8("/home/example"), rawPathFromUtf8("/data/projects")],
    mountRoots: [rawPathFromUtf8("/")],
  };
  assert.equal(classifyGenericTarget(rawPathFromUtf8("/data/projects"), withPlainRoot).allowed, false);
  assert.equal(classifyGenericTarget(rawPathFromUtf8("/data/projects/app"), withPlainRoot).allowed, true);
});

test("a shared container root cannot be cleaned even when it is allowed", () => {
  const widened = { ...context, allowedRoots: [rawPathFromUtf8("/home")], mountRoots: [rawPathFromUtf8("/")] };
  for (const path of ["/home", "/home/otheruser", "/home/otheruser/.ssh"]) {
    assert.equal(classifyGenericTarget(rawPathFromUtf8(path), widened).allowed, false, path);
  }
  for (const root of ["/home", "/tmp", "/var/tmp", "/mnt", "/media", "/run/media"]) {
    assert.equal(isRefusedAsAllowedRoot(root), true, root);
  }
  assert.equal(isRefusedAsAllowedRoot("/media/work"), false);
});

test("an incomplete context fails closed rather than skipping a rule", () => {
  for (const missing of ["mountRoots", "excludedRoots"]) {
    const result = classifyGenericTarget(rawPathFromUtf8("/home/example/.cache"), { ...context, [missing]: [] });
    assert.equal(result.allowed, false, missing);
    assert.equal(result.code, "invalid-plan");
  }
});

// --- Phase 5: where a move or compress may publish ---

test("a destination may be outside every allowed root, because that is the point of a move", () => {
  const verdict = classifyDestination(rawPathFromUtf8("/mnt/archive"), context);

  assert.equal(verdict.allowed, true);
});

test("a destination may be a mount root, which is usually exactly where another disk is", () => {
  const verdict = classifyDestination(rawPathFromUtf8("/mnt/backup"), {
    ...context,
    mountRoots: [rawPathFromUtf8("/"), rawPathFromUtf8("/mnt/backup")],
  });

  assert.equal(verdict.allowed, true);
});

test("a destination may be the home directory, which is never a target but is a fine place to write", () => {
  const verdict = classifyDestination(rawPathFromUtf8("/home/example"), context);

  assert.equal(verdict.allowed, true);
});

test("a protected system root is never a destination", () => {
  for (const path of ["/etc", "/usr/local", "/boot", "/"]) {
    const verdict = classifyDestination(rawPathFromUtf8(path), context);
    assert.equal(verdict.allowed, false, path);
    assert.equal(verdict.code, "protected-path", path);
  }
});

test("a shared container root is never a destination, though a directory inside one is", () => {
  assert.equal(classifyDestination(rawPathFromUtf8("/mnt"), context).allowed, false);
  assert.equal(classifyDestination(rawPathFromUtf8("/media"), context).allowed, false);
  assert.equal(classifyDestination(rawPathFromUtf8("/mnt/archive"), context).allowed, true);
});

test("Trash and Disktop's own state are never a destination", () => {
  const verdict = classifyDestination(
    rawPathFromUtf8("/home/example/.local/share/Trash/files"),
    context,
  );

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, "protected-path");
});

test("a relative or unnormalised destination is refused", () => {
  for (const path of ["relative/path", "/mnt/../etc", "/mnt/./archive"]) {
    assert.equal(classifyDestination(rawPathFromUtf8(path), context).allowed, false, path);
  }
});

test("a destination is refused when the context nobody could read is incomplete", () => {
  const verdict = classifyDestination(rawPathFromUtf8("/mnt/archive"), {
    ...context,
    excludedRoots: [],
  });

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, "invalid-plan");
});
