import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrapCli } from "../../dist/cli/bootstrap.js";
import { runCli } from "../../dist/cli/run.js";
import { compileBundle } from "../support/schemas.mjs";
import { FIXTURE_ENTRY, FIXTURE_SNAPSHOT, fakeContext, rawPath } from "../support/cli-context.mjs";

const validators = compileBundle("schemas/cli/v1");

function envelopeOf(context, schema) {
  const envelope = JSON.parse(context.captured.stdout);
  const validate = validators.get(schema);
  assert.ok(validate(envelope), `${schema}: ${JSON.stringify(validate.errors)}`);
  return envelope;
}

test("scan reports lossless totals and the snapshot it saved", async () => {
  const context = fakeContext();
  const status = await runCli(["scan", "--json"], context);
  const envelope = envelopeOf(context, "scan");

  assert.equal(status, 0);
  assert.equal(envelope.command, "scan");
  assert.equal(envelope.data.totals.allocatedBytes, "91268055040");
  // Hardlinked bytes are reported apart from the totals, never added to them.
  assert.equal(envelope.data.totals.sharedBytes, "2097152");
  assert.equal(envelope.data.snapshotId, FIXTURE_SNAPSHOT.id);
  assert.equal(envelope.data.roots[0].display, "/home/example/projects");
});

test("an interrupted scan exits 130 and still says what it measured", async () => {
  const context = fakeContext({
    scanOutcome: {
      kind: "scanned",
      summary: {
        scanId: "scan-1",
        accounting: "allocated",
        roots: [{ bytesBase64: "L2hvbWU=", display: "/home", utf8: "/home" }],
        completeness: {
          complete: false,
          scannedEntries: 12n,
          inaccessibleDirectories: 0n,
          excludedMounts: [],
          warnings: [{ code: "cancelled", message: "The scan stopped at a directory boundary." }],
        },
        totals: { allocatedBytes: 4096n, apparentBytes: 4000n, sharedBytes: 0n },
      },
    },
  });

  const status = await runCli(["scan", "/home", "--json"], context);
  const envelope = envelopeOf(context, "scan");

  assert.equal(status, 130);
  assert.equal(envelope.status, "incomplete");
  assert.equal(envelope.exitCode, 130);
  assert.equal(envelope.warnings[0].code, "cancelled");
});

test("a scan that cannot run says which capability is missing", async () => {
  const context = fakeContext({
    scanOutcome: { kind: "unavailable", capability: { status: "unsupported-kernel", explanation: "openat2 is unavailable." } },
  });

  const status = await runCli(["scan", "--json"], context);
  const envelope = envelopeOf(context, "scan");

  assert.equal(status, 2);
  assert.equal(envelope.error.code, "unsupported");
  assert.equal(envelope.error.details.capability, "unsupported-kernel");
  assert.match(envelope.error.message, /openat2/);
});

test("a bad throttle or depth is refused before anything is scanned", async () => {
  const context = fakeContext();
  assert.equal(await runCli(["scan", "--throttle", "fast", "--json"], context), 2);
  assert.equal(JSON.parse(context.captured.stdout).error.code, "invalid-input");

  const depth = fakeContext();
  assert.equal(await runCli(["scan", "--max-depth", "0", "--json"], depth), 2);
  assert.match(JSON.parse(depth.captured.stdout).error.message, /--max-depth/);
});

test("explore returns one page of the newest scan covering the path", async () => {
  const context = fakeContext();
  const status = await runCli(["explore", "--type-totals", "--json"], context);
  const envelope = envelopeOf(context, "explore");

  assert.equal(status, 0);
  assert.equal(envelope.data.scanId, FIXTURE_SNAPSHOT.scanId);
  assert.equal(envelope.data.entries[0].path.display, FIXTURE_ENTRY.path.display);
  assert.equal(envelope.data.entries[0].allocatedBytes, "19757268992");
  assert.equal(envelope.data.typeTotals[0].extension, "log");
});

test("explore over a path with no stored scan names the command that makes one", async () => {
  const context = fakeContext({ snapshots: [] });
  const status = await runCli(["explore", "/var/log", "--json"], context);
  const envelope = envelopeOf(context, "explore");

  assert.equal(status, 2);
  assert.equal(envelope.error.code, "invalid-input");
  assert.match(envelope.error.message, /disktop scan \/var\/log/);
});

test("explore passes the filters it was given through to the index", async () => {
  const asked = [];
  const context = fakeContext();
  context.storage.explore.page = async (query) => {
    asked.push(query);
    return { kind: "page", page: { entries: [] } };
  };

  await runCli(
    ["explore", "--sort", "modified", "--order", "ascending", "--min-size", "1GiB", "--ext", ".log", "--name", "cache", "--kind", "file", "--limit", "5", "--json"],
    context,
  );

  const query = asked[0];
  assert.equal(query.sort, "modified");
  assert.equal(query.order, "ascending");
  assert.equal(query.limit, 5);
  assert.equal(query.filter.minAllocatedBytes, 1073741824n);
  // A leading dot is how people write an extension; the index stores it without one.
  assert.equal(query.filter.extension, "log");
  assert.equal(query.filter.nameContains, "cache");
  assert.deepEqual(query.filter.kinds, ["file"]);
});

test("a page of a partial scan exits 3 and carries the scan's warnings", async () => {
  const partial = {
    ...FIXTURE_SNAPSHOT,
    completeness: {
      complete: false,
      scannedEntries: 4n,
      inaccessibleDirectories: 2n,
      excludedMounts: [],
      warnings: [{ code: "inaccessible-directory", message: "Permission denied." }],
    },
  };
  const context = fakeContext({ snapshots: [partial] });

  const status = await runCli(["explore", "--json"], context);
  const envelope = envelopeOf(context, "explore");

  assert.equal(status, 3);
  assert.equal(envelope.status, "incomplete");
  assert.equal(envelope.warnings.length, 1);
});

test("snapshots list reports what is stored, with lossless byte values", async () => {
  const context = fakeContext();
  const status = await runCli(["snapshots", "list", "--json"], context);
  const envelope = envelopeOf(context, "snapshots");

  assert.equal(status, 0);
  assert.equal(envelope.command, "snapshots list");
  assert.equal(envelope.data.snapshots[0].totals.allocatedBytes, "91268055040");
  assert.equal(envelope.data.snapshots[0].scope.accounting, "allocated");
});

test("snapshots diff refuses to compare scans that measured different things", async () => {
  const context = fakeContext({
    diff: { kind: "incomparable", reasons: ["One scan counted allocated bytes and the other counted apparent bytes."] },
    snapshots: [FIXTURE_SNAPSHOT, { ...FIXTURE_SNAPSHOT, id: "snap-older" }],
  });

  const status = await runCli(["snapshots", "diff", "--json"], context);
  const envelope = envelopeOf(context, "snapshots");

  assert.equal(status, 2);
  assert.equal(envelope.error.code, "invalid-input");
  assert.match(envelope.error.message, /would invent growth/);
});

test("snapshots diff needs two snapshots before it will compare anything", async () => {
  const context = fakeContext({ snapshots: [FIXTURE_SNAPSHOT] });
  const status = await runCli(["snapshots", "diff", "--json"], context);
  const envelope = envelopeOf(context, "snapshots");

  assert.equal(status, 2);
  assert.match(envelope.error.message, /needs two saved snapshots/);
});

test("a growth diff reports signed deltas and says why it may be uncertain", async () => {
  const later = { ...FIXTURE_SNAPSHOT, id: "snap-later" };
  const context = fakeContext({
    snapshots: [later, FIXTURE_SNAPSHOT],
    diff: {
      kind: "diff",
      diff: {
        earlier: FIXTURE_SNAPSHOT,
        later,
        totalDeltaBytes: -524288000n,
        directories: [
          { path: FIXTURE_ENTRY.path, kind: "shrank", earlierBytes: 19757268992n, laterBytes: 19232980992n, deltaBytes: -524288000n },
        ],
        uncertain: true,
        uncertainty: ["The earlier scan was incomplete."],
      },
    },
  });

  const status = await runCli(["snapshots", "diff", "--json"], context);
  const envelope = envelopeOf(context, "snapshots");

  assert.equal(status, 0);
  assert.equal(envelope.data.totalDeltaBytes, "-524288000");
  assert.equal(envelope.data.directories[0].deltaBytes, "-524288000");
  assert.equal(envelope.data.uncertain, true);
  assert.equal(envelope.data.uncertainty.length, 1);
});

test("snapshots rejects an action it does not have", async () => {
  const context = fakeContext();
  assert.equal(await runCli(["snapshots", "prune", "--json"], context), 2);
  assert.match(JSON.parse(context.captured.stdout).error.message, /'list' or 'diff'/);
});

test("the text surfaces stay readable at 80 columns", async () => {
  const scan = fakeContext();
  await runCli(["scan"], scan);
  assert.match(scan.captured.stdout, /Scanned \/home\/example\/projects/);
  assert.match(scan.captured.stdout, /shared hardlinks/);

  const explore = fakeContext();
  await runCli(["explore"], explore);
  for (const line of explore.captured.stdout.split("\n")) {
    assert.ok(line.length <= 80, `line over 80 columns: ${line}`);
  }

  const list = fakeContext();
  await runCli(["snapshots", "list"], list);
  assert.match(list.captured.stdout, /Scanned at/);
});

test("the scan options a person types are the ones the scan runs with", async () => {
  const context = fakeContext();
  await runCli(["scan", "--accounting", "apparent", "--cross-filesystems", "--throttle", "50MiB", "--max-depth", "6", "--json"], context);

  assert.deepEqual(context.recorded.scanOverrides, {
    accounting: "apparent",
    crossFilesystems: true,
    throttleBytesPerSecond: 52428800n,
    maxDepth: 6n,
  });
});

test("explore narrows the listing to the path it was given", async () => {
  const asked = [];
  const context = fakeContext();
  context.storage.explore.page = async (query) => {
    asked.push(query);
    return { kind: "page", page: { entries: [] } };
  };

  await runCli(["explore", "/home/example/projects/api", "--json"], context);

  // Without this the page ranks the whole scan and presents it as an answer
  // about the directory the user named.
  assert.equal(asked[0].filter.underPath.display, "/home/example/projects/api");
});

test("progress is drawn on stderr only when stderr is a terminal, and never beside JSON", async () => {
  // stdout at a terminal says nothing about where stderr goes: `scan 2>log`
  // must not fill the log with carriage-return progress lines.
  const redirected = fakeContext({ interactive: true, progress: false });
  await runCli(["scan"], redirected);
  assert.doesNotMatch(redirected.captured.stderr, /\r|Scanned \d+ entries/);

  const watched = fakeContext({ interactive: false, progress: true });
  await runCli(["scan"], watched);
  assert.match(watched.captured.stderr, /\rScanned 1000 entries/);
  assert.doesNotMatch(watched.captured.stdout, /\r/, "progress never reaches stdout");

  const json = fakeContext({ interactive: true, progress: true });
  await runCli(["scan", "--json"], json);
  assert.equal(json.captured.stderr, "");
  envelopeOf(json, "scan");
});

test("a mangled cursor or limit is refused in the envelope, not as a stack trace", async () => {
  const cursor = fakeContext();
  assert.equal(await runCli(["explore", "--cursor", "not a cursor!", "--json"], cursor), 2);
  assert.equal(JSON.parse(cursor.captured.stdout).error.code, "invalid-input");

  const limit = fakeContext();
  assert.equal(await runCli(["explore", "--limit", "abc", "--json"], limit), 2);
  assert.match(JSON.parse(limit.captured.stdout).error.message, /--limit/);
});

test("an unexpected failure still writes one envelope and exits 2", async () => {
  const context = fakeContext();
  context.storage.explore.page = async () => {
    throw new Error("the helper said something unrepeatable");
  };

  const status = await bootstrapCli(["explore", "--json"], "26.10.0", context.output, async () => context);
  const envelope = JSON.parse(context.captured.stdout);

  // Exit 1 would mean "alert threshold reached", so a script could not tell a
  // crash from a full disk.
  assert.equal(status, 2);
  assert.equal(envelope.status, "error");
  assert.equal(envelope.error.code, "internal-error");
  assert.match(envelope.error.message, /unrepeatable/);
});

const OWNERS = [
  { ownerId: 1000n, name: "alice", entries: 1200n, allocatedBytes: 9_000_000n, apparentBytes: 8_900_000n },
  { ownerId: 1001n, entries: 30n, allocatedBytes: 4096n, apparentBytes: 4000n },
];

function ownersContext({ snapshot = FIXTURE_SNAPSHOT, namesRead = true } = {}) {
  const asked = [];
  const context = fakeContext({ snapshots: [snapshot] });
  context.storage.explore.page = async (query) => {
    asked.push(query);
    return { kind: "page", page: { entries: [], owners: OWNERS, namesRead } };
  };
  return { context, asked };
}

test("explore --owners lists who owns the bytes under the path, with names where known", async () => {
  const { context, asked } = ownersContext();
  const status = await runCli(["explore", "--owners", "--json"], context);
  const envelope = envelopeOf(context, "explore");
  assert.equal(status, 0);
  assert.equal(asked[0].includeOwnerTotals, true);
  assert.deepEqual(envelope.data.owners[0], { ownerId: "1000", name: "alice", entries: "1200", allocatedBytes: "9000000", apparentBytes: "8900000" });
  assert.equal(envelope.data.owners[1].name, undefined);
});

test("owner totals from a scan that missed directories are floors, and say what would complete them", async () => {
  const partial = {
    ...FIXTURE_SNAPSHOT,
    completeness: { ...FIXTURE_SNAPSHOT.completeness, complete: false, inaccessibleDirectories: 3n, warnings: [{ code: "permission-denied", message: "3 directories could not be opened." }] },
  };
  const { context } = ownersContext({ snapshot: partial });
  const status = await runCli(["explore", "--owners", "--json"], context);
  const envelope = envelopeOf(context, "explore");
  assert.equal(status, 3);
  const floor = envelope.warnings.find((warning) => warning.code === "owners-floor");
  assert.match(floor.message, /floor/);
  assert.match(floor.message, /administrator/);
  assert.doesNotMatch(floor.message, /sudo npx/);
});

test("owners whose names could not be read are listed by id and the gap is said", async () => {
  const { context } = ownersContext({ namesRead: false });
  await runCli(["explore", "--owners", "--json"], context);
  const envelope = envelopeOf(context, "explore");
  assert.ok(envelope.warnings.some((warning) => warning.code === "passwd-unreadable"));
});

test("explore --owners in text names each owner and their share", async () => {
  const { context } = ownersContext();
  await runCli(["explore", "--owners"], context);
  assert.match(context.captured.stdout, /alice \(1000\)/);
  assert.match(context.captured.stdout, /user 1001/);
});

test("explore on a scan the index has since pruned says to scan again, not that Disktop broke", async () => {
  const { StaleScanIndex } = await import("../../dist/domain/errors.js");
  const context = fakeContext({
    storage: undefined,
  });
  context.storage.explore.page = async () => {
    throw new StaleScanIndex(FIXTURE_SNAPSHOT.scanId, "That scan is not in the index. It may have been pruned; run a new scan.");
  };
  const status = await runCli(["explore", "/home/example/projects", "--json"], context);
  assert.equal(status, 2);
  const envelope = envelopeOf(context, "explore");
  assert.equal(envelope.error.code, "invalid-input");
  assert.match(envelope.error.message, /disktop scan/);
});

test("explore shows a directory the scan never entered as unknown, or as measured as root, never as empty", async () => {
  const usb = { ...FIXTURE_ENTRY, id: "1", path: rawPath("/home/example/projects/usb"), allocatedBytes: 4096n, childEntries: undefined };
  const locked = { ...FIXTURE_ENTRY, id: "2", path: rawPath("/home/example/projects/locked"), allocatedBytes: 0n, childEntries: undefined };
  const measured = { ...FIXTURE_ENTRY, id: "3", path: rawPath("/home/example/projects/docker"), allocatedBytes: 0n, childEntries: undefined };
  const snapshot = {
    ...FIXTURE_SNAPSHOT,
    completeness: { ...FIXTURE_SNAPSHOT.completeness, complete: false, inaccessibleDirectories: 2n, excludedMounts: [usb.path], warnings: [{ code: "inaccessible-directory", message: "x" }] },
  };
  const context = fakeContext({
    snapshots: [snapshot],
    explorePage: { kind: "page", page: { entries: [usb, locked, measured] } },
    elevatedRecord: { scanId: snapshot.scanId, measuredAt: "2026-10-04T12:00:00.000Z", accounting: "allocated", measurements: [{ path: measured.path, bytes: 9n * 1024n ** 3n, children: [] }], skipped: [] },
  });
  await runCli(["explore", "/home/example/projects"], context);
  const lines = context.captured.stdout.split("\n");
  assert.match(lines.find((line) => line.endsWith("/usb (another mount, not scanned)")), /^\s*\?\s/);
  assert.match(lines.find((line) => line.endsWith("/locked (unreadable, size unknown)")), /^\s*\?\s/);
  assert.match(lines.find((line) => line.includes("/docker")), /9\.0 GiB .*unreadable; measured as root/);
});

test("scan --sudo measures what the scan could not read, and says so in its JSON", async () => {
  const incomplete = {
    ...FIXTURE_SNAPSHOT,
    completeness: { ...FIXTURE_SNAPSHOT.completeness, complete: false, inaccessibleDirectories: 1n, warnings: [{ code: "inaccessible-directory", message: "x" }] },
  };
  const record = { scanId: FIXTURE_SNAPSHOT.scanId, measuredAt: "2026-10-04T12:00:00.000Z", accounting: "allocated", measurements: [{ path: rawPath("/root"), bytes: 1024n, children: [] }], skipped: [] };
  const context = fakeContext({
    scanOutcome: { kind: "scanned", summary: { scanId: FIXTURE_SNAPSHOT.scanId, accounting: "allocated", roots: [rawPath("/")], completeness: incomplete.completeness, totals: FIXTURE_SNAPSHOT.totals, filesystems: [], crossFilesystems: false } },
    elevatedOutcome: { kind: "measured", record, totalBytes: 1024n, more: false, warnings: [] },
  });
  const status = await runCli(["scan", "/", "--sudo", "--json"], context);
  const envelope = envelopeOf(context, "scan");
  assert.equal(status, 3, "the index still cannot browse what root measured, so the scan stays incomplete");
  assert.equal(envelope.data.elevated.status, "measured");
  assert.equal(envelope.data.elevated.bytes, "1024");
  assert.equal(envelope.data.elevated.largest[0].path.display, "/root");
});
