import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "../../dist/cli/run.js";
import { compileBundle } from "../support/schemas.mjs";
import { FIXTURE_ENTRY, FIXTURE_SNAPSHOT, fakeContext } from "../support/cli-context.mjs";

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
