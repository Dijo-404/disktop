import assert from "node:assert/strict";
import { test } from "node:test";
import { createRulesProvider } from "../../dist/providers/rules/index.js";
import { validateRule } from "../../dist/domain/rules.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";

const NOW = new Date("2026-10-02T00:00:00.000Z");
const NOW_NS = BigInt(NOW.getTime()) * 1_000_000n;
const DAY = 86_400_000_000_000n;
const SIGNAL = new AbortController().signal;

function rule(overrides = {}) {
  return validateRule({
    name: "old downloads",
    roots: ["/home/example/Downloads"],
    globs: ["*.iso"],
    minimum_age_days: 30,
    minimum_bytes: 1024,
    maximum_count: 10,
    maximum_bytes: 1_000_000_000,
    ...overrides,
  });
}

function entry(path, overrides = {}) {
  return {
    id: path,
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

function environment(rules, entries, overrides = {}) {
  const asked = [];
  return {
    asked,
    environment: {
      home: rawPathFromUtf8("/home/example"),
      variables: {},
      userId: 1000n,
      now: NOW,
      staleAfterDays: 183,
      appImageRoots: [],
      artifactDirectories: [],
      largeLogBytes: 1n,
      maxFindingsPerProvider: 50,
      rules,
      paths: {
        async facts() { return undefined; },
        async list() { return []; },
        async readText() { return undefined; },
      },
      tools: { async run() { throw new Error("a rule never runs a command"); } },
      index: {
        async directoriesNamed() { return { paths: [], searched: true, truncated: false }; },
        async ownerTotals() { return { owners: [], truncated: false, searched: true, complete: true }; },
        async entriesUnder(root, limit) {
          asked.push({ root: root.display, limit });
          return { entries, searched: true, truncated: false, complete: true, ...overrides };
        },
      },
    },
  };
}

test("a rule becomes one finding naming every entry it selected", async () => {
  const { environment: env } = environment(
    [rule()],
    [entry("/home/example/Downloads/a.iso"), entry("/home/example/Downloads/b.iso")],
  );

  const result = await createRulesProvider().discover(env, SIGNAL);

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].paths.length, 2);
  assert.match(result.findings[0].title, /old downloads/);
  assert.equal(result.complete, true);
});

test("a provider with no rules finds nothing and says nothing went wrong", async () => {
  const { environment: env, asked } = environment([], []);

  const result = await createRulesProvider().discover(env, SIGNAL);

  assert.deepEqual(result.findings, []);
  assert.equal(result.complete, true);
  assert.deepEqual(asked, [], "a rule nobody wrote asks the index nothing");
});

test("entries a rule does not select are left out", async () => {
  const { environment: env } = environment(
    [rule()],
    [entry("/home/example/Downloads/a.iso"), entry("/home/example/Downloads/notes.txt")],
  );

  const result = await createRulesProvider().discover(env, SIGNAL);

  assert.equal(result.findings[0].paths.length, 1);
  assert.match(result.findings[0].paths[0].display, /a\.iso$/);
});

test("a rule that selects nothing produces no finding rather than an empty one", async () => {
  const { environment: env } = environment([rule()], [entry("/home/example/Downloads/notes.txt")]);

  const result = await createRulesProvider().discover(env, SIGNAL);

  assert.deepEqual(result.findings, []);
});

test("a rule stops at its count limit and says the selection was truncated", async () => {
  const entries = Array.from({ length: 25 }, (_value, index) =>
    entry(`/home/example/Downloads/file-${index}.iso`, { inode: BigInt(index) }),
  );
  const { environment: env } = environment([rule({ maximum_count: 3 })], entries);

  const result = await createRulesProvider().discover(env, SIGNAL);

  assert.equal(result.findings[0].paths.length, 3);
  assert.ok(
    result.findings[0].evidence.some((line) => /limit|truncat/i.test(line)),
    `evidence was ${JSON.stringify(result.findings[0].evidence)}`,
  );
});

test("a rule stops at its byte limit before exceeding it", async () => {
  const entries = Array.from({ length: 10 }, (_value, index) =>
    entry(`/home/example/Downloads/file-${index}.iso`, {
      inode: BigInt(index),
      allocatedBytes: 1_000_000n,
      apparentBytes: 1_000_000n,
    }),
  );
  const { environment: env } = environment([rule({ maximum_bytes: 2_500_000 })], entries);

  const result = await createRulesProvider().discover(env, SIGNAL);

  assert.equal(result.findings[0].paths.length, 2, "a third would pass the limit");
  assert.equal(result.findings[0].size.bytes, 2_000_000n);
});

test("a rule reports its own size as measured, because the index measured it", async () => {
  const { environment: env } = environment([rule()], [entry("/home/example/Downloads/a.iso")]);

  const result = await createRulesProvider().discover(env, SIGNAL);

  assert.equal(result.findings[0].size.basis, "measured-allocated");
  assert.equal(result.findings[0].size.bytes, 4_000_000n);
});

test("a root no stored scan covers makes the result incomplete rather than empty", async () => {
  const { environment: env } = environment([rule()], [], { searched: false });

  const result = await createRulesProvider().discover(env, SIGNAL);

  assert.equal(result.complete, false);
  assert.ok(result.warnings.length >= 1, "it says which root nobody looked at");
});

test("a finding from a rule offers only reviewed Trash, never a command", async () => {
  const { environment: env } = environment([rule()], [entry("/home/example/Downloads/a.iso")]);

  const result = await createRulesProvider().discover(env, SIGNAL);

  assert.deepEqual(result.findings[0].availableActionIds, ["trash", "permanent"]);
  assert.equal(result.findings[0].managerScope, undefined);
});

test("two rules produce two findings with distinct, stable ids", async () => {
  const { environment: env } = environment(
    [rule(), rule({ name: "another", globs: ["*.img"] })],
    [entry("/home/example/Downloads/a.iso"), entry("/home/example/Downloads/b.img")],
  );

  const result = await createRulesProvider().discover(env, SIGNAL);

  assert.equal(result.findings.length, 2);
  assert.notEqual(result.findings[0].id, result.findings[1].id);
  for (const finding of result.findings) {
    assert.match(finding.id, /^rules:/);
  }
});
