import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("real full and read-only filesystems preserve sources, and cross-device publication works", async (t) => {
  let namespace = ["--mount", "--fork"];
  let probe = spawnSync("unshare", [...namespace, "true"], { encoding: "utf8" });
  if (probe.error === undefined && probe.status !== 0) {
    namespace = ["--user", "--map-current-user", "--mount", "--keep-caps", "--fork"];
    probe = spawnSync("unshare", [...namespace, "true"], { encoding: "utf8" });
  }
  if (probe.error?.code === "ENOENT" || (probe.status !== 0 && /not permitted|permission denied/i.test(probe.stderr))) {
    assert.notEqual(process.env.DISKTOP_TEST_REQUIRE_FILESYSTEM_FAULTS, "1", "the required filesystem fault gate cannot skip namespace setup");
    t.skip("this host cannot create the private user/mount namespace needed for filesystem fault tests");
    return;
  }
  assert.equal(probe.status, 0, probe.stderr);
  const work = await mkdtemp(join(tmpdir(), "disktop-filesystem-faults-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const run = spawnSync("unshare", [...namespace, process.execPath,
    fileURLToPath(new URL("../support/filesystem-failures.mjs", import.meta.url)), work], {
    encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(run.error, undefined, run.error?.message);
  if (run.status === 77) {
    assert.notEqual(process.env.DISKTOP_TEST_REQUIRE_FILESYSTEM_FAULTS, "1", run.stderr.trim());
    t.skip(run.stderr.trim());
    return;
  }
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(result, { diskFull: true, journalFull: true, readOnly: true, crossDevice: true });
});
