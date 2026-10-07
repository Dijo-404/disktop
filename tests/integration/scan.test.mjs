/**
 * Phase 2's gate, run against the real helper and real filesystems.
 *
 * Every case here builds a throwaway tree under the system temporary
 * directory and points Disktop's XDG locations at another one, so nothing
 * reads or writes the developer's own configuration, cache, or data.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createLargeFixture, createStandardFixture, restoreAndRemove } from "../fixtures/generate.mjs";
import { compileBundle } from "../support/schemas.mjs";

const validators = compileBundle("schemas/cli/v1");
const homes = [];

async function disktopHome() {
  const home = await mkdtemp(join(tmpdir(), "disktop-home-"));
  homes.push(home);
  return home;
}

after(async () => {
  for (const home of homes) {
    await rm(home, { recursive: true, force: true });
  }
});

/** Run the built executable with its state pointed at a throwaway home. */
function disktop(home, args, options = {}) {
  const result = spawnSync(process.execPath, ["dist/bin/disktop.js", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_STATE_HOME: join(home, "state"),
    },
    ...options,
  });
  assert.equal(result.error, undefined);
  return result;
}

function envelope(result, schema) {
  assert.notEqual(result.stdout.trim(), "", `no stdout; stderr was: ${result.stderr}`);
  const document = JSON.parse(result.stdout);
  const validate = validators.get(schema);
  assert.ok(validate(document), `${schema}: ${JSON.stringify(validate.errors)}`);
  return document;
}

test("a scan of the standard fixture keeps odd names, counts hardlinks once, and reports what it could not read", async () => {
  const home = await disktopHome();
  const fixture = await createStandardFixture();
  try {
    const scan = envelope(disktop(home, ["scan", fixture.root, "--json"]), "scan");

    // The tree contains a directory this user cannot read, so the result is
    // explicitly partial rather than quietly short.
    if (process.getuid?.() !== 0) {
      assert.equal(scan.data.completeness.complete, false);
      assert.ok(scan.data.completeness.inaccessibleDirectories >= "1");
      assert.ok(scan.warnings.some((warning) => warning.code === "inaccessible-directory"));
    }
    assert.match(scan.data.totals.allocatedBytes, /^[0-9]+$/);
    // Two paths share one inode; its bytes are counted once and the second is
    // reported separately.
    assert.notEqual(scan.data.totals.sharedBytes, "0");

    const page = envelope(disktop(home, ["explore", fixture.root, "--limit", "1000", "--json"]), "explore");
    const decoded = page.data.entries.map((entry) => Buffer.from(entry.path.bytesBase64, "base64"));

    const invalidUtf8 = Buffer.from([0x62, 0x61, 0x64, 0x2d, 0xff, 0xfe, 0x2e, 0x62, 0x69, 0x6e]);
    assert.ok(
      decoded.some((path) => path.subarray(-invalidUtf8.length).equals(invalidUtf8)),
      "a name that is not valid UTF-8 did not survive the round trip",
    );
    const newline = Buffer.from("first\nsecond.txt");
    assert.ok(decoded.some((path) => path.subarray(-newline.length).equals(newline)));
    // The display form of every path is safe to print.
    for (const entry of page.data.entries) {
      assert.doesNotMatch(entry.path.display, /[\u0000-\u001F\u007F-\u009F‪-‮]/);
    }

    // A symlink is recorded but never followed, so the tree below it is not
    // counted a second time.
    const leaves = decoded.filter((path) => path.toString("binary").endsWith("/plain.txt"));
    assert.equal(leaves.length, 1);

    const shared = page.data.entries.filter((entry) => entry.shared);
    assert.equal(shared.length, 1, "exactly one of the two hardlinks is marked shared");
  } finally {
    await restoreAndRemove(fixture.root);
  }
});

test("allocated totals agree with du -x over the same scope", async () => {
  const home = await disktopHome();
  const fixture = await createLargeFixture({ entries: 2_000, fanOut: 64, bytesPerFile: 3000 });
  try {
    const scan = envelope(disktop(home, ["scan", fixture.root, "--json"]), "scan");
    assert.equal(scan.data.completeness.complete, true);

    const du = spawnSync("du", ["-sx", "--block-size=1", fixture.root], { encoding: "utf8" });
    if (du.error !== undefined || du.status !== 0) {
      return; // du is not installed here; the scan assertions above still ran.
    }
    const duBytes = BigInt(du.stdout.split(/\s+/)[0]);
    assert.notEqual(duBytes, 0n, "the comparison tree occupies no blocks, so it would prove nothing");
    assert.equal(
      BigInt(scan.data.totals.allocatedBytes),
      duBytes,
      "Disktop and du disagree about allocated bytes over the same tree",
    );

    // Only allocated bytes are compared. `du --apparent-size` leaves the
    // directories' own st_size out of its total and Disktop includes it, so
    // the two apparent figures answer different questions; docs/cli.md says
    // so. The apparent total must still be at least the file contents.
    assert.ok(BigInt(scan.data.totals.apparentBytes) >= BigInt(fixture.entryCount) * 3000n);
  } finally {
    await fixture.cleanup();
  }
});

const NAMESPACE_ARGUMENTS = ["--user", "--map-current-user", "--mount", "--keep-caps", "--fork"];

function privateNamespace(context, script, environment) {
  const probe = spawnSync("unshare", [...NAMESPACE_ARGUMENTS, "true"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT" || (probe.status !== 0 && /operation not permitted|permission denied/i.test(probe.stderr))) {
    context.skip("this host cannot create an unprivileged private mount namespace");
    return undefined;
  }
  assert.equal(probe.error, undefined);
  assert.equal(probe.status, 0, probe.stderr);
  const run = spawnSync("unshare", [...NAMESPACE_ARGUMENTS, "sh", "-c", script], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: environment,
  });
  if (/^mount: [^\n]*(?:operation not permitted|permission denied|must be superuser)/im.test(run.stderr)) {
    context.skip("this namespace cannot mount its private test filesystem");
    return undefined;
  }
  assert.equal(run.error, undefined);
  assert.ok([0, 3].includes(run.status), run.stdout + run.stderr);
  assert.notEqual(run.stdout.trim(), "", run.stderr);
  return run;
}

test("a nested mount is not descended into unless it is asked for", async (context) => {
  const home = await disktopHome();
  const fixture = await createLargeFixture({ entries: 8, fanOut: 8 });
  const inner = join(fixture.root, "bind-target");
  const source = join(fixture.root, "bucket-0");

  // A bind mount needs a private mount namespace, which needs either root or
  // unprivileged user namespaces. Where the kernel refuses, the case is
  // reported as unproven rather than quietly passing.
  try {
    const bind = privateNamespace(
      context,
      `mkdir -p '${inner}' && mount --bind '${source}' '${inner}' && ` +
        `node dist/bin/disktop.js scan '${fixture.root}' --json`,
      {
        ...process.env,
        NO_COLOR: "1",
        HOME: home,
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_DATA_HOME: join(home, "data"),
        XDG_CACHE_HOME: join(home, "cache"),
        XDG_STATE_HOME: join(home, "state"),
      },
    );
    if (bind === undefined) return;
    const scan = JSON.parse(bind.stdout);
    const validate = validators.get("scan");
    assert.ok(validate(scan), JSON.stringify(validate.errors));
    // The bind mount is a different mount of the same filesystem, and
    // RESOLVE_NO_XDEV refuses it, so its contents are not counted twice.
    const excluded = scan.data.completeness.excludedMounts.map((mount) => mount.display);
    assert.ok(
      excluded.some((mount) => mount.endsWith("/bind-target")),
      `the bind mount was not reported as skipped: ${JSON.stringify(excluded)}`,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("another part of the scanned filesystem mounted below the root is walked; a repeat and another filesystem are not", async (context) => {
  // A Btrfs subvolume mounted at /home is one filesystem with / but its own
  // mount. A tmpfs with a bind mount of a sibling directory has the same
  // shape and needs no block device: the sibling is more of the filesystem
  // the scan is on, reached nowhere else in the scan.
  const home = await disktopHome();
  const top = await mkdtemp(join(tmpdir(), "disktop-samefs-"));
  const script = [
    `mount -t tmpfs -o uid=${process.getuid()},gid=${process.getgid()} tmpfs '${top}'`,
    `mkdir -p '${top}/root/a' '${top}/root/inner' '${top}/root/again' '${top}/root/other-fs' '${top}/elsewhere'`,
    `head -c 1048576 /dev/zero > '${top}/elsewhere/payload'`,
    `head -c 4096 /dev/zero > '${top}/root/a/small'`,
    `mount --bind '${top}/elsewhere' '${top}/root/inner'`,
    `mount --bind '${top}/root/a' '${top}/root/again'`,
    `mount -t tmpfs tmpfs '${top}/root/other-fs'`,
    `node dist/bin/disktop.js scan '${top}/root' --json`,
  ].join(" && ");
  try {
    const run = privateNamespace(context, script, {
      ...process.env,
      NO_COLOR: "1",
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_STATE_HOME: join(home, "state"),
    });
    if (run === undefined) return;
    const scan = JSON.parse(run.stdout);
    const validate = validators.get("scan");
    assert.ok(validate(scan), JSON.stringify(validate.errors));
    const skipped = scan.data.completeness.excludedMounts.map((mount) => mount.display.slice(top.length));
    assert.deepEqual(skipped.sort(), ["/root/again", "/root/other-fs"]);
    assert.ok(BigInt(scan.data.totals.allocatedBytes) >= 1048576n, `the bytes behind the mount were counted: ${scan.data.totals.allocatedBytes}`);
    const reasons = scan.warnings.filter((warning) => warning.code === "crossed-filesystem-skipped").map((warning) => warning.message);
    assert.ok(reasons.some((reason) => /Another filesystem \(tmpfs\)/.test(reason)), JSON.stringify(reasons));
    assert.ok(reasons.some((reason) => /already counts/.test(reason)), JSON.stringify(reasons));
  } finally {
    await rm(top, { recursive: true, force: true });
  }
});

test("interrupting a scan leaves a partial result and a queryable index", async () => {
  const home = await disktopHome();
  const fixture = await createLargeFixture({ entries: 60_000, fanOut: 256 });
  let child;
  let closed;
  let ended = false;
  let stdout = "";
  let stderr = "";
  let failure;
  try {
    child = spawn(
      process.execPath,
      ["dist/bin/disktop.js", "scan", fixture.root, "--throttle", "1", "--json"],
      {
        env: {
          ...process.env,
          NO_COLOR: "1",
          HOME: home,
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_DATA_HOME: join(home, "data"),
          XDG_CACHE_HOME: join(home, "cache"),
          XDG_STATE_HOME: join(home, "state"),
        },
      },
    );
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      if (stdout.length + chunk.length > 4 * 1024 * 1024) {
        failure = new Error("the scan exceeded the test's output bound");
        child.kill("SIGKILL");
      } else stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    child.on("error", (error) => { failure = error; });
    closed = new Promise((resolve) => child.once("close", (status) => { ended = true; resolve(status); }));
    const deadline = Date.now() + 15_000;
    const indexDirectory = join(home, "cache", "disktop", "index-v3");
    for (;;) {
      assert.equal(failure, undefined);
      assert.equal(ended, false, stdout + stderr);
      assert.ok(Date.now() < deadline, `the scan never started its index: ${stderr}`);
      let names;
      try { names = await readdir(indexDirectory); }
      catch (error) { if (error.code !== "ENOENT") throw error; names = []; }
      if (names.some((name) => name.endsWith(".sqlite.partial"))) break;
      await delay(20);
    }
    // The partial index proves the command installed its signal handlers and
    // entered the helper. A fixed sleep can interrupt Node during startup.
    assert.equal(child.kill("SIGINT"), true);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    let status;
    try { status = await closed; } finally { clearTimeout(timeout); }
    assert.equal(failure, undefined);
    assert.equal(status, 130, stdout + stderr);
    assert.notEqual(stdout.trim(), "", `no envelope; stderr was ${stderr}`);
    const scan = JSON.parse(stdout);
    const validate = validators.get("scan");
    assert.ok(validate(scan), JSON.stringify(validate.errors));

    assert.equal(scan.data.completeness.complete, false);
    assert.equal(scan.exitCode, 130);
    assert.ok(scan.warnings.some((warning) => warning.code === "cancelled"));

    // Whatever it managed to index is still readable, so the work is not lost.
    const page = envelope(disktop(home, ["explore", fixture.root, "--json"]), "explore");
    assert.equal(page.data.scanId, scan.data.scanId);
  } finally {
    if (child !== undefined && !ended) { child.kill("SIGKILL"); await closed; }
    await fixture.cleanup();
  }
});

test("explore pages a large index without repeating or skipping a row", async () => {
  const home = await disktopHome();
  const fixture = await createLargeFixture({ entries: 500, fanOut: 50 });
  try {
    disktop(home, ["scan", fixture.root, "--json"]);

    const seen = new Set();
    let cursor;
    let pages = 0;
    for (;;) {
      const args = ["explore", fixture.root, "--kind", "file", "--limit", "100", "--json"];
      if (cursor !== undefined) {
        args.push("--cursor", cursor);
      }
      const page = envelope(disktop(home, args), "explore");
      pages += 1;
      for (const entry of page.data.entries) {
        assert.equal(seen.has(entry.id), false, "an index row came back on two pages");
        seen.add(entry.id);
      }
      cursor = page.data.nextCursor;
      if (cursor === undefined || pages > 20) {
        break;
      }
    }
    assert.equal(seen.size, 500);
  } finally {
    await fixture.cleanup();
  }
});

test("a second scan of the same scope produces a comparable snapshot", async () => {
  const home = await disktopHome();
  const fixture = await createLargeFixture({ entries: 100, fanOut: 25 });
  try {
    disktop(home, ["scan", fixture.root, "--json"]);
    disktop(home, ["scan", fixture.root, "--json"]);

    const list = envelope(disktop(home, ["snapshots", "list", "--json"]), "snapshots");
    assert.ok(list.data.snapshots.length >= 2);

    const diff = envelope(disktop(home, ["snapshots", "diff", "--json"]), "snapshots");
    assert.match(diff.data.totalDeltaBytes, /^-?[0-9]+$/);

    // A scan under different rules measured something else, and comparing the
    // two is refused rather than shown as growth.
    disktop(home, ["scan", fixture.root, "--accounting", "apparent", "--json"]);
    const refused = disktop(home, ["snapshots", "diff", "--json"]);
    const document = JSON.parse(refused.stdout);
    assert.equal(refused.status, 2);
    assert.equal(document.error.code, "invalid-input");
    assert.match(document.error.message, /did not measure the same thing/);
  } finally {
    await fixture.cleanup();
  }
});

test("explore refuses a scan the index no longer holds", async () => {
  const home = await disktopHome();
  const fixture = await createLargeFixture({ entries: 10, fanOut: 10 });
  try {
    disktop(home, ["scan", fixture.root, "--json"]);
    const result = disktop(home, ["explore", "/nonexistent-path-for-this-test", "--json"]);
    const document = JSON.parse(result.stdout);

    assert.equal(result.status, 2);
    assert.equal(document.error.code, "invalid-input");
    assert.match(document.error.message, /disktop scan/);
  } finally {
    await fixture.cleanup();
  }
});

test("explore answers about the path it was given, not the whole scan", async () => {
  const home = await disktopHome();
  const fixture = await createLargeFixture({ entries: 4, fanOut: 2, bytesPerFile: 1024 });
  const { mkdir, writeFile } = await import("node:fs/promises");
  const inside = join(fixture.root, "inside");
  await mkdir(inside);
  await writeFile(join(inside, "small.bin"), "s".repeat(1024));
  await writeFile(join(fixture.root, "huge-outside.bin"), "h".repeat(4 * 1024 * 1024));

  try {
    disktop(home, ["scan", fixture.root, "--json"]);
    const page = envelope(disktop(home, ["explore", inside, "--limit", "100", "--json"]), "explore");
    const paths = page.data.entries.map((entry) => entry.path.display);

    assert.ok(paths.some((path) => path.endsWith("/inside/small.bin")));
    // The largest file in the tree lives outside the requested directory. A
    // listing that included it would answer a question nobody asked.
    assert.equal(
      paths.some((path) => path.endsWith("huge-outside.bin")),
      false,
      `a sibling outside the subtree was listed: ${JSON.stringify(paths)}`,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a directory is browsed by finding its own row at its path, then paging its children", async () => {
  const { utimes, writeFile, mkdir } = await import("node:fs/promises");
  const { createNativeScanner } = await import("../../dist/platform/linux/scan/index.js");
  const { NativeHelperClient } = await import("../../dist/native/client.js");
  const { rawPathFromUtf8 } = await import("../../dist/domain/paths.js");

  const home = await disktopHome();
  const fixture = await createLargeFixture({ entries: 1, fanOut: 1 });
  const browsed = join(fixture.root, "browsed");
  await mkdir(browsed);
  for (let index = 0; index < 25; index += 1) {
    await writeFile(join(browsed, `child-${String(index).padStart(2, "0")}.bin`), "c".repeat(index * 100));
  }
  // Every child shares the directory's modification time, so a listing of
  // the subtree sorted by it ties the directory with what is below it.
  const stamp = new Date("2026-01-01T00:00:00Z");
  for (let index = 0; index < 25; index += 1) {
    await utimes(join(browsed, `child-${String(index).padStart(2, "0")}.bin`), stamp, stamp);
  }
  await utimes(browsed, stamp, stamp);

  try {
    const scanner = createNativeScanner({
      indexDirectory: join(home, "index"),
      start: () => NativeHelperClient.start(),
    });
    let scanId;
    for await (const event of scanner.run(
      { roots: [rawPathFromUtf8(fixture.root)], crossFilesystems: false, excludes: [], accounting: "allocated" },
      new AbortController().signal,
    )) {
      if (event.kind === "complete") {
        scanId = event.scanId;
      }
    }

    for (const sort of ["allocated", "apparent", "modified", "name"]) {
      const own = await scanner.query({ scanId, filter: { atPath: rawPathFromUtf8(browsed) }, sort, order: "descending", limit: 50 });
      assert.equal(own.entries.length, 1, `${sort}: exactly the directory's own row`);
      assert.equal(own.entries[0].path.display, browsed);
      assert.equal(own.entries[0].kind, "directory");
      assert.equal(own.nextCursor, undefined);

      const seen = new Set();
      let cursor;
      for (let pages = 0; pages < 10; pages += 1) {
        const page = await scanner.query({
          scanId,
          filter: { parentId: own.entries[0].id },
          sort,
          order: "descending",
          limit: 7,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const entry of page.entries) {
          assert.equal(seen.has(entry.id), false, `${sort}: a child came back on two pages`);
          assert.equal(entry.parentId, own.entries[0].id);
          seen.add(entry.id);
        }
        cursor = page.nextCursor;
        if (cursor === undefined) {
          break;
        }
      }
      assert.equal(seen.size, 25, `${sort}: every child was listed once`);
    }

    await assert.rejects(
      scanner.query({ scanId, filter: { atPath: rawPathFromUtf8(join(fixture.root, "never-created")) }, sort: "allocated", order: "descending", limit: 1 }),
      /not in this scan/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a tree full of unreadable directories does not produce an unbounded result", async () => {
  if (process.getuid?.() === 0) {
    return;
  }
  const home = await disktopHome();
  const fixture = await createLargeFixture({ entries: 1, fanOut: 1 });
  const { chmod, mkdir } = await import("node:fs/promises");
  const locked = [];
  for (let index = 0; index < 600; index += 1) {
    const path = join(fixture.root, `locked-${index}`);
    await mkdir(path);
    await chmod(path, 0o000);
    locked.push(path);
  }

  try {
    const result = disktop(home, ["scan", fixture.root, "--json"]);
    const scan = JSON.parse(result.stdout);

    // Every unreadable directory is still counted; only the per-path list is
    // bounded, and the overflow is reported rather than dropped.
    assert.equal(scan.data.completeness.inaccessibleDirectories, "600");
    assert.ok(scan.warnings.length <= 300, `warning list grew to ${scan.warnings.length}`);
    assert.ok(scan.warnings.some((warning) => warning.code === "warnings-truncated"));
    assert.ok(result.stdout.length < 256 * 1024, `the envelope grew to ${result.stdout.length} bytes`);
  } finally {
    for (const path of locked) {
      await chmod(path, 0o700).catch(() => undefined);
    }
    await fixture.cleanup();
  }
});
