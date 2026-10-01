import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  createSteamProvider,
  createSwapProvider,
  createSystemSnapshotsProvider,
  createVirtualMachineProvider,
  createWineProvider,
} from "../../dist/providers/storage/index.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";
import { createStorageFixture } from "../fixtures/generate.mjs";
import { discover, discoveryEnvironment, displays } from "../support/discovery.mjs";

let fixture;

before(async () => {
  fixture = await createStorageFixture();
});

after(async () => {
  await fixture.cleanup();
});

function environmentFor(overrides = {}) {
  return discoveryEnvironment(fixture.home, overrides);
}

function findByPath(findings, path) {
  return findings.find((finding) => finding.paths.some((candidate) => candidate.display === path));
}

test("a Steam game reports the size Steam itself claims, labelled as Steam's", async () => {
  const result = await discover(createSteamProvider(), environmentFor());

  const game = findByPath(result.findings, fixture.paths.steamGame);
  assert.ok(game !== undefined, JSON.stringify(displays(result.findings)));
  assert.equal(game.size.bytes, 4_294_967_296n);
  assert.equal(game.size.basis, "manager-reported");
  assert.match(game.size.explanation, /Steam/);
});

test("a malformed manifest becomes an unknown size and a warning, never a zero", async () => {
  const result = await discover(createSteamProvider(), environmentFor());

  const broken = result.findings.find((finding) => finding.title.includes("Broken Game"));
  assert.ok(broken !== undefined, JSON.stringify(result.findings.map((finding) => finding.title)));
  assert.equal(broken.size.bytes, undefined);
  assert.equal(broken.size.basis, "unknown");
  assert.ok(result.warnings.some((warning) => warning.code === "unreadable-manifest"), JSON.stringify(result.warnings));
});

test("a Proton prefix is reported apart from the game it belongs to", async () => {
  const result = await discover(createSteamProvider(), environmentFor());

  const prefix = findByPath(result.findings, fixture.paths.protonPrefix);
  assert.ok(prefix !== undefined, JSON.stringify(displays(result.findings)));
  assert.equal(prefix.category, "game-data");
});

test("a Wine prefix is found by its registry file", async () => {
  const result = await discover(createWineProvider(), environmentFor());

  const prefix = findByPath(result.findings, fixture.paths.wine);
  assert.ok(prefix !== undefined, JSON.stringify(displays(result.findings)));
  assert.ok(prefix.evidence.some((line) => line.includes("system.reg")), JSON.stringify(prefix.evidence));
});

test("a sparse image reports both numbers and says which is which", async () => {
  const result = await discover(createVirtualMachineProvider(), environmentFor());

  const image = findByPath(result.findings, fixture.paths.boxesImage);
  assert.ok(image !== undefined, JSON.stringify(displays(result.findings)));
  assert.equal(image.size.basis, "stat");
  assert.ok(image.size.bytes < 67_108_864n, "a sparse image occupies far less than it claims");
  assert.match(image.size.explanation, /67108864|claims/);
});

test("a disk image cannot be proved idle without privilege, so it is uncertain and in use", async () => {
  const result = await discover(createVirtualMachineProvider(), environmentFor());

  const image = findByPath(result.findings, fixture.paths.boxesImage);
  assert.equal(image.confidence, "uncertain");
  assert.equal(image.active, true);
  assert.deepEqual(image.availableActionIds, []);
});

test("a file beside an image that is not an image is left alone", async () => {
  const result = await discover(createVirtualMachineProvider(), environmentFor());

  assert.ok(!displays(result.findings).includes(fixture.paths.boxesNotes));
});

test("swap is read from /proc/swaps and offers no action at all", async () => {
  const result = await discover(
    createSwapProvider({ swapsPath: rawPathFromUtf8(fixture.paths.swaps) }),
    environmentFor(),
  );

  assert.equal(result.findings.length, 1);
  const swap = result.findings[0];
  assert.equal(swap.category, "swap");
  assert.deepEqual(swap.availableActionIds, []);
  assert.equal(swap.size.bytes, 8_589_930_496n, "kibibytes from /proc/swaps become bytes");
  assert.ok(swap.evidence.some((line) => line.includes("-2")), JSON.stringify(swap.evidence));
});

test("a machine with no swap says so rather than reporting nothing", async () => {
  const result = await discover(
    createSwapProvider({ swapsPath: rawPathFromUtf8("/does/not/exist") }),
    environmentFor(),
  );

  assert.notEqual(result.capability.status, "available");
  assert.deepEqual(result.findings, []);
});

test("Timeshift snapshots are reported read-only, with what deleting one may not free", async () => {
  const result = await discover(
    createSystemSnapshotsProvider({ timeshiftRoots: [rawPathFromUtf8(fixture.paths.timeshift)] }),
    environmentFor(),
  );

  const snapshot = result.findings.find((finding) => finding.category === "system-snapshot");
  assert.ok(snapshot !== undefined, JSON.stringify(result.findings.map((finding) => finding.title)));
  assert.deepEqual(snapshot.availableActionIds, []);
  assert.ok(
    snapshot.evidence.some((line) => /shar|free|nothing/i.test(line)),
    JSON.stringify(snapshot.evidence),
  );
});

test("a machine with no btrfs is absent, not incomplete", async () => {
  const result = await discover(
    createSystemSnapshotsProvider({ timeshiftRoots: [rawPathFromUtf8(fixture.paths.timeshift)] }),
    environmentFor(),
  );

  assert.deepEqual(result.warnings, [], "a feature this machine does not have is not a missed reading");
  assert.equal(result.complete, true);
});

test("a btrfs that refuses to answer makes the result incomplete and says so", async () => {
  const result = await discover(
    createSystemSnapshotsProvider({ timeshiftRoots: [] }),
    environmentFor({
      tools: {
        btrfs: {
          capability: { status: "permission-denied", explanation: "/usr/bin/btrfs could not be run by this user." },
          exitCode: 1,
        },
      },
    }),
  );

  assert.ok(
    result.warnings.some((warning) => warning.code === "subvolumes-unavailable"),
    JSON.stringify(result.warnings),
  );
  assert.equal(result.complete, false);
});

test("btrfs subvolumes are read when the tool answers", async () => {
  const result = await discover(
    createSystemSnapshotsProvider({ timeshiftRoots: [] }),
    environmentFor({
      tools: {
        btrfs: {
          stdout: "ID 256 gen 12 top level 5 path @\nID 257 gen 44 top level 5 path @home\nID 312 gen 90 top level 5 path timeshift-btrfs/snapshots/2026-09-01/@\n",
        },
      },
    }),
  );

  const titles = result.findings.map((finding) => finding.title);
  assert.ok(titles.some((title) => title.includes("@home")), JSON.stringify(titles));
  for (const finding of result.findings) {
    assert.deepEqual(finding.availableActionIds, [], `${finding.id} offered an action`);
  }
});
