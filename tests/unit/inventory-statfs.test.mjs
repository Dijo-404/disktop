import assert from "node:assert/strict";
import { mkdtemp, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStatfsReader } from "../../dist/platform/linux/inventory/statfs.js";

test("isolated capacity readings match statfs and share simultaneous probes", async () => {
  const read = createStatfsReader();
  const path = Buffer.from(tmpdir());
  const first = read(path);
  assert.equal(read(path), first, "one child owns simultaneous reads of the same mount");
  const expected = await statfs(path, { bigint: true });
  const actual = await first;
  assert.equal(actual.blockSize, expected.bsize);
  assert.equal(actual.blocks, expected.blocks);
  assert.equal(actual.totalInodes, expected.files);
});

test("isolated statfs accepts raw names and safely reports nonexistent mounts", async () => {
  const read = createStatfsReader();
  const directory = await mkdtemp(join(tmpdir(), "disktop-capacity-"));
  const path = Buffer.from(`${directory}/does-not-exist`);
  await assert.rejects(read(path), (error) => error.code === "ENOENT");
  const actual = await read(Buffer.from(directory));
  assert.ok(actual.blocks > 0n, "one failed probe cannot poison subsequent reads");
});
