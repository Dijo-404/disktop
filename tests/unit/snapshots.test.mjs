import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createSnapshotService, incompatibilities } from "../../dist/application/snapshots.js";
import { createSnapshotStore } from "../../dist/storage/snapshots.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";

const sandboxes = [];

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "disktop-snapshots-"));
  sandboxes.push(root);
  return root;
}

after(async () => {
  for (const root of sandboxes) {
    await rm(root, { recursive: true, force: true });
  }
});

const SCOPE = {
  roots: [rawPathFromUtf8("/home/example")],
  excludes: [rawPathFromUtf8("/proc")],
  accounting: "allocated",
  crossFilesystems: false,
  filesystems: ["2049"],
};

function snapshot(id, scannedAt, directories, overrides = {}) {
  return {
    version: 1,
    id,
    scanId: `scan-${id}`,
    scannedAt,
    scope: SCOPE,
    totals: { allocatedBytes: 1000n, apparentBytes: 900n, sharedBytes: 0n },
    completeness: { complete: true, scannedEntries: 10n, inaccessibleDirectories: 0n, excludedMounts: [], warnings: [] },
    directories,
    ...overrides,
  };
}

function directory(path, allocated) {
  return { path: rawPathFromUtf8(path), allocatedBytes: allocated, apparentBytes: allocated, entries: 0n };
}

test("a saved snapshot survives a round trip with its byte values exact", async () => {
  const store = createSnapshotStore(await sandbox());
  const huge = 18446744073709551615n;
  const original = snapshot("snap-a", "2026-09-01T00:00:00.000Z", [directory("/home/example/big", huge)], {
    totals: { allocatedBytes: huge, apparentBytes: huge, sharedBytes: 4096n },
  });

  await store.save(original);
  const loaded = await store.get("snap-a");

  assert.equal(loaded.totals.allocatedBytes, huge);
  assert.equal(loaded.directories[0].allocatedBytes, huge);
  assert.equal(loaded.scope.accounting, "allocated");
});

test("a name that is not valid UTF-8 comes back as the same bytes", async () => {
  const store = createSnapshotStore(await sandbox());
  const odd = rawPathFromUtf8("/home/example/plain");
  const bytes = Buffer.from([0x2f, 0x62, 0xff, 0xfe]);
  const raw = { bytesBase64: bytes.toString("base64"), display: "/b??" };

  await store.save(
    snapshot("snap-bytes", "2026-09-01T00:00:00.000Z", [
      { path: raw, allocatedBytes: 1n, apparentBytes: 1n, entries: 0n },
      directory(odd.display, 2n),
    ]),
  );
  const loaded = await store.get("snap-bytes");

  assert.equal(loaded.directories[0].path.bytesBase64, raw.bytesBase64);
  assert.equal(loaded.directories[0].path.utf8, undefined);
});

test("a snapshot written by another version is skipped, not guessed at", async () => {
  const root = await sandbox();
  const store = createSnapshotStore(root);
  await store.save(snapshot("snap-good", "2026-09-01T00:00:00.000Z", []));
  const directoryPath = join(root, "snapshots");
  await writeFile(join(directoryPath, "snap-future.json"), JSON.stringify({ version: 99, id: "snap-future" }));
  await writeFile(join(directoryPath, "snap-broken.json"), "{ not json");

  const listed = await store.list();

  assert.deepEqual(listed.map((entry) => entry.id), ["snap-good"]);
});

test("a partial write never replaces a good snapshot", async () => {
  const root = await sandbox();
  const store = createSnapshotStore(root);
  await store.save(snapshot("snap-a", "2026-09-01T00:00:00.000Z", []));
  await store.save(snapshot("snap-a", "2026-09-02T00:00:00.000Z", []));

  const names = await readdir(join(root, "snapshots"));

  // The staging file is renamed into place, so nothing is left behind.
  assert.deepEqual(names, ["snap-a.json"]);
  assert.equal((await store.get("snap-a")).scannedAt, "2026-09-02T00:00:00.000Z");
});

test("retention drops the oldest and always keeps at least one", async () => {
  const store = createSnapshotStore(await sandbox());
  for (const day of ["01", "02", "03", "04"]) {
    await store.save(snapshot(`snap-${day}`, `2026-09-${day}T00:00:00.000Z`, []));
  }

  const removed = await store.prune({ keepLatest: 2 });
  const remaining = await store.list();

  assert.equal(removed, 2);
  assert.deepEqual(remaining.map((entry) => entry.id), ["snap-04", "snap-03"]);

  await store.prune({ keepLatest: 0 });
  assert.equal((await store.list()).length, 1);
});

test("a byte budget drops older snapshots but never the newest", async () => {
  const store = createSnapshotStore(await sandbox());
  for (const day of ["01", "02", "03"]) {
    await store.save(snapshot(`snap-${day}`, `2026-09-${day}T00:00:00.000Z`, [directory("/home/example/a", 1n)]));
  }

  await store.prune({ keepLatest: 10, maxBytes: 1n });

  assert.deepEqual((await store.list()).map((entry) => entry.id), ["snap-03"]);
});

test("an ID that tries to escape its directory reaches nothing", async () => {
  const store = createSnapshotStore(await sandbox());
  assert.equal(await store.get("../../etc/passwd"), undefined);
  assert.equal(await store.get("snap/../../x"), undefined);
  assert.equal(await store.get(".."), undefined);
});

test("every way two scans can differ is named, not silently averaged", () => {
  assert.deepEqual(incompatibilities(SCOPE, SCOPE), []);
  assert.match(incompatibilities(SCOPE, { ...SCOPE, accounting: "apparent" })[0], /apparent bytes/);
  assert.match(incompatibilities(SCOPE, { ...SCOPE, crossFilesystems: true })[0], /crossed filesystem/);
  assert.match(incompatibilities(SCOPE, { ...SCOPE, roots: [rawPathFromUtf8("/var")] })[0], /different roots/);
  assert.match(incompatibilities(SCOPE, { ...SCOPE, excludes: [] })[0], /excluded different/);
  assert.match(incompatibilities(SCOPE, { ...SCOPE, filesystems: ["66"] })[0], /different filesystems/);
});

test("a diff ranks the largest movement first and refuses incompatible scopes", async () => {
  const store = createSnapshotStore(await sandbox());
  const index = { async query() { return { entries: [] }; } };
  const service = createSnapshotService(store, index);

  await store.save(
    snapshot("snap-01", "2026-09-01T00:00:00.000Z", [
      directory("/home/example/projects", 1_000n),
      directory("/home/example/gone", 500n),
    ]),
  );
  await store.save(
    snapshot("snap-02", "2026-09-02T00:00:00.000Z", [
      directory("/home/example/projects", 9_000n),
      directory("/home/example/new", 100n),
    ]),
  );

  const outcome = await service.diff("snap-01", "snap-02");

  assert.equal(outcome.kind, "diff");
  assert.equal(outcome.diff.directories[0].kind, "grew");
  assert.equal(outcome.diff.directories[0].deltaBytes, 8_000n);
  assert.equal(outcome.diff.directories.find((change) => change.kind === "removed").deltaBytes, -500n);
  assert.equal(outcome.diff.directories.find((change) => change.kind === "added").laterBytes, 100n);
  // An added or removed directory is exactly what a rename looks like.
  assert.equal(outcome.diff.uncertain, true);

  await store.save(snapshot("snap-03", "2026-09-03T00:00:00.000Z", [], { scope: { ...SCOPE, accounting: "apparent" } }));
  const refused = await service.diff("snap-02", "snap-03");
  assert.equal(refused.kind, "incomparable");
  assert.equal(refused.reasons.length, 1);

  assert.deepEqual(await service.diff("snap-02", "snap-missing"), { kind: "missing", id: "snap-missing" });
});

test("an incomplete scan on either side makes the diff uncertain", async () => {
  const store = createSnapshotStore(await sandbox());
  const service = createSnapshotService(store, { async query() { return { entries: [] }; } });
  const partial = {
    complete: false,
    scannedEntries: 1n,
    inaccessibleDirectories: 2n,
    excludedMounts: [],
    warnings: [{ code: "inaccessible-directory", message: "Permission denied." }],
  };

  await store.save(snapshot("snap-01", "2026-09-01T00:00:00.000Z", [directory("/home/example/a", 1n)], { completeness: partial }));
  await store.save(snapshot("snap-02", "2026-09-02T00:00:00.000Z", [directory("/home/example/a", 2n)]));

  const outcome = await service.diff("snap-01", "snap-02");

  assert.equal(outcome.diff.uncertain, true);
  assert.match(outcome.diff.uncertainty[0], /earlier scan was incomplete/);
});

test("the latest comparable snapshot is the one a new page continues from", async () => {
  const store = createSnapshotStore(await sandbox());
  const service = createSnapshotService(store, { async query() { return { entries: [] }; } });

  await store.save(snapshot("snap-01", "2026-09-01T00:00:00.000Z", []));
  await store.save(snapshot("snap-02", "2026-09-02T00:00:00.000Z", [], { scope: { ...SCOPE, accounting: "apparent" } }));
  await store.save(snapshot("snap-03", "2026-09-03T00:00:00.000Z", [], { scope: { ...SCOPE, roots: [rawPathFromUtf8("/var")] } }));

  assert.equal((await service.latestFor(SCOPE)).id, "snap-01");
  assert.equal(await service.latestFor({ ...SCOPE, filesystems: ["999"] }), undefined);
});

test("recording a scan stores the index's largest directories", async () => {
  const store = createSnapshotStore(await sandbox());
  const asked = [];
  const index = {
    async query(query) {
      asked.push(query);
      return {
        entries: [
          {
            id: "1",
            path: rawPathFromUtf8("/home/example/projects"),
            kind: "directory",
            device: 2049n,
            inode: 7n,
            mountId: "29",
            linkCount: 3n,
            apparentBytes: 900n,
            allocatedBytes: 1000n,
            ownerId: 1000n,
            modifiedNanoseconds: 1n,
            shared: false,
          },
        ],
      };
    },
  };
  const service = createSnapshotService(store, index);

  const recorded = await service.record(
    {
      scanId: "scan-abcdef12",
      accounting: "allocated",
      roots: SCOPE.roots,
      completeness: { complete: true, scannedEntries: 4n, inaccessibleDirectories: 0n, excludedMounts: [], warnings: [] },
      totals: { allocatedBytes: 1000n, apparentBytes: 900n, sharedBytes: 0n },
      filesystems: SCOPE.filesystems,
      crossFilesystems: false,
    },
    { excludes: SCOPE.excludes },
    new Date("2026-09-30T12:00:00.000Z"),
  );

  assert.deepEqual(asked[0].filter.kinds, ["directory"]);
  assert.equal(recorded.directories[0].allocatedBytes, 1000n);
  assert.equal((await store.get(recorded.id)).scanId, "scan-abcdef12");
});

test("an apparent-accounting history reports apparent bytes, not allocated ones", async () => {
  const store = createSnapshotStore(await sandbox());
  const service = createSnapshotService(store, { async query() { return { entries: [] }; } });
  const apparentScope = { ...SCOPE, accounting: "apparent" };
  // A sparse file: gigabytes of apparent growth, no change in blocks.
  const sparse = (apparent) => ({
    path: rawPathFromUtf8("/home/example/vm.qcow2"),
    allocatedBytes: 1_052_672n,
    apparentBytes: apparent,
    entries: 0n,
  });

  await store.save(
    snapshot("snap-01", "2026-09-01T00:00:00.000Z", [sparse(10_000_000_000n)], {
      scope: apparentScope,
      totals: { allocatedBytes: 1_052_672n, apparentBytes: 10_000_000_000n, sharedBytes: 0n },
    }),
  );
  await store.save(
    snapshot("snap-02", "2026-09-02T00:00:00.000Z", [sparse(210_000_000_000n)], {
      scope: apparentScope,
      totals: { allocatedBytes: 1_052_672n, apparentBytes: 210_000_000_000n, sharedBytes: 0n },
    }),
  );

  const outcome = await service.diff("snap-01", "snap-02");

  assert.equal(outcome.kind, "diff");
  assert.equal(outcome.diff.totalDeltaBytes, 200_000_000_000n);
  assert.equal(outcome.diff.directories[0].deltaBytes, 200_000_000_000n);
  assert.equal(outcome.diff.directories[0].laterBytes, 210_000_000_000n);
});

test("a depth-limited scan is not comparable with a full one", async () => {
  const store = createSnapshotStore(await sandbox());
  const service = createSnapshotService(store, { async query() { return { entries: [] }; } });

  await store.save(snapshot("snap-01", "2026-09-01T00:00:00.000Z", [directory("/home/example/a", 16_777_216n)]));
  await store.save(
    snapshot("snap-02", "2026-09-02T00:00:00.000Z", [], { scope: { ...SCOPE, maxDepth: "1" } }),
  );

  const outcome = await service.diff("snap-01", "snap-02");

  // Nothing was deleted; the later scan simply did not look that far. Showing
  // -16 MiB would be inventing a deletion.
  assert.equal(outcome.kind, "incomparable");
  assert.match(outcome.reasons[0], /depth/);
  assert.deepEqual(incompatibilities({ ...SCOPE, maxDepth: "3" }, { ...SCOPE, maxDepth: "3" }), []);
});

test("a snapshot records the scope the scan actually used, not the one requested", async () => {
  const store = createSnapshotStore(await sandbox());
  const service = createSnapshotService(store, { async query() { return { entries: [] }; } });

  const recorded = await service.record(
    {
      scanId: "scan-abcdef12",
      accounting: "apparent",
      roots: SCOPE.roots,
      completeness: { complete: true, scannedEntries: 4n, inaccessibleDirectories: 0n, excludedMounts: [], warnings: [] },
      totals: { allocatedBytes: 1000n, apparentBytes: 900n, sharedBytes: 0n },
      // The walk crossed into a second filesystem the roots never named.
      filesystems: ["2049", "66311"],
      crossFilesystems: true,
      maxDepth: 6n,
    },
    { excludes: SCOPE.excludes },
    new Date("2026-09-30T12:00:00.000Z"),
  );

  assert.deepEqual(recorded.scope.filesystems, ["2049", "66311"]);
  assert.equal(recorded.scope.crossFilesystems, true);
  assert.equal(recorded.scope.maxDepth, "6");
  assert.equal(recorded.scope.accounting, "apparent");
  assert.equal((await store.get(recorded.id)).scope.maxDepth, "6");
});

test("pruning removes only the store's own files, whatever a snapshot claims its ID is", async () => {
  // A snapshot file is ordinary JSON other programs can write. The ID inside
  // it named the file prune deleted, so an edited one reached outside.
  const root = await sandbox();
  const store = createSnapshotStore(root);
  const victim = join(root, "precious.json");
  await writeFile(victim, "{}");
  const directoryPath = join(root, "snapshots");
  await store.save(snapshot("snap-new", "2026-09-03T00:00:00.000Z", []));
  const forged = JSON.parse(await readFile(join(directoryPath, "snap-new.json"), "utf8"));
  await writeFile(
    join(directoryPath, "snap-old.json"),
    JSON.stringify({ ...forged, id: "../precious", scannedAt: "2026-09-01T00:00:00.000Z" }),
  );

  const listed = await store.list();
  assert.deepEqual(listed.map((entry) => entry.id), ["snap-new"], "a file whose ID is not its own name is not a snapshot");
  await store.prune({ keepLatest: 1 });
  assert.equal(await readFile(victim, "utf8"), "{}", "nothing outside the store was removed");
});

test("a snapshot that is a pipe or is too large is skipped, not waited on or read whole", async () => {
  const root = await sandbox();
  const store = createSnapshotStore(root);
  await store.save(snapshot("snap-good", "2026-09-01T00:00:00.000Z", []));
  const directoryPath = join(root, "snapshots");
  const fifo = spawnSync("mkfifo", [join(directoryPath, "snap-pipe.json")]);
  assert.equal(fifo.status, 0, "mkfifo is needed for this test");
  await writeFile(join(directoryPath, "snap-huge.json"), "");
  await truncate(join(directoryPath, "snap-huge.json"), 512 * 1024 * 1024);

  const begun = Date.now();
  const listed = await store.list();
  assert.ok(Date.now() - begun < 5_000, `listing took ${Date.now() - begun} ms`);
  assert.deepEqual(listed.map((entry) => entry.id), ["snap-good"]);
});

test("a write that fails leaves no staging file behind", async () => {
  const root = await sandbox();
  const store = createSnapshotStore(root);
  const unencodable = snapshot("snap-bad", "2026-09-01T00:00:00.000Z", [], {
    totals: { allocatedBytes: -1n, apparentBytes: 0n, sharedBytes: 0n },
  });
  await assert.rejects(() => store.save(unencodable));
  assert.deepEqual(await readdir(join(root, "snapshots")), [], "the partial file was removed");
});

test("snapshot files and their directory are private to the user", async () => {
  const root = await sandbox();
  const store = createSnapshotStore(root);
  await store.save(snapshot("snap-a", "2026-09-01T00:00:00.000Z", []));
  assert.equal((await stat(join(root, "snapshots"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, "snapshots", "snap-a.json"))).mode & 0o777, 0o600);
});
