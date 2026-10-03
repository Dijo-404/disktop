import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAccountNames } from "../../dist/platform/linux/accounts.js";
import { createExploreService } from "../../dist/application/explore.js";

test("account names come from passwd, and a name that could command a terminal is made safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "disktop-passwd-"));
  try {
    const file = join(root, "passwd");
    await writeFile(file, "root:x:0:0::/root:/bin/sh\nalice:x:1000:1000::/home/alice:/bin/sh\nevil\u001b[2J:x:1002:1002::/:/bin/sh\nbroken line\n");
    const names = await createAccountNames(file).names();
    assert.equal(names.get(1000n), "alice");
    assert.doesNotMatch(names.get(1002n), /\u001b/);
    assert.equal(names.size, 3);
    const missing = await createAccountNames(join(root, "absent")).names();
    assert.equal(missing.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explore joins owner totals to names and says whether names were read", async () => {
  const service = createExploreService(
    { async query() { return { entries: [], ownerTotals: [{ ownerId: 1000n, entries: 1n, allocatedBytes: 1n, apparentBytes: 1n }] }; } },
    { async names() { return new Map([[1000n, "alice"]]); } },
  );
  const outcome = await service.page({ scanId: "scan-1", includeOwnerTotals: true });
  assert.deepEqual(outcome.page.owners, [{ ownerId: 1000n, name: "alice", entries: 1n, allocatedBytes: 1n, apparentBytes: 1n }]);
  assert.equal(outcome.page.namesRead, true);
});
