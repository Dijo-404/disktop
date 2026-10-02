import assert from "node:assert/strict";
import { test } from "node:test";
import { applyKeepRule, reclaimableBytes } from "../../dist/domain/duplicates.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";

const DAY = 86_400_000_000_000n;

function file(path, modifiedNanoseconds, overrides = {}) {
  return {
    path: rawPathFromUtf8(path),
    device: 66306n,
    inode: 1n,
    apparentBytes: 1024n * 1024n,
    modifiedNanoseconds,
    ownerId: 1000n,
    groupId: 1000n,
    permissions: 0o644,
    ...overrides,
  };
}

function group(files, apparentBytes = 1024n * 1024n) {
  return { apparentBytes, digest: "a".repeat(64), files };
}

test("keep-oldest keeps the earliest modification time and says which field it read", () => {
  const older = file("/home/example/first.jpg", 10n * DAY, { inode: 1n });
  const newer = file("/home/example/second.jpg", 20n * DAY, { inode: 2n });

  const decision = applyKeepRule(group([newer, older]), "oldest");

  assert.equal(decision.kind, "decided");
  assert.equal(decision.kept.path.display, "/home/example/first.jpg");
  assert.deepEqual(
    decision.others.map((other) => other.path.display),
    ["/home/example/second.jpg"],
  );
  assert.match(decision.basis, /modification time/);
  assert.equal(decision.arbitrary, false);
});

test("keep-newest keeps the latest modification time", () => {
  const older = file("/home/example/first.jpg", 10n * DAY, { inode: 1n });
  const newer = file("/home/example/second.jpg", 20n * DAY, { inode: 2n });

  const decision = applyKeepRule(group([older, newer]), "newest");

  assert.equal(decision.kind, "decided");
  assert.equal(decision.kept.path.display, "/home/example/second.jpg");
});

test("no keep rule reads an access time, because no scan column holds one", () => {
  const decision = applyKeepRule(
    group([file("/home/example/a.jpg", 1n, { inode: 1n }), file("/home/example/b.jpg", 2n, { inode: 2n })]),
    "oldest",
  );

  assert.equal(decision.kind, "decided");
  assert.doesNotMatch(decision.basis, /access|opened|atime/i);
});

test("a tie on timestamps is decided by path order and admits it was arbitrary", () => {
  const first = file("/home/example/b.jpg", 7n * DAY, { inode: 1n });
  const second = file("/home/example/a.jpg", 7n * DAY, { inode: 2n });

  const decision = applyKeepRule(group([first, second]), "oldest");

  assert.equal(decision.kind, "decided");
  assert.equal(decision.kept.path.display, "/home/example/a.jpg");
  assert.equal(decision.arbitrary, true);
  assert.match(decision.basis, /same|tie|identical/i);
});

test("keep-in-path keeps the file under the named directory", () => {
  const keep = file("/home/example/Pictures/a.jpg", 10n * DAY, { inode: 1n });
  const other = file("/home/example/Downloads/a.jpg", 20n * DAY, { inode: 2n });

  const decision = applyKeepRule(
    group([other, keep]),
    "in-path",
    rawPathFromUtf8("/home/example/Pictures"),
  );

  assert.equal(decision.kind, "decided");
  assert.equal(decision.kept.path.display, "/home/example/Pictures/a.jpg");
  assert.match(decision.basis, /\/home\/example\/Pictures/);
});

test("keep-in-path matching nothing is undecidable rather than quietly keeping something else", () => {
  const decision = applyKeepRule(
    group([
      file("/home/example/Downloads/a.jpg", 10n * DAY, { inode: 1n }),
      file("/home/example/Desktop/a.jpg", 20n * DAY, { inode: 2n }),
    ]),
    "in-path",
    rawPathFromUtf8("/home/example/Pictures"),
  );

  assert.equal(decision.kind, "undecidable");
  assert.match(decision.reason, /\/home\/example\/Pictures/);
});

test("keep-in-path matching more than one file is undecidable", () => {
  const decision = applyKeepRule(
    group([
      file("/home/example/Pictures/a.jpg", 10n * DAY, { inode: 1n }),
      file("/home/example/Pictures/copy/a.jpg", 20n * DAY, { inode: 2n }),
    ]),
    "in-path",
    rawPathFromUtf8("/home/example/Pictures"),
  );

  assert.equal(decision.kind, "undecidable");
});

test("keep-in-path without a directory to keep under is a programming error", () => {
  assert.throws(
    () =>
      applyKeepRule(
        group([file("/home/example/a.jpg", 1n, { inode: 1n }), file("/home/example/b.jpg", 2n, { inode: 2n })]),
        "in-path",
      ),
    RangeError,
  );
});

test("a group of fewer than two files is a programming error, not a decision", () => {
  assert.throws(() => applyKeepRule(group([file("/home/example/a.jpg", 1n)]), "oldest"), RangeError);
});

test("reclaimable bytes count every copy but the one being kept", () => {
  const three = group(
    [
      file("/home/example/a.jpg", 1n, { inode: 1n }),
      file("/home/example/b.jpg", 2n, { inode: 2n }),
      file("/home/example/c.jpg", 3n, { inode: 3n }),
    ],
    1024n * 1024n,
  );

  assert.equal(reclaimableBytes(three), 2n * 1024n * 1024n);
});

test("a pair reclaims one copy, never both", () => {
  const pair = group(
    [file("/home/example/a.jpg", 1n, { inode: 1n }), file("/home/example/b.jpg", 2n, { inode: 2n })],
    500n,
  );

  assert.equal(reclaimableBytes(pair), 500n);
});
