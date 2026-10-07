/** Explicit opt-in only. Actual managers mutate only a sealed disposable cache. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createServices } from "../../dist/composition/root.js";
import { NativeHelperClient } from "../../dist/native/client.js";

const selector = process.env.DISKTOP_TEST_REAL_MANAGER;
const templates = {
  apt: { action: "apt.clean", tool: "apt-get", arguments: ["clean"], roots: ["/var/cache/apt/archives"] },
  dnf: { action: "dnf.clean-packages", tool: "dnf", arguments: ["clean", "packages"], roots: ["/var/cache/dnf", "/var/cache/libdnf5"] },
  pacman: { action: "pacman.clean-uninstalled", tool: "pacman", arguments: ["-Sc", "--noconfirm"], roots: ["/var/cache/pacman/pkg"] },
};
const hash = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

async function trusted(path, directory = false) {
  const facts = await lstat(path);
  assert.equal(facts.uid, 0, `${path} must belong to the container bootstrap`);
  assert.equal(facts.mode & 0o022, 0, `${path} must not be writable by an ordinary account`);
  assert.equal(directory ? facts.isDirectory() : facts.isFile(), true, `${path} must not be a symlink`);
  return facts;
}

async function packages(roots) {
  const found = [];
  let inspected = 0;
  async function visit(path) {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      assert.ok(++inspected <= 10_000, "the disposable cache must remain small");
      const name = `${path}/${entry.name}`;
      assert.equal(entry.isSymbolicLink(), false, `a cache symlink could leave the fixture: ${name}`);
      if (entry.isDirectory()) {
        // apt's empty partial directory deliberately belongs to its download
        // account and is unreadable here; the bootstrap verified it is empty.
        if (name === "/var/cache/apt/archives/partial") continue;
        await visit(name);
      } else if (/\.(deb|rpm|sig)$|\.pkg\.tar(?:\.[a-z0-9]+)?$/.test(entry.name)) found.push(name);
    }
  }
  for (const root of roots) await visit(root);
  return found.sort();
}

test("a real scoped manager command verifies removal and journals its lifecycle", {
  skip: selector === undefined && "run tests/support/managers-disposable.mjs apt|dnf|pacman for the mandatory disposable gate",
  timeout: 60_000,
}, async () => {
  assert.ok(Object.hasOwn(templates, selector), "choose exactly apt, dnf, or pacman");
  assert.equal(process.getuid(), 10001, "Disktop must run as the disposable ordinary account");
  assert.equal(process.geteuid(), 10001);
  const [major, minor] = process.versions.node.split(".").map(Number);
  assert.ok((major === 24 && minor >= 21) || (major === 26 && minor >= 10), "the real gate must use a supported Node runtime");
  await trusted("/.dockerenv");
  await trusted("/run", true);
  await trusted("/run/disktop-manager-gate", true);
  await trusted("/run/disktop-manager-gate/manifest.json");
  const repository = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
  assert.equal(repository, "/workspace/disktop", "the gate must use its fixed isolated mount");
  const mounts = (await readFile("/proc/self/mountinfo", "utf8")).trim().split("\n").map((line) => line.split(" "));
  const workspace = mounts.find((fields) => fields[4] === repository);
  assert.ok(workspace?.[5].split(",").includes("ro"), "the host repository must be mounted read-only");
  const expected = templates[selector];
  for (const root of expected.roots) {
    assert.ok(!mounts.some((fields) => fields[4] !== "/" && (fields[4] === root || fields[4].startsWith(`${root}/`) || root.startsWith(`${fields[4]}/`))), "a host cache must never be mounted into this gate");
  }
  const manifest = JSON.parse(await readFile("/run/disktop-manager-gate/manifest.json", "utf8"));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.manager, selector);
  assert.deepEqual(manifest.cacheRoots, expected.roots);
  assert.ok(expected.roots.some((root) => manifest.fixture.startsWith(`${root}/`)));
  assert.equal(await realpath(manifest.fixture), manifest.fixture);
  await trusted(manifest.fixture);
  await trusted(manifest.fixture.slice(0, manifest.fixture.lastIndexOf("/")), true);
  assert.deepEqual(await packages(expected.roots), [manifest.fixture], "only the reviewed fixture may inhabit this cache");
  assert.equal(await hash(manifest.sentinel.path), manifest.sentinel.hash);
  for (const file of manifest.database) assert.equal(await hash(file.path), file.hash);

  const phases = [];
  const start = NativeHelperClient.start;
  // Observe acknowledgements from the real helper; every request and syscall
  // still uses the original client, and no manager runner is replaced.
  NativeHelperClient.start = async (...arguments_) => {
    const started = await start(...arguments_);
    if (started.started) {
      const request = started.client.request.bind(started.client);
      started.client.request = async (operation, arguments_, ...options) => {
        const response = await request(operation, arguments_, ...options);
        if (operation.startsWith("manager-")) phases.push([operation, arguments_.phase, arguments_.exitCode]);
        return response;
      };
    }
    return started;
  };
  try {
    const services = await createServices();
    const signal = new AbortController().signal;
    const planned = await services.plan.plan({ operation: "manager", findingId: `managers:${expected.action}` }, signal);
    assert.equal(planned.kind, "planned", JSON.stringify(planned, (_key, value) => typeof value === "bigint" ? String(value) : value));
    const plan = planned.plan;
    assert.equal(plan.permission, "manager-privilege");
    assert.equal(plan.reversibility, "irreversible");
    assert.deepEqual(plan.manager.commands, [{ tool: expected.tool, arguments: expected.arguments }]);
    assert.deepEqual(plan.manager.items.map((item) => item.id), [basename(manifest.fixture)]);
    assert.equal((await services.undo.history()).records.length, 0, "planning is read-only and journals no action");
    assert.deepEqual(await packages(expected.roots), [manifest.fixture]);
    const applied = await services.apply.apply({ planId: plan.id, confirmed: true, acknowledgePermanent: true, interactive: false }, signal);
    assert.equal(applied.kind, "applied", JSON.stringify(applied, (_key, value) => typeof value === "bigint" ? String(value) : value));
    assert.equal(applied.result.state, "complete");
    assert.equal(applied.result.completed, 1n);
    assert.equal(applied.result.failed, 0n);
    assert.equal(applied.result.bytesMovedToTrash, 0n);
    assert.equal(applied.result.undoAvailable, false);
    for (const check of ["manager-command", "manager-verified"]) {
      assert.equal(applied.result.verification.find((entry) => entry.check === check)?.outcome, "passed");
    }
    assert.deepEqual(await packages(expected.roots), []);
    assert.equal(await hash(manifest.sentinel.path), manifest.sentinel.hash);
    for (const file of manifest.database) assert.equal(await hash(file.path), file.hash, "cache cleanup must preserve the package database");
    assert.deepEqual(phases, [
      ["manager-begin", undefined, undefined], ["manager-append", "started", undefined],
      ["manager-append", "finished", "0"], ["manager-finish", undefined, undefined],
    ]);
    const history = await services.undo.history();
    const record = history.records.find((entry) => entry.id === applied.result.journalId);
    assert.ok(record);
    assert.equal(record.operation, "manager");
    assert.equal(record.state, "complete");
    assert.deepEqual(record.manager.commands.map((command) => command.state), ["finished"]);
    assert.deepEqual(record.manager.commands.map((command) => command.exitCode), [0n]);
    assert.deepEqual(record.items.map((item) => item.outcome), ["completed"]);
    const restore = await services.undo.restore(record.id, signal);
    assert.equal(restore.kind, "refused", "irreversible manager cleanup must offer no undo");
  } finally {
    NativeHelperClient.start = start;
  }
});
