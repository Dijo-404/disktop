/**
 * Footprint measurement against the real helper.
 *
 * Everything here lives under a throwaway tree in the system temporary
 * directory, including the index the helper writes, so no reading touches the
 * developer's own cache or data.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createIndexFootprint } from "../../dist/platform/linux/footprint.js";
import { createNativeScanner } from "../../dist/platform/linux/scan/index.js";
import { NativeHelperClient } from "../../dist/native/client.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";

const sandboxes = [];

after(async () => {
  for (const root of sandboxes) {
    await rm(root, { recursive: true, force: true });
  }
});

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "disktop-footprint-"));
  sandboxes.push(root);
  return root;
}

/** A directory holding `files` files of `bytes` each. */
async function sizedDirectory(root, name, files, bytes) {
  const directory = join(root, name);
  await mkdir(directory);
  for (let index = 0; index < files; index += 1) {
    await writeFile(join(directory, `file-${index}.bin`), "d".repeat(bytes));
  }
  return directory;
}

function footprintFor(indexDirectory, home) {
  const scanner = createNativeScanner({
    indexDirectory,
    start: () => NativeHelperClient.start(),
  });
  return createIndexFootprint({
    scanner,
    index: scanner,
    snapshots: { async list() { return []; } },
    ...(home === undefined ? {} : { home }),
    accounting: "allocated",
    crossFilesystems: false,
    excludes: [],
  });
}

test("two directories are measured in one pass, in proportion to what they hold", async () => {
  const root = await sandbox();
  const small = await sizedDirectory(root, "small", 4, 4096);
  const large = await sizedDirectory(root, "large", 64, 4096);
  const footprints = footprintFor(join(root, "index"));

  const reading = await footprints.measure(
    [rawPathFromUtf8(small), rawPathFromUtf8(large)],
    new AbortController().signal,
  );

  const [smallSize, largeSize] = reading.measurements.map((measurement) => measurement.bytes);
  assert.ok(smallSize > 0n, `the small directory measured ${smallSize}`);
  assert.ok(largeSize > smallSize * 8n, `${largeSize} should dwarf ${smallSize}`);
  assert.deepEqual(
    reading.measurements.map((measurement) => measurement.basis),
    ["measured-allocated", "measured-allocated"],
  );
});

test("a directory that does not exist is unknown, and the ones beside it still measure", async () => {
  const root = await sandbox();
  const real = await sizedDirectory(root, "real", 2, 1024);
  const footprints = footprintFor(join(root, "index"));

  const reading = await footprints.measure(
    [rawPathFromUtf8(real), rawPathFromUtf8(join(root, "never-created"))],
    new AbortController().signal,
  );

  assert.ok(reading.measurements[0].bytes > 0n);
  assert.equal(reading.measurements[1].bytes, undefined);
  assert.equal(reading.measurements[1].basis, "unknown");
});

test("a directory whose name is not valid UTF-8 is measured from its bytes", async () => {
  const root = await sandbox();
  const name = Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0x63, 0x61, 0xff, 0xfe])]);
  await mkdir(name);
  await writeFile(Buffer.concat([name, Buffer.from("/payload.bin")]), "p".repeat(8192));
  const footprints = footprintFor(join(root, "index"));

  const reading = await footprints.measure(
    [{ bytesBase64: name.toString("base64"), display: "the odd directory" }],
    new AbortController().signal,
  );

  assert.ok(reading.measurements[0].bytes > 0n, `measured ${reading.measurements[0].basis}: ${reading.measurements[0].explanation}`);
  assert.equal(reading.measurements[0].basis, "measured-allocated");
});

test("the helper groups a scan's files by owner and the totals reach Node intact", async () => {
  const root = await sandbox();
  await sizedDirectory(root, "owned", 6, 4096);
  // The index lives outside the scanned tree: the helper's own database files
  // would otherwise be counted as this user's files.
  const scanner = createNativeScanner({
    indexDirectory: join(await sandbox(), "index"),
    start: () => NativeHelperClient.start(),
  });

  let scanId;
  for await (const event of scanner.run(
    { roots: [rawPathFromUtf8(root)], crossFilesystems: false, excludes: [], accounting: "allocated" },
    new AbortController().signal,
  )) {
    if (event.kind === "complete") {
      scanId = event.scanId;
    }
  }

  const page = await scanner.query({
    scanId,
    filter: {},
    sort: "allocated",
    order: "descending",
    limit: 1,
    includeOwnerTotals: true,
  });

  assert.ok(Array.isArray(page.ownerTotals), "owner totals were requested");
  const mine = page.ownerTotals.find((total) => total.ownerId === BigInt(process.getuid()));
  assert.ok(mine !== undefined, `no row for this user in ${JSON.stringify(page.ownerTotals.map((t) => t.ownerId.toString()))}`);
  assert.equal(mine.entries, 6n, "six regular files, with no directory row added in");
  assert.ok(mine.allocatedBytes > 0n);
  assert.equal(typeof mine.allocatedBytes, "bigint", "a byte total never passes through Number");
});
