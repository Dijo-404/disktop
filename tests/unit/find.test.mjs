import assert from "node:assert/strict";
import { test } from "node:test";
import { createFindService } from "../../dist/application/find.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";

function entry(path, overrides = {}) {
  return {
    id: "1",
    path: rawPathFromUtf8(path),
    kind: "directory",
    device: 66306n,
    inode: 1n,
    mountId: "66306",
    linkCount: 2n,
    apparentBytes: 4096n,
    allocatedBytes: 4096n,
    ownerId: 1000n,
    modifiedNanoseconds: 1n,
    shared: false,
    ...overrides,
  };
}

function service(page, duplicates, inventory) {
  const queries = [];
  return {
    queries,
    service: createFindService(
      {
        async page(request) {
          queries.push(request);
          return page;
        },
      },
      duplicates,
      inventory,
    ),
  };
}

test("empty asks the index for directories with no children and nothing else", async () => {
  const { service: find, queries } = service({
    kind: "page",
    page: { entries: [entry("/home/example/old", { childEntries: 0n })] },
  });

  const outcome = await find.find({ kind: "empty", scanId: "scan-1", path: rawPathFromUtf8("/home/example") });

  assert.equal(outcome.kind, "found");
  assert.equal(outcome.entries.length, 1);
  assert.deepEqual(queries[0].filter.kinds, ["directory"]);
  assert.equal(queries[0].filter.maxChildEntries, 0n);
  assert.equal(queries[0].filter.broken, undefined);
});

test("broken asks the index for symlinks whose target does not resolve", async () => {
  const { service: find, queries } = service({
    kind: "page",
    page: { entries: [entry("/home/example/alias", { kind: "symlink", broken: true })] },
  });

  const outcome = await find.find({ kind: "broken", scanId: "scan-1", path: rawPathFromUtf8("/home/example") });

  assert.equal(outcome.kind, "found");
  assert.deepEqual(queries[0].filter.kinds, ["symlink"]);
  assert.equal(queries[0].filter.broken, true);
  assert.equal(queries[0].filter.maxChildEntries, undefined);
});

test("the search is narrowed to the path it was given, not the whole scan", async () => {
  const { service: find, queries } = service({ kind: "page", page: { entries: [] } });
  const wanted = rawPathFromUtf8("/home/example/projects");

  await find.find({ kind: "empty", scanId: "scan-1", path: wanted });
  assert.equal(queries[0].filter.underPath.bytesBase64, wanted.bytesBase64);
});

test("stale filters the index by modification time and carries the mount's basis", async () => {
  const { service: find, queries } = service(
    { kind: "page", page: { entries: [entry("/home/example/old.log", { kind: "file" })] } },
    undefined,
    { async mountOptionsFor() { return ["rw", "relatime"]; } },
  );

  const outcome = await find.find({
    kind: "stale",
    scanId: "scan-1",
    path: rawPathFromUtf8("/home/example"),
    staleBeforeNanoseconds: 1700000000000000000n,
  });

  assert.equal(outcome.kind, "stale");
  assert.equal(outcome.entries.length, 1);
  assert.equal(queries[0].filter.modifiedBeforeNanoseconds, 1700000000000000000n);
  assert.deepEqual(queries[0].filter.kinds, ["file"]);
  assert.equal(outcome.basis.field, "modified");
  assert.equal(outcome.basis.confidence, "coarse");
  assert.doesNotMatch(outcome.basis.label, /not opened|last opened/i);
});

test("stale on a mount whose options could not be read says unknown, not maintained", async () => {
  const { service: find } = service(
    { kind: "page", page: { entries: [] } },
    undefined,
    { async mountOptionsFor() { return undefined; } },
  );

  const outcome = await find.find({
    kind: "stale",
    scanId: "scan-1",
    path: rawPathFromUtf8("/home/example"),
    staleBeforeNanoseconds: 1n,
  });

  assert.equal(outcome.kind, "stale");
  assert.equal(outcome.basis.confidence, "unknown");
});

test("stale without an inventory to ask still answers, with an unknown basis", async () => {
  const { service: find } = service({ kind: "page", page: { entries: [] } });

  const outcome = await find.find({
    kind: "stale",
    scanId: "scan-1",
    path: rawPathFromUtf8("/home/example"),
    staleBeforeNanoseconds: 1n,
  });

  assert.equal(outcome.kind, "stale");
  assert.equal(outcome.basis.confidence, "unknown");
});

test("stale without a cutoff is a refusal rather than a listing of everything", async () => {
  const { service: find, queries } = service({ kind: "page", page: { entries: [] } });

  const outcome = await find.find({ kind: "stale", scanId: "scan-1", path: rawPathFromUtf8("/home/example") });

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-input");
  assert.deepEqual(queries, [], "nothing was asked of the index");
});

test("duplicates go to the duplicate service and never to the index page query", async () => {
  const { service: find, queries } = service({ kind: "page", page: { entries: [] } }, {
    async find(request) {
      return { kind: "found", groups: [], reclaimableBytes: 0n, complete: true, warnings: [], candidatesRead: 0n, filesHashed: 0n, echoed: request };
    },
  });

  const outcome = await find.find({
    kind: "duplicates",
    scanId: "scan-1",
    path: rawPathFromUtf8("/home/example"),
    rule: "oldest",
    minimumBytes: 4096n,
  });

  assert.equal(outcome.kind, "duplicates");
  assert.equal(outcome.result.kind, "found");
  assert.equal(outcome.result.echoed.rule, "oldest");
  assert.equal(outcome.result.echoed.minimumBytes, 4096n);
  assert.deepEqual(queries, [], "a duplicate search is not an index page");
});

test("duplicates without a duplicate service are refused rather than silently empty", async () => {
  const { service: find } = service({ kind: "page", page: { entries: [] } });

  const outcome = await find.find({ kind: "duplicates", scanId: "scan-1", path: rawPathFromUtf8("/home/example") });

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "unsupported");
});

test("an index that cannot be read is a capability state, not an empty answer", async () => {
  const { service: find } = service({
    kind: "unavailable",
    capability: { status: "unsupported-kernel", explanation: "openat2 is unavailable" },
  });

  const outcome = await find.find({ kind: "empty", scanId: "scan-1", path: rawPathFromUtf8("/home/example") });
  assert.equal(outcome.kind, "unavailable");
  assert.equal(outcome.capability.status, "unsupported-kernel");
});

test("a duplicate search receives the caller's signal, so Ctrl+C reaches it", async () => {
  let received;
  const { service: find } = service({ kind: "page", page: { entries: [] } }, {
    async find(_request, signal) {
      received = signal;
      return { kind: "found", groups: [], reclaimableBytes: 0n, complete: true, warnings: [], candidatesRead: 0n, filesHashed: 0n };
    },
  });
  const controller = new AbortController();
  await find.find({ kind: "duplicates", scanId: "scan-1", path: rawPathFromUtf8("/home/example") }, controller.signal);
  controller.abort();
  assert.equal(received.aborted, true);
});
