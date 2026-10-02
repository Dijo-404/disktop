import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { compileBundle } from "../support/schemas.mjs";

const validators = compileBundle("schemas/cli/v1");
const roots = [];
after(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
});

test("explore --owners over a real scan attributes the tree to the user who wrote it", async () => {
  const root = await mkdtemp(join(tmpdir(), "disktop-owners-"));
  roots.push(root);
  const tree = join(root, "tree");
  await mkdir(join(tree, "inner"), { recursive: true });
  await writeFile(join(tree, "a.bin"), "x".repeat(8192));
  await writeFile(join(tree, "inner", "b.bin"), "y".repeat(4096));
  const env = { ...process.env, NO_COLOR: "1", HOME: root, XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"), XDG_CACHE_HOME: join(root, "ca"), XDG_STATE_HOME: join(root, "s") };
  const run = (args) => spawnSync(process.execPath, ["dist/bin/disktop.js", ...args], { encoding: "utf8", env });

  assert.equal(run(["scan", tree, "--json"]).status, 0);
  const explored = run(["explore", tree, "--owners", "--json"]);
  const envelope = JSON.parse(explored.stdout);
  assert.ok(validators.get("explore")(envelope), JSON.stringify(validators.get("explore").errors));
  assert.equal(explored.status, 0);
  const [owner] = envelope.data.owners;
  assert.equal(owner.ownerId, String(process.getuid()));
  assert.equal(owner.name, userInfo().username);
  assert.equal(owner.entries, "2");
});
