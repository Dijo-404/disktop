import assert from "node:assert/strict";
import { test } from "node:test";
import { createDuplicateService } from "../../dist/application/duplicates.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";

const DAY = 86_400_000_000_000n;
const MIB = 1024n * 1024n;

function file(path, modifiedNanoseconds, inode) {
  return {
    path: rawPathFromUtf8(path),
    device: 66306n,
    inode,
    apparentBytes: MIB,
    modifiedNanoseconds,
    ownerId: 1000n,
    groupId: 1000n,
    permissions: 0o644,
  };
}

function port(reading) {
  const queries = [];
  return {
    queries,
    port: {
      async groups(query) {
        queries.push(query);
        return {
          complete: true,
          warnings: [],
          candidatesRead: 2n,
          filesHashed: 2n,
          ...reading,
        };
      },
    },
  };
}

const PAIR = {
  apparentBytes: MIB,
  digest: "b".repeat(64),
  files: [
    file("/home/example/Pictures/a.jpg", 10n * DAY, 1n),
    file("/home/example/Downloads/a.jpg", 20n * DAY, 2n),
  ],
};

test("a search reports each group with the copy the rule keeps", async () => {
  const { port: fake } = port({ groups: [PAIR] });
  const service = createDuplicateService(fake);

  const outcome = await service.find(
    {
      scanId: "scan-1",
      path: rawPathFromUtf8("/home/example"),
      rule: "oldest",
      minimumBytes: 1n,
    },
    new AbortController().signal,
  );

  assert.equal(outcome.kind, "found");
  assert.equal(outcome.groups.length, 1);
  assert.equal(outcome.groups[0].decision.kind, "decided");
  assert.equal(outcome.groups[0].decision.kept.path.display, "/home/example/Pictures/a.jpg");
  assert.equal(outcome.complete, true);
});

test("reclaimable bytes are totalled across groups and never count the kept copy", async () => {
  const { port: fake } = port({
    groups: [
      PAIR,
      {
        apparentBytes: 500n,
        digest: "c".repeat(64),
        files: [
          file("/home/example/x.bin", 1n, 3n),
          file("/home/example/y.bin", 2n, 4n),
          file("/home/example/z.bin", 3n, 5n),
        ],
      },
    ],
  });

  const outcome = await createDuplicateService(fake).find(
    { scanId: "scan-1", path: rawPathFromUtf8("/home/example"), rule: "oldest", minimumBytes: 1n },
    new AbortController().signal,
  );

  assert.equal(outcome.kind, "found");
  assert.equal(outcome.reclaimableBytes, MIB + 1000n);
});

test("the search passes the path, the minimum size, and nothing it was not asked for", async () => {
  const { port: fake, queries } = port({ groups: [] });

  await createDuplicateService(fake).find(
    {
      scanId: "scan-7",
      path: rawPathFromUtf8("/home/example/Pictures"),
      rule: "newest",
      minimumBytes: 1048576n,
    },
    new AbortController().signal,
  );

  assert.equal(queries.length, 1);
  assert.equal(queries[0].scanId, "scan-7");
  assert.equal(queries[0].underPath.display, "/home/example/Pictures");
  assert.equal(queries[0].minimumBytes, 1048576n);
});

test("an incomplete reading makes the whole answer incomplete and keeps its warnings", async () => {
  const { port: fake } = port({
    groups: [PAIR],
    complete: false,
    warnings: [{ code: "permission-denied", message: "one file could not be read" }],
  });

  const outcome = await createDuplicateService(fake).find(
    { scanId: "scan-1", path: rawPathFromUtf8("/home/example"), rule: "oldest", minimumBytes: 1n },
    new AbortController().signal,
  );

  assert.equal(outcome.kind, "found");
  assert.equal(outcome.complete, false);
  assert.equal(outcome.warnings.length, 1);
});

test("in-path needs a directory and refuses rather than falling back to another rule", async () => {
  const { port: fake } = port({ groups: [PAIR] });

  const outcome = await createDuplicateService(fake).find(
    { scanId: "scan-1", path: rawPathFromUtf8("/home/example"), rule: "in-path", minimumBytes: 1n },
    new AbortController().signal,
  );

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-input");
  assert.match(outcome.failure.message, /--keep-under/);
});

test("a group the rule cannot decide is reported undecided, not dropped and not guessed", async () => {
  const { port: fake } = port({ groups: [PAIR] });

  const outcome = await createDuplicateService(fake).find(
    {
      scanId: "scan-1",
      path: rawPathFromUtf8("/home/example"),
      rule: "in-path",
      keepUnder: rawPathFromUtf8("/home/example/Music"),
      minimumBytes: 1n,
    },
    new AbortController().signal,
  );

  assert.equal(outcome.kind, "found");
  assert.equal(outcome.groups.length, 1);
  assert.equal(outcome.groups[0].decision.kind, "undecidable");
  assert.equal(
    outcome.reclaimableBytes,
    0n,
    "nothing is reclaimable from a group whose keeper nobody chose",
  );
});

test("a capability the helper cannot provide is reported as unavailable, not as no duplicates", async () => {
  const service = createDuplicateService({
    async groups() {
      const { CapabilityUnavailable } = await import("../../dist/domain/errors.js");
      throw new CapabilityUnavailable({
        id: "native-helper",
        state: "missing-tool",
        explanation: "the helper is not installed",
      });
    },
  });

  const outcome = await service.find(
    { scanId: "scan-1", path: rawPathFromUtf8("/home/example"), rule: "oldest", minimumBytes: 1n },
    new AbortController().signal,
  );

  assert.equal(outcome.kind, "unavailable");
  assert.equal(outcome.capability.state, "missing-tool");
});
