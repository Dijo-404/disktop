import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesRule, validateRule } from "../../dist/domain/rules.js";
import { ruleHash } from "../../dist/storage/rules.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";

const DAY = 86_400_000_000_000n;
const NOW = new Date("2026-10-02T00:00:00.000Z");
const NOW_NS = BigInt(NOW.getTime()) * 1_000_000n;

function source(overrides = {}) {
  return {
    name: "old downloads",
    roots: ["/home/example/Downloads"],
    globs: ["*.iso"],
    minimum_age_days: 30,
    minimum_bytes: 1048576,
    maximum_count: 100,
    maximum_bytes: 10737418240,
    ...overrides,
  };
}

function entry(path, overrides = {}) {
  return {
    id: "1",
    path: rawPathFromUtf8(path),
    kind: "file",
    device: 66306n,
    inode: 1n,
    mountId: "66306",
    linkCount: 1n,
    apparentBytes: 4_000_000n,
    allocatedBytes: 4_000_000n,
    ownerId: 1000n,
    modifiedNanoseconds: NOW_NS - 60n * DAY,
    shared: false,
    ...overrides,
  };
}

test("a rule is read with its roots as byte paths and its limits as bigints", () => {
  const rule = validateRule(source());

  assert.equal(rule.name, "old downloads");
  assert.equal(rule.roots[0].display, "/home/example/Downloads");
  assert.equal(rule.minimumBytes, 1048576n);
  assert.equal(rule.maximumBytes, 10737418240n);
  assert.deepEqual(rule.kinds, ["file"], "a rule acts on files unless it says otherwise");
});

test("a root the cleanup policy refuses makes the whole rule invalid", () => {
  for (const root of ["/", "/etc", "/usr/local", "/home", "/mnt"]) {
    assert.throws(() => validateRule(source({ roots: [root] })), RangeError, root);
  }
});

test("a rule with no root is refused rather than treated as every root", () => {
  assert.throws(() => validateRule(source({ roots: [] })), RangeError);
});

test("a glob that could leave its root is refused", () => {
  for (const glob of ["../*.iso", "a/../../b", "/etc/*", "**/../*"]) {
    assert.throws(() => validateRule(source({ globs: [glob] })), RangeError, glob);
  }
});

test("a rule with no glob is refused: it would match the whole root", () => {
  assert.throws(() => validateRule(source({ globs: [] })), RangeError);
});

test("a rule that names no shell has nowhere to put one", () => {
  assert.throws(() => validateRule(source({ command: "rm -rf /" })), RangeError);
});

test("limits are mandatory and bounded, so a typo cannot widen a rule without end", () => {
  assert.throws(() => validateRule(source({ maximum_count: 0 })), RangeError);
  assert.throws(() => validateRule(source({ maximum_bytes: 0 })), RangeError);
  assert.throws(() => validateRule(source({ minimum_age_days: 0 })), RangeError);
});

test("a rule's hash does not change when its fields are written in another order", () => {
  const first = validateRule({
    name: "r",
    roots: ["/home/example/Downloads"],
    globs: ["*.iso"],
    minimum_age_days: 30,
    minimum_bytes: 1,
    maximum_count: 10,
    maximum_bytes: 100,
  });
  const second = validateRule({
    maximum_bytes: 100,
    maximum_count: 10,
    minimum_bytes: 1,
    minimum_age_days: 30,
    globs: ["*.iso"],
    roots: ["/home/example/Downloads"],
    name: "r",
  });

  assert.equal(ruleHash(first), ruleHash(second));
});

test("a rule's hash changes when anything it would act on changes", () => {
  const base = validateRule(source());

  for (const change of [
    { globs: ["*.img"] },
    { roots: ["/home/example/Videos"] },
    { minimum_age_days: 31 },
    { minimum_bytes: 2 },
    { maximum_count: 99 },
    { maximum_bytes: 99 },
    { excludes: ["keep/*"] },
  ]) {
    assert.notEqual(
      ruleHash(base),
      ruleHash(validateRule(source(change))),
      JSON.stringify(change),
    );
  }
});

test("a hash reads as hexadecimal, so it can go in a plan and be compared", () => {
  assert.match(ruleHash(validateRule(source())), /^[0-9a-f]{64}$/);
});

test("a rule matches a file under its root that is old enough, big enough, and named right", () => {
  const rule = validateRule(source());

  assert.equal(matchesRule(rule, entry("/home/example/Downloads/big.iso"), NOW), true);
});

test("a rule does not match outside its own roots", () => {
  const rule = validateRule(source());

  assert.equal(matchesRule(rule, entry("/home/example/Videos/big.iso"), NOW), false);
});

test("a rule does not match a file younger than its threshold", () => {
  const rule = validateRule(source());
  const fresh = entry("/home/example/Downloads/big.iso", {
    modifiedNanoseconds: NOW_NS - 2n * DAY,
  });

  assert.equal(matchesRule(rule, fresh, NOW), false);
});

test("a rule does not match a file smaller than its threshold", () => {
  const rule = validateRule(source());
  const small = entry("/home/example/Downloads/big.iso", { apparentBytes: 10n, allocatedBytes: 10n });

  assert.equal(matchesRule(rule, small, NOW), false);
});

test("a rule does not match a name its glob does not cover", () => {
  const rule = validateRule(source());

  assert.equal(matchesRule(rule, entry("/home/example/Downloads/notes.txt"), NOW), false);
});

test("an exclude beats a glob that would otherwise match", () => {
  const rule = validateRule(source({ excludes: ["keep-*"] }));

  assert.equal(matchesRule(rule, entry("/home/example/Downloads/keep-me.iso"), NOW), false);
  assert.equal(matchesRule(rule, entry("/home/example/Downloads/other.iso"), NOW), true);
});

test("a rule for files does not match a directory, and the reverse", () => {
  const files = validateRule(source({ globs: ["*"] }));
  const directories = validateRule(source({ globs: ["*"], kinds: ["directory"] }));
  const path = "/home/example/Downloads/thing";

  assert.equal(matchesRule(files, entry(path, { kind: "directory" }), NOW), false);
  assert.equal(matchesRule(directories, entry(path, { kind: "directory" }), NOW), true);
  assert.equal(matchesRule(directories, entry(path, { kind: "file" }), NOW), false);
});

test("a rule never matches a root itself, only what is inside it", () => {
  const rule = validateRule(source({ globs: ["*"] }));

  assert.equal(matchesRule(rule, entry("/home/example/Downloads", { kind: "file" }), NOW), false);
});

test("a glob matches across directory levels only when it says so", () => {
  const shallow = validateRule(source({ globs: ["*.iso"] }));
  const deep = validateRule(source({ globs: ["**/*.iso"] }));
  const nested = entry("/home/example/Downloads/sub/big.iso");

  assert.equal(matchesRule(shallow, nested, NOW), false);
  assert.equal(matchesRule(deep, nested, NOW), true);
});

test("a rule never matches a second hardlink, whose bytes belong to another path", () => {
  const rule = validateRule(source());
  const shared = entry("/home/example/Downloads/big.iso", { shared: true });

  assert.equal(matchesRule(rule, shared, NOW), false);
});
