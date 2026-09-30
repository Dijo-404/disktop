/**
 * The memory and latency budget from `docs/adr/0002-native-helper-and-index.md`.
 *
 * The point of the Rust helper and its disk-backed index is that Node's memory
 * is a function of page size rather than entry count. This measures that
 * claim rather than restating it: the same scan is run at two tree sizes and
 * the peak resident set is compared.
 *
 * `DISKTOP_BENCH_ENTRIES` sets the larger tree; the default keeps the suite
 * quick, and `npm run bench` raises it to the million-entry reference tree the
 * ADR names.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createLargeFixture } from "../fixtures/generate.mjs";

const MEBIBYTE = 1024 * 1024;
const NODE_RSS_BUDGET = 256 * MEBIBYTE;
const HELPER_RSS_BUDGET = 512 * MEBIBYTE;
const FIRST_PROGRESS_BUDGET_MS = 2_000;
const QUERY_BUDGET_MS = 200;

const LARGE = Number(process.env.DISKTOP_BENCH_ENTRIES ?? 100_000);
const SMALL = Math.max(2_000, Math.round(LARGE / 10));

const RELEASE_HELPER = "native/disktop-fs/target/release/disktop-fs";
const DEBUG_HELPER = "native/disktop-fs/target/debug/disktop-fs";
const helperPath = existsSync(RELEASE_HELPER) ? RELEASE_HELPER : DEBUG_HELPER;
/** A debug build is several times slower; its timings are reported, not enforced. */
const timingsAreBinding = helperPath === RELEASE_HELPER;

const homes = [];

async function disktopHome() {
  const home = await mkdtemp(join(tmpdir(), "disktop-bench-"));
  homes.push(home);
  return home;
}

after(async () => {
  for (const home of homes) {
    await rm(home, { recursive: true, force: true });
  }
});

function environment(home) {
  return {
    ...process.env,
    NO_COLOR: "1",
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
  };
}

/**
 * Peak resident set of the Node process alone, sampled from `/proc`.
 *
 * `VmHWM` is the kernel's own high-water mark, so it does not depend on how
 * often this samples. Measuring the Node process by PID keeps the helper's
 * memory out of the figure, which is the whole point: the claim under test is
 * about Node, and a combined number could hide either side.
 */
function peakBytes(args, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: environment(home), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let peak = 0;
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });

    const sample = setInterval(() => {
      peak = Math.max(peak, highWater(child.pid) ?? 0);
    }, 50);
    child.on("error", (error) => {
      clearInterval(sample);
      reject(error);
    });
    child.on("close", (status) => {
      clearInterval(sample);
      resolve({ bytes: peak, stdout, stderr, status });
    });
  });
}

/** A process's own high-water mark, read from its status file. */
function highWater(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /VmHWM:\s*(\d+) kB/.exec(status);
    return match === null ? undefined : Number(match[1]) * 1024;
  } catch {
    return undefined;
  }
}

const base64 = (text) => Buffer.from(text, "utf8").toString("base64");

/**
 * Drive the helper directly and time its first progress event, which is what
 * the budget is actually about: how long a person waits before the scan looks
 * alive.
 */
function timeHelperScan(root, indexDirectory) {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    const started = process.hrtime.bigint();
    let firstProgress;
    let peak = 0;
    let buffer = "";
    let result;

    const sample = setInterval(() => {
      peak = Math.max(peak, highWater(child.pid) ?? 0);
    }, 50);

    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.trim() === "") {
          continue;
        }
        const event = JSON.parse(line);
        if (event.event === "progress" && firstProgress === undefined) {
          firstProgress = Number(process.hrtime.bigint() - started) / 1e6;
        }
        if (event.event === "complete") {
          result = event.result;
          peak = Math.max(peak, highWater(child.pid) ?? 0);
          child.stdin.end();
        }
        if (event.event === "error") {
          reject(new Error(JSON.stringify(event.error)));
          child.stdin.end();
        }
      }
    });

    child.on("close", () => {
      clearInterval(sample);
      resolve({ firstProgress, peak, result });
    });
    child.on("error", reject);

    child.stdin.write(
      `${JSON.stringify({
        protocolVersion: 1,
        requestId: "bench-scan",
        operation: "scan",
        arguments: {
          roots: [base64(root)],
          crossFilesystems: false,
          excludes: [base64(indexDirectory)],
          accounting: "allocated",
          indexDirectory: base64(indexDirectory),
        },
      })}\n`,
    );
  });
}

test(
  `Node memory does not grow with entry count (${SMALL} against ${LARGE} entries)`,
  { timeout: 30 * 60_000 },
  async () => {
    const small = await createLargeFixture({ entries: SMALL, fanOut: 512 });
    const large = await createLargeFixture({ entries: LARGE, fanOut: 512 });
    try {
      const smallHome = await disktopHome();
      const largeHome = await disktopHome();
      const smallPeak = await peakBytes(["dist/bin/disktop.js", "scan", small.root, "--json"], smallHome);
      const largePeak = await peakBytes(["dist/bin/disktop.js", "scan", large.root, "--json"], largeHome);

      assert.notEqual(largePeak.bytes, 0, "the Node process's high-water mark could not be read");
      const summary = JSON.parse(largePeak.stdout);
      assert.equal(
        summary.data.completeness.complete,
        true,
        `the scan was partial: ${JSON.stringify(summary.warnings)}`,
      );
      assert.ok(
        BigInt(summary.data.completeness.scannedEntries) >= BigInt(large.entryCount),
        "the large tree was not fully walked",
      );

      process.stderr.write(
        `peak RSS: ${SMALL} entries -> ${(smallPeak.bytes / MEBIBYTE).toFixed(1)} MiB, ` +
          `${LARGE} entries -> ${(largePeak.bytes / MEBIBYTE).toFixed(1)} MiB\n`,
      );

      assert.ok(
        largePeak.bytes < NODE_RSS_BUDGET,
        `Node peak RSS ${(largePeak.bytes / MEBIBYTE).toFixed(1)} MiB exceeds the ${NODE_RSS_BUDGET / MEBIBYTE} MiB budget`,
      );
      // Ten times the entries must not mean ten times the memory. Allowing a
      // 50% rise leaves room for buffers and page-cache noise while still
      // failing if anything started accumulating per entry.
      assert.ok(
        largePeak.bytes < smallPeak.bytes * 1.5,
        `memory grew with the tree: ${(smallPeak.bytes / MEBIBYTE).toFixed(1)} MiB -> ${(largePeak.bytes / MEBIBYTE).toFixed(1)} MiB`,
      );

      // A page of the finished index is what the interactive budget covers.
      const started = process.hrtime.bigint();
      const page = spawnSync(process.execPath, ["dist/bin/disktop.js", "explore", large.root, "--limit", "50", "--json"], {
        encoding: "utf8",
        env: environment(largeHome),
      });
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      process.stderr.write(`explore page (including process start): ${elapsed.toFixed(0)} ms\n`);
      assert.equal(page.status, 0, page.stderr);
      assert.ok(JSON.parse(page.stdout).data.entries.length > 0);
      if (timingsAreBinding) {
        // The budget is the query itself; starting Node and spawning the
        // helper is measured with it here, so the bound is deliberately
        // generous.
        assert.ok(elapsed < QUERY_BUDGET_MS * 10, `an index page took ${elapsed.toFixed(0)} ms`);
      }
    } finally {
      await small.cleanup();
      await large.cleanup();
    }
  },
);

test("the helper reports progress quickly and stays inside its own budget", { timeout: 30 * 60_000 }, async () => {
  const fixture = await createLargeFixture({ entries: LARGE, fanOut: 512 });
  const home = await disktopHome();
  const indexDirectory = join(home, "cache", "disktop");
  try {
    const measured = await timeHelperScan(fixture.root, indexDirectory);
    process.stderr.write(
      `helper (${helperPath}): first progress ${measured.firstProgress?.toFixed(0) ?? "n/a"} ms, ` +
        `peak RSS ${(measured.peak / MEBIBYTE).toFixed(1)} MiB\n`,
    );

    assert.equal(
      measured.result.complete,
      true,
      `the scan was partial: ${JSON.stringify(measured.result.warnings)}`,
    );
    if (measured.peak > 0) {
      assert.ok(
        measured.peak < HELPER_RSS_BUDGET,
        `helper peak RSS ${(measured.peak / MEBIBYTE).toFixed(1)} MiB exceeds ${HELPER_RSS_BUDGET / MEBIBYTE} MiB`,
      );
    }
    // A tree small enough to finish inside one progress interval never emits
    // one, and that is correct behaviour rather than a missed budget.
    if (LARGE < 4096) {
      return;
    }
    assert.notEqual(measured.firstProgress, undefined, "the scan never reported progress");
    if (timingsAreBinding) {
      assert.ok(
        measured.firstProgress < FIRST_PROGRESS_BUDGET_MS,
        `first progress took ${measured.firstProgress.toFixed(0)} ms`,
      );
    }

  } finally {
    await fixture.cleanup();
  }
});
