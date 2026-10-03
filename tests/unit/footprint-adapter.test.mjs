import assert from "node:assert/strict";
import { test } from "node:test";
import { createIndexFootprint } from "../../dist/platform/linux/footprint.js";
import { CapabilityUnavailable } from "../../dist/domain/errors.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";

const PIP = rawPathFromUtf8("/home/example/.cache/pip");
const CARGO = rawPathFromUtf8("/home/example/.cargo/registry");
const ABSENT = rawPathFromUtf8("/home/example/.cache/never-scanned");

function directoryRow(path, allocated, apparent = allocated) {
  return {
    id: "1",
    path,
    kind: "directory",
    device: 2049n,
    inode: 10n,
    mountId: "29",
    linkCount: 2n,
    apparentBytes: apparent,
    allocatedBytes: allocated,
    ownerId: 1000n,
    modifiedNanoseconds: 1_759_190_400_000_000_000n,
    shared: false,
  };
}

function scanner({ accounting = "allocated", rows = new Map(), unavailable, warnings = [], complete = true } = {}) {
  const recorded = { requests: [], queries: [] };
  const port = {
    async *run(request) {
      recorded.requests.push(request);
      if (unavailable !== undefined) {
        throw new CapabilityUnavailable(unavailable);
      }
      yield {
        kind: "complete",
        scanId: "scan-1",
        accounting,
        roots: request.roots,
        completeness: {
          complete,
          scannedEntries: 10n,
          inaccessibleDirectories: complete ? 0n : 1n,
          excludedMounts: [],
          warnings,
        },
        totals: { allocatedBytes: 0n, apparentBytes: 0n, sharedBytes: 0n },
        filesystems: ["fs-259-2"],
      };
    },
    async query(query) {
      recorded.queries.push(query);
      const row = rows.get(query.filter.underPath?.bytesBase64);
      return { entries: row === undefined ? [] : [row] };
    },
  };
  return { port, recorded };
}

const NO_SNAPSHOTS = { async list() { return []; } };

function footprintOf(scan, snapshots = NO_SNAPSHOTS) {
  return createIndexFootprint({
    measurement: scan.port,
    index: scan.port,
    snapshots,
    accounting: "allocated",
    crossFilesystems: false,
    excludes: [],
  });
}

test("measuring three directories issues one scan with three roots", async () => {
  const rows = new Map([
    [PIP.bytesBase64, directoryRow(PIP, 4096n)],
    [CARGO.bytesBase64, directoryRow(CARGO, 8192n)],
    [ABSENT.bytesBase64, directoryRow(ABSENT, 16n)],
  ]);
  const scan = scanner({ rows });

  const reading = await footprintOf(scan).measure([PIP, CARGO, ABSENT], new AbortController().signal);

  assert.equal(scan.recorded.requests.length, 1);
  assert.deepEqual(
    scan.recorded.requests[0].roots.map((root) => root.display),
    [PIP.display, CARGO.display, ABSENT.display],
  );
  assert.deepEqual(
    reading.measurements.map((measurement) => [measurement.path.display, measurement.bytes, measurement.basis]),
    [
      [PIP.display, 4096n, "measured-allocated"],
      [CARGO.display, 8192n, "measured-allocated"],
      [ABSENT.display, 16n, "measured-allocated"],
    ],
  );
});

test("a measurement is written to and read from its own index, never the one a person's scans live in", async () => {
  const measurement = scanner({ rows: new Map([[PIP.bytesBase64, directoryRow(PIP, 4096n)]]) });
  const touched = [];
  const personal = {
    // eslint-disable-next-line require-yield
    async *run(request) {
      touched.push(["run", request]);
      throw new Error("a measuring scan was written into the personal index");
    },
    async query(query) {
      touched.push(["query", query]);
      throw new Error("a measurement was read from the personal index");
    },
  };

  const reading = await createIndexFootprint({
    measurement: measurement.port,
    index: personal,
    snapshots: NO_SNAPSHOTS,
    accounting: "allocated",
    crossFilesystems: false,
    excludes: [],
  }).measure([PIP], new AbortController().signal);

  assert.equal(reading.measurements[0].bytes, 4096n);
  assert.equal(measurement.recorded.requests.length, 1);
  assert.equal(measurement.recorded.queries.length, 1);
  assert.deepEqual(touched, [], "the personal index was not touched");
});

test("a path the index does not hold is unknown with a reason, not zero", async () => {
  const scan = scanner({ rows: new Map([[PIP.bytesBase64, directoryRow(PIP, 4096n)]]) });

  const reading = await footprintOf(scan).measure([PIP, ABSENT], new AbortController().signal);

  const absent = reading.measurements.find((measurement) => measurement.path.display === ABSENT.display);
  assert.equal(absent.bytes, undefined);
  assert.equal(absent.basis, "unknown");
  assert.match(absent.explanation, /index/);
});

test("a row for some other path is not accepted as this path's size", async () => {
  // A query whose subtree filter was ignored would answer with the largest
  // directory anywhere; taking that number would overstate the footprint.
  const rows = new Map([[PIP.bytesBase64, directoryRow(CARGO, 999_999n)]]);
  const scan = scanner({ rows });

  const reading = await footprintOf(scan).measure([PIP], new AbortController().signal);

  assert.equal(reading.measurements[0].bytes, undefined);
  assert.equal(reading.measurements[0].basis, "unknown");
});

test("apparent accounting is reported as what it is", async () => {
  const scan = scanner({
    accounting: "apparent",
    rows: new Map([[PIP.bytesBase64, directoryRow(PIP, 4096n, 4000n)]]),
  });

  const reading = await footprintOf(scan).measure([PIP], new AbortController().signal);

  assert.deepEqual(
    [reading.measurements[0].bytes, reading.measurements[0].basis],
    [4000n, "measured-apparent"],
  );
});

test("a helper that cannot start leaves every size unknown and says so once", async () => {
  const scan = scanner({ unavailable: { status: "missing-tool", explanation: "The helper binary is missing." } });

  const reading = await footprintOf(scan).measure([PIP, CARGO], new AbortController().signal);

  assert.deepEqual(
    reading.measurements.map((measurement) => measurement.basis),
    ["unknown", "unknown"],
  );
  assert.deepEqual(
    reading.warnings.map((warning) => warning.code),
    ["measurement-unavailable"],
  );
  assert.match(reading.warnings[0].message, /helper binary is missing/);
});

test("an incomplete measuring scan still returns what it measured, with its warnings", async () => {
  const scan = scanner({
    complete: false,
    warnings: [{ code: "inaccessible-directory", message: "One directory could not be read." }],
    rows: new Map([[PIP.bytesBase64, directoryRow(PIP, 4096n)]]),
  });

  const reading = await footprintOf(scan).measure([PIP], new AbortController().signal);

  assert.equal(reading.measurements[0].bytes, 4096n);
  assert.deepEqual(
    reading.warnings.map((warning) => warning.code),
    ["inaccessible-directory"],
  );
});

test("measuring nothing starts no helper at all", async () => {
  const scan = scanner({});

  const reading = await footprintOf(scan).measure([], new AbortController().signal);

  assert.deepEqual(reading, { measurements: [], warnings: [] });
  assert.equal(scan.recorded.requests.length, 0);
});

test("a search with no stored scan says it did not look, which is not finding nothing", async () => {
  const scan = scanner({});

  const search = await footprintOf(scan).directoriesNamed(["node_modules"], 50);

  assert.deepEqual(search, { paths: [], searched: false, truncated: false });
  assert.equal(scan.recorded.queries.length, 0);
});

test("a search uses the newest snapshot that covers the home directory", async () => {
  const home = rawPathFromUtf8("/home/example");
  const modules = rawPathFromUtf8("/home/example/projects/node_modules");
  const snapshots = {
    async list() {
      return [
        {
          id: "snap-new",
          scanId: "scan-new",
          scannedAt: "2026-09-30T08:00:00.000Z",
          scope: { roots: [home], excludes: [], accounting: "allocated", crossFilesystems: false, filesystems: [] },
        },
        {
          id: "snap-elsewhere",
          scanId: "scan-elsewhere",
          scannedAt: "2026-09-29T08:00:00.000Z",
          scope: { roots: [rawPathFromUtf8("/var/log")], excludes: [], accounting: "allocated", crossFilesystems: false, filesystems: [] },
        },
      ];
    },
  };
  const scan = scanner({});
  scan.port.query = async (query) => {
    scan.recorded.queries.push(query);
    return { entries: [directoryRow(modules, 1024n)] };
  };

  const search = await createIndexFootprint({
    measurement: scan.port,
    index: scan.port,
    snapshots,
    home,
    accounting: "allocated",
    crossFilesystems: false,
    excludes: [],
  }).directoriesNamed(["node_modules"], 50);

  assert.deepEqual(search.paths.map((path) => path.display), [modules.display]);
  assert.equal(search.searched, true);
  assert.equal(scan.recorded.queries[0].scanId, "scan-new");
  assert.deepEqual(scan.recorded.queries[0].filter.kinds, ["directory"]);
  assert.equal(scan.recorded.queries[0].filter.nameContains, "node_modules");
});

test("each searched name gets its own budget, so one common name cannot crowd out the rest", async () => {
  const home = rawPathFromUtf8("/home/example");
  const snapshots = {
    async list() {
      return [{ id: "s", scanId: "scan-1", scannedAt: "2026-09-30T08:00:00.000Z", scope: { roots: [home], excludes: [], accounting: "allocated", crossFilesystems: false, filesystems: [] } }];
    },
  };
  const asked = [];
  const scan = scanner({});
  scan.port.query = async (query) => {
    asked.push([query.filter.nameContains, query.limit]);
    const name = query.filter.nameContains;
    const count = name === "node_modules" ? 200 : 1;
    return {
      entries: Array.from({ length: Math.min(count, query.limit) }, (_, index) =>
        directoryRow(rawPathFromUtf8(`/home/example/p${index}/${name}`), 1024n),
      ),
      ...(count > query.limit ? { nextCursor: "more" } : {}),
    };
  };

  const search = await createIndexFootprint({
    measurement: scan.port,
    index: scan.port,
    snapshots,
    home,
    accounting: "allocated",
    crossFilesystems: false,
    excludes: [],
  }).directoriesNamed(["node_modules", "target", "__pycache__"], 60);

  assert.deepEqual(
    asked.map((entry) => entry[0]),
    ["node_modules", "target", "__pycache__"],
    "every name is asked about, not just the ones the budget reached",
  );
  const found = search.paths.map((path) => path.display);
  assert.ok(found.some((path) => path.endsWith("/target")), JSON.stringify(found.slice(0, 5)));
  assert.ok(found.some((path) => path.endsWith("/__pycache__")), JSON.stringify(found.slice(0, 5)));
  assert.equal(search.truncated, true, "more node_modules directories exist than were listed");
});

test("a path that falls out of the ranked page is named rather than dropped quietly", async () => {
  // 300 hardlinks to one file all tie with the directory's own total, so the
  // directory's row can sit beyond the page.
  const tied = rawPathFromUtf8("/home/example/backups");
  const scan = scanner({});
  scan.port.query = async () => ({
    entries: Array.from({ length: 256 }, (_, index) =>
      directoryRow(rawPathFromUtf8(`/home/example/backups/link-${index}`), 10_485_760n),
    ),
    nextCursor: "more",
  });

  const reading = await footprintOf(scan).measure([tied], new AbortController().signal);

  assert.equal(reading.measurements[0].basis, "unknown");
  assert.ok(
    reading.warnings.some((warning) => warning.code === "measurement-crowded-out"),
    JSON.stringify(reading.warnings),
  );
});
