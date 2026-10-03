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

function linkedTree(entries, links) {
  const base = tree(entries);
  return {
    async lstat(path) {
      if (Object.hasOwn(links, path)) {
        return { uid: 0, mode: 0o777, isDirectory: () => false, isSymbolicLink: () => true };
      }
      return base.lstat(path);
    },
    readdir: base.readdir,
    async realpath(path) {
      if (Object.hasOwn(links, path)) {
        return links[path];
      }
      return path;
    },
  };
}

const LINKED_TREE = {
  ...ROOT_TREE,
  "/usr/lib/node_modules/disktop": { children: ["dist", "node_modules"] },
  "/usr/lib/node_modules/disktop/node_modules": { children: ["terminal-kit", ".bin"] },
  "/usr/lib/node_modules/disktop/node_modules/.bin": { children: ["tool"] },
};

test("a link inside the install that points outside it is refused, because its target is never checked", async () => {
  // `npm link` and workspace installs leave links like this. Node follows them
  // when it loads a module, so root would run code from wherever they point.
  const outcome = await verifyRootOwnedInstall(
    "/usr/lib/node_modules/disktop",
    linkedTree(LINKED_TREE, {
      "/usr/lib/node_modules/disktop/node_modules/terminal-kit": "/home/example/src/terminal-kit",
      "/usr/lib/node_modules/disktop/node_modules/.bin/tool": "/usr/lib/node_modules/disktop/dist/disktop.js",
    }),
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /terminal-kit/);
  assert.match(outcome.reason, /outside/);
});

test("a link that stays inside the install is accepted, since everything it can reach is checked", async () => {
  const outcome = await verifyRootOwnedInstall(
    "/usr/lib/node_modules/disktop",
    linkedTree({ ...LINKED_TREE, "/usr/lib/node_modules/disktop/node_modules": { children: [".bin"] } }, {
      "/usr/lib/node_modules/disktop/node_modules/.bin/tool": "/usr/lib/node_modules/disktop/dist/disktop.js",
    }),
  );
  assert.deepEqual(outcome, { ok: true });
});

test("a link that resolves nowhere is refused: whoever creates its target chooses what runs", async () => {
  const reader = linkedTree({ ...LINKED_TREE, "/usr/lib/node_modules/disktop/node_modules": { children: [".bin"] } }, {
    "/usr/lib/node_modules/disktop/node_modules/.bin/tool": "/usr/lib/node_modules/disktop/dist/disktop.js",
  });
  reader.realpath = async () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  const outcome = await verifyRootOwnedInstall("/usr/lib/node_modules/disktop", reader);
  assert.equal(outcome.ok, false);
});

test("the Node binary root would run is held to the same rule as the install", async () => {
  const { verifyRootOwnedExecutable } = await import("../../dist/platform/linux/install-ownership.js");
  const system = tree({
    "/": { children: ["usr", "home"] },
    "/usr": { children: ["bin"] },
    "/usr/bin": { children: ["node"] },
    "/usr/bin/node": { mode: 0o755 },
    "/home": { children: ["example"] },
    "/home/example": { uid: 1000, children: [".nvm"] },
    "/home/example/.nvm": { uid: 1000, children: ["node"] },
    "/home/example/.nvm/node": { uid: 1000, mode: 0o755 },
  });
  assert.deepEqual(await verifyRootOwnedExecutable("/usr/bin/node", system), { ok: true });
  // `sudo env PATH=$PATH disktop` with Node from a version manager runs a
  // binary the user's own processes can replace.
  const borrowed = await verifyRootOwnedExecutable("/home/example/.nvm/node", system);
  assert.equal(borrowed.ok, false);
  assert.match(borrowed.reason, /\/home\/example/);
});
