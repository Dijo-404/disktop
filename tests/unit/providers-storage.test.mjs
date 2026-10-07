import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  createSteamProvider,
  createSwapProvider,
  createSystemSnapshotsProvider,
  createVirtualMachineProvider,
  createWineProvider,
} from "../../dist/providers/storage/index.js";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

/** The fixture's swap table must not discover the host's hibernation files. */
function swapEnvironment() {
  const environment = environmentFor();
  const paths = environment.paths;
  const root = Buffer.from(`${fixture.root}/`);
  return {
    ...environment,
    paths: {
      ...paths,
      async facts(path) {
        const bytes = Buffer.from(path.bytesBase64, "base64");
        return bytes.subarray(0, root.length).equals(root) ? paths.facts(path) : undefined;
      },
    },
  };
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
    swapEnvironment(),
  );

  assert.equal(result.findings.length, 1);
  const swap = result.findings[0];
  assert.equal(swap.category, "swap");
  assert.deepEqual(swap.availableActionIds, []);
  assert.equal(swap.size.bytes, 8_589_930_496n, "kibibytes from /proc/swaps become bytes");
  assert.ok(swap.evidence.some((line) => line.includes("-2")), JSON.stringify(swap.evidence));
});

test("zram swap is memory, not disk, so it is not reported as space on a disk", async () => {
  // This machine's own /proc/swaps: compressed RAM first, then a real partition.
  const swaps = join(fixture.home, "swaps-with-zram");
  await writeFile(
    swaps,
    "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n" +
      "/dev/zram0                              partition\t16133116\t681160\t\t100\n" +
      "/dev/nvme0n1p5                          partition\t8388604\t\t0\t\t-2\n",
  );
  try {
    const result = await discover(createSwapProvider({ swapsPath: rawPathFromUtf8(swaps) }), swapEnvironment());
    assert.deepEqual(result.findings.map((finding) => finding.title), ["Swap partition /dev/nvme0n1p5"]);
    assert.equal(result.capability.status, "available");
  } finally {
    await rm(swaps, { force: true });
  }
});

test("a machine with no swap says so rather than reporting nothing", async () => {
  const result = await discover(
    createSwapProvider({ swapsPath: rawPathFromUtf8("/does/not/exist") }),
    swapEnvironment(),
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

test("btrfs refusing an ioctl on a filesystem that is not btrfs does not make every run incomplete", async () => {
  // `btrfs subvolume list /` prints exactly this on a non-btrfs root, and the
  // process adapter reads "not permitted" out of stderr as a denial. Treating
  // it as one made every machine with btrfs-progs installed exit 3 forever.
  const result = await discover(
    createSystemSnapshotsProvider({ timeshiftRoots: [] }),
    environmentFor({
      tools: {
        btrfs: {
          capability: { status: "permission-denied", explanation: "/usr/bin/btrfs could not be run by this user." },
          stderr: "ERROR: can't perform the search: Operation not permitted\n",
          exitCode: 1,
        },
      },
    }),
  );

  assert.equal(result.complete, true, "Disktop cannot tell this apart from a non-btrfs root");
  assert.ok(
    result.warnings.some((warning) => warning.code === "subvolumes-unavailable"),
    "it still says it could not read them",
  );
  const warning = result.warnings.find((candidate) => candidate.code === "subvolumes-unavailable");
  assert.ok(
    /not btrfs|needs privilege/i.test(warning.message),
    `the message must not assert a denial it cannot prove: ${warning.message}`,
  );
});

test("a btrfs that is not installed is absent, with nothing said about it", async () => {
  const result = await discover(
    createSystemSnapshotsProvider({ timeshiftRoots: [] }),
    environmentFor(),
  );

  assert.deepEqual(result.warnings, [], "a machine with no btrfs-progs has no btrfs to report on");
  assert.equal(result.complete, true);
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

test("a Steam manifest cannot colour the terminal or break its own finding id", async () => {
  const hostile = join(fixture.paths.steamApps, "appmanifest_4242.acf");
  await writeFile(
    hostile,
    '"AppState"\n{\n\t"appid"\t\t"4242"\n\t"name"\t\t"Game\u001b[31mRED"\n\t"installdir"\t\t"My Game"\n\t"SizeOnDisk"\t\t"1024"\n}\n',
  );
  try {
    const result = await discover(createSteamProvider(), environmentFor());

    const game = result.findings.find((finding) => finding.id.includes("4242"));
    assert.ok(game !== undefined, JSON.stringify(result.findings.map((finding) => finding.id)));
    assert.ok(!game.title.includes("\u001b"), JSON.stringify(game.title));

    const prefix = result.findings.find((finding) => finding.title.includes("Proton"));
    for (const finding of result.findings) {
      assert.match(finding.id, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/, finding.id);
      assert.ok(finding.id.length <= 256, finding.id);
    }
    void prefix;
  } finally {
    await rm(hostile);
  }
});

test("a Steam install directory that tries to climb out of the library is refused", async () => {
  const escaping = join(fixture.paths.steamApps, "appmanifest_4243.acf");
  await writeFile(
    escaping,
    '"AppState"\n{\n\t"appid"\t\t"4243"\n\t"name"\t\t"Escaping"\n\t"installdir"\t\t"../../../../etc"\n\t"SizeOnDisk"\t\t"1024"\n}\n',
  );
  try {
    const result = await discover(createSteamProvider(), environmentFor());

    assert.ok(
      !displays(result.findings).some((path) => path.includes("..")),
      JSON.stringify(displays(result.findings)),
    );
    assert.ok(
      result.warnings.some((warning) => warning.code === "unreadable-manifest"),
      JSON.stringify(result.warnings),
    );
  } finally {
    await rm(escaping);
  }
});

test("a ZFS dataset with a very long name still produces a schema-valid id", async () => {
  const result = await discover(
    createSystemSnapshotsProvider({ timeshiftRoots: [] }),
    environmentFor({
      tools: { zfs: { stdout: `tank/${"d".repeat(300)}@snap\t4096\n` } },
    }),
  );

  assert.equal(result.findings.length, 1);
  assert.ok(result.findings[0].id.length <= 256, `${result.findings[0].id.length} characters`);
  assert.match(result.findings[0].id, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
});

test("denied ZFS discovery keeps the readable snapshots and marks the result incomplete", async () => {
  const result = await discover(
    createSystemSnapshotsProvider({ timeshiftRoots: [] }),
    environmentFor({
      tools: {
        btrfs: { stdout: "ID 256 gen 12 top level 5 path @\n" },
        zfs: {
          capability: { status: "permission-denied", explanation: "zfs list could not be run by this user.\u001b[31m" },
          stderr: "permission denied\n",
          exitCode: 1,
        },
      },
    }),
  );
  assert.equal(result.complete, false);
  assert.equal(result.findings.length, 1, "another readable source is preserved");
  assert.deepEqual(result.findings[0].availableActionIds, []);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, "zfs-denied");
  assert.match(result.warnings[0].message, /ZFS|read access/);
  assert.ok(!result.warnings[0].message.includes("\u001b"));
});

test("an absent ZFS executable is benign and an empty successful query is complete", async () => {
  for (const tools of [{}, { zfs: { stdout: "" } }]) {
    const result = await discover(createSystemSnapshotsProvider({ timeshiftRoots: [] }), environmentFor({ tools }));
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.complete, true);
  }
});

test("failed, timed-out and unsupported ZFS queries cannot report complete empty discovery", async () => {
  const failures = [
    { capability: { status: "missing-tool", explanation: "zfs failed: cannot open /dev/zfs" }, stderr: "cannot open /dev/zfs", exitCode: 1 },
    { capability: { status: "missing-tool", explanation: "/usr/sbin/zfs disappeared before it could run." }, exitCode: null },
    { capability: { status: "missing-tool", explanation: "zfs did not finish within 10000 ms and was stopped." }, exitCode: null },
    { capability: { status: "available", explanation: "zfs responded." }, exitCode: 1 },
    ...["unsupported-kernel", "unsupported-filesystem", "unsupported-architecture"].map((status) => ({
      capability: { status, explanation: `ZFS query is ${status}.` }, exitCode: null,
    })),
  ];
  for (const zfs of failures) {
    const environment = environmentFor();
    const originalTools = environment.tools;
    environment.tools = {
      async run(name, argv) {
        return name === "zfs"
          ? { capability: zfs.capability, stdout: "", stderr: zfs.stderr ?? "", exitCode: zfs.exitCode }
          : originalTools.run(name, argv);
      },
    };
    const result = await discover(createSystemSnapshotsProvider({ timeshiftRoots: [] }), environment);
    assert.equal(result.complete, false, zfs.capability.explanation);
    assert.deepEqual(result.findings, []);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, "zfs-unavailable");
    assert.match(result.warnings[0].message, /query the pool/);
  }
});

test("malformed ZFS rows make discovery incomplete without losing valid rows", async () => {
  const result = await discover(
    createSystemSnapshotsProvider({ timeshiftRoots: [] }),
    environmentFor({ tools: { zfs: { stdout: "tank/data@good\t4096\nnot-a-snapshot\t2048\ntank/data@bad\tunknown\ntank/data@extra\t1\textra\n" } } }),
  );
  assert.equal(result.complete, false);
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].title, /good/);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, "zfs-output-unreadable");
  assert.match(result.warnings[0].message, /3 ZFS snapshot rows were unreadable/);
});

test("snapshot queries receive cancellation and an aborted result is never returned as empty success", async () => {
  for (const cancelDuring of ["btrfs", "zfs"]) {
    const controller = new AbortController();
    const calls = [];
    const environment = environmentFor();
    environment.tools = {
      async run(name, _argv, signal) {
        assert.equal(signal, controller.signal);
        calls.push(name);
        if (name === cancelDuring) controller.abort();
        return { capability: { status: "missing-tool", explanation: `${name} is not installed.` }, stdout: "", stderr: "", exitCode: null };
      },
    };
    await assert.rejects(
      createSystemSnapshotsProvider({ timeshiftRoots: [] }).discover(environment, controller.signal),
      { name: "AbortError" },
    );
    assert.deepEqual(calls, cancelDuring === "btrfs" ? ["btrfs"] : ["btrfs", "zfs"]);
  }
});
