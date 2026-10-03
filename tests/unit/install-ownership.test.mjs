import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inInitialUserNamespace, verifyRootOwnedInstall } from "../../dist/platform/linux/install-ownership.js";
import { bootstrapCli } from "../../dist/cli/bootstrap.js";
import { StartupRefused } from "../../dist/domain/errors.js";

function tree(entries) {
  const node = (path) => entries[path];
  return {
    async lstat(path) {
      const entry = node(path);
      if (entry === undefined) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return { uid: entry.uid ?? 0, mode: entry.mode ?? 0o755, isDirectory: () => Array.isArray(entry.children), isSymbolicLink: () => false };
    },
    async readdir(path) {
      return node(path).children;
    },
  };
}

const ROOT_TREE = {
  "/": { children: ["usr"] },
  "/usr": { children: ["lib"] },
  "/usr/lib": { children: ["node_modules"] },
  "/usr/lib/node_modules": { children: ["disktop"] },
  "/usr/lib/node_modules/disktop": { children: ["dist"] },
  "/usr/lib/node_modules/disktop/dist": { children: ["disktop.js"] },
  "/usr/lib/node_modules/disktop/dist/disktop.js": { mode: 0o644 },
};

test("a root-owned install nobody else can write to is accepted", async () => {
  assert.deepEqual(await verifyRootOwnedInstall("/usr/lib/node_modules/disktop", tree(ROOT_TREE)), { ok: true });
});

test("a file inside the install that a user owns is refused, by name", async () => {
  const outcome = await verifyRootOwnedInstall("/usr/lib/node_modules/disktop", tree({ ...ROOT_TREE, "/usr/lib/node_modules/disktop/dist/disktop.js": { uid: 1000, mode: 0o644 } }));
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /disktop\.js/);
});

test("a directory anybody else can write to is refused", async () => {
  const outcome = await verifyRootOwnedInstall("/usr/lib/node_modules/disktop", tree({ ...ROOT_TREE, "/usr/lib/node_modules/disktop/dist": { children: ["disktop.js"], mode: 0o775 } }));
  assert.equal(outcome.ok, false);
});

test("a user-owned directory above the install is refused, because it can rename the install away", async () => {
  const outcome = await verifyRootOwnedInstall("/usr/lib/node_modules/disktop", tree({ ...ROOT_TREE, "/usr/lib": { children: ["node_modules"], uid: 1000 } }));
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /\/usr\/lib/);
});

test("this checkout, owned by its user, is not a root-owned install", async () => {
  const root = await mkdtemp(join(tmpdir(), "disktop-install-"));
  try {
    await writeFile(join(root, "index.js"), "");
    assert.equal((await verifyRootOwnedInstall(root)).ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only the identity uid map is the initial user namespace", () => {
  assert.equal(inInitialUserNamespace("         0          0 4294967295\n"), true);
  assert.equal(inInitialUserNamespace("         0       1000          1\n"), false);
  assert.equal(inInitialUserNamespace(undefined), true, "an unreadable map is treated as the real thing");
});

test("a refused start is a permission-denied envelope, not an internal error", async () => {
  let stdout = "";
  const status = await bootstrapCli(["--json"], "24.21.0", { stdout: (text) => { stdout += text; }, stderr() {} }, async () => {
    throw new StartupRefused({ code: "permission-denied", message: "Running as root needs a root-owned install." });
  });
  assert.equal(status, 2);
  assert.equal(JSON.parse(stdout).error.code, "permission-denied");
});
