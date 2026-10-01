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
    scanner: scan.port,
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

  assert.deepEqual(search, { paths: [], searched: false });
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
    scanner: scan.port,
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
