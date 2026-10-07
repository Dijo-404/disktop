import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { managerScope } from "../../dist/domain/managers.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";
import { createPackageCacheAdapters } from "../../dist/platform/linux/managers/package-cache.js";
import { createPathProbe } from "../../dist/platform/linux/probe.js";

function fakePaths(tree) {
  const facts = (path) => {
    const entry = tree[path.display];
    if (entry === undefined) return undefined;
    return {
      kind: Array.isArray(entry) ? "directory" : "file",
      apparentBytes: Array.isArray(entry) ? 4096n : entry,
      allocatedBytes: Array.isArray(entry) ? 4096n : entry,
      ownerId: 0n,
      modifiedNanoseconds: 1n,
      device: 1n,
      inode: 1n,
      mountId: "1",
    };
  };
  return {
    async facts(path) {
      return facts(path);
    },
    async list(path) {
      const entry = tree[path.display];
      return Array.isArray(entry) ? entry.map((name) => rawPathFromUtf8(`${path.display}/${name}`)) : [];
    },
    async readText() {
      return undefined;
    },
  };
}

function fakeTools(outputs = {}) {
  return {
    async run(name, commandArguments) {
      const key = [name, ...commandArguments].join(" ");
      const stdout = outputs[key];
      if (stdout === undefined) {
        return { capability: { status: "missing-tool", explanation: `${key} is not here` }, stdout: "", stderr: "", exitCode: null };
      }
      return { capability: { status: "available", explanation: "ran" }, stdout, stderr: "", exitCode: 0 };
    },
  };
}

function adapters({ tree = {}, outputs = {}, installed = ["apt-get", "dnf", "pacman"] } = {}) {
  const all = createPackageCacheAdapters({
    tools: fakeTools(outputs),
    paths: fakePaths(tree),
    installed: async (tool) => installed.includes(tool),
  });
  return Object.fromEntries(all.map((adapter) => [adapter.id, adapter]));
}

const APT = "/var/cache/apt/archives";

test("apt proposes exactly the package files it downloaded, sized by stat", async () => {
  const { apt } = adapters({
    tree: { [APT]: ["curl_8.5.0-2_amd64.deb", "zlib1g_1.3_amd64.deb", "lock", "partial"], [`${APT}/curl_8.5.0-2_amd64.deb`]: 400n, [`${APT}/zlib1g_1.3_amd64.deb`]: 100n, [`${APT}/lock`]: 0n, [`${APT}/partial`]: [] },
  });
  const discovery = await apt.discover();
  assert.equal(discovery.capability.status, "available");
  const [proposal] = discovery.proposals;
  assert.equal(proposal.action, "apt.clean");
  assert.deepEqual(proposal.items.map((item) => item.id), ["curl_8.5.0-2_amd64.deb", "zlib1g_1.3_amd64.deb"]);
  assert.equal(proposal.estimatedBytes, 500n);
  assert.deepEqual(proposal.count, { kind: "exact", value: 2n });
  assert.equal(proposal.bytesBasis, "stat");
  assert.equal(proposal.offered, true);
});

test("a package file whose name could be read as an option is left out and said so", async () => {
  const { apt } = adapters({ tree: { [APT]: ["--evil.deb", "ok_1_all.deb"], [`${APT}/--evil.deb`]: 1n, [`${APT}/ok_1_all.deb`]: 1n } });
  const discovery = await apt.discover();
  assert.deepEqual(discovery.proposals[0].items.map((item) => item.id), ["ok_1_all.deb"]);
  assert.ok(discovery.warnings.some((warning) => warning.code === "manager-item-skipped"));
});

test("a manager that is not installed is missing, not an empty cache", async () => {
  const { apt } = adapters({ installed: [] });
  const discovery = await apt.discover();
  assert.equal(discovery.capability.status, "missing-tool");
  assert.deepEqual(discovery.proposals, []);
});

test("an empty cache is offered nothing", async () => {
  const { apt } = adapters({ tree: { [APT]: ["lock"], [`${APT}/lock`]: 0n } });
  const [proposal] = (await apt.discover()).proposals;
  assert.equal(proposal.offered, false);
});

test("pacman proposes only cached packages whose version is not installed", async () => {
  const PKG = "/var/cache/pacman/pkg";
  const { pacman } = adapters({
    tree: {
      [PKG]: ["linux-6.10.1.arch1-1-x86_64.pkg.tar.zst", "linux-6.10.1.arch1-1-x86_64.pkg.tar.zst.sig", "linux-6.9.9.arch1-1-x86_64.pkg.tar.zst", "gnupg-2.4.5-1-x86_64.pkg.tar.zst", "glib2-2:1.0-1-any.pkg.tar.zst"],
      [`${PKG}/linux-6.10.1.arch1-1-x86_64.pkg.tar.zst`]: 100n,
      [`${PKG}/linux-6.10.1.arch1-1-x86_64.pkg.tar.zst.sig`]: 1n,
      [`${PKG}/linux-6.9.9.arch1-1-x86_64.pkg.tar.zst`]: 90n,
      [`${PKG}/gnupg-2.4.5-1-x86_64.pkg.tar.zst`]: 10n,
      [`${PKG}/glib2-2:1.0-1-any.pkg.tar.zst`]: 5n,
    },
    outputs: { "pacman -Q": "linux 6.10.1.arch1-1\nglib2 2:1.0-1\n" },
  });
  const [proposal] = (await pacman.discover()).proposals;
  assert.equal(proposal.action, "pacman.clean-uninstalled");
  assert.deepEqual(proposal.items.map((item) => item.id).sort(), ["gnupg-2.4.5-1-x86_64.pkg.tar.zst", "linux-6.9.9.arch1-1-x86_64.pkg.tar.zst"]);
  assert.equal(proposal.count.kind, "estimated");
  assert.equal(proposal.estimatedBytes, 100n);
});

test("pacman that cannot list what is installed proposes nothing rather than everything", async () => {
  const PKG = "/var/cache/pacman/pkg";
  const { pacman } = adapters({ tree: { [PKG]: ["a-1-1-any.pkg.tar.zst"], [`${PKG}/a-1-1-any.pkg.tar.zst`]: 1n } });
  const discovery = await pacman.discover();
  assert.deepEqual(discovery.proposals, []);
  assert.notEqual(discovery.capability.status, "available");
});

test("dnf reads both cache layouts, and a missing cache is no proposal", async () => {
  const { dnf } = adapters({
    tree: {
      "/var/cache/libdnf5": ["fedora-abc"],
      "/var/cache/libdnf5/fedora-abc": ["packages"],
      "/var/cache/libdnf5/fedora-abc/packages": ["vim-9.1-1.fc40.x86_64.rpm"],
      "/var/cache/libdnf5/fedora-abc/packages/vim-9.1-1.fc40.x86_64.rpm": 70n,
    },
  });
  const [proposal] = (await dnf.discover()).proposals;
  assert.deepEqual(proposal.items, [{ id: "vim-9.1-1.fc40.x86_64.rpm", bytes: 70n }]);
  const empty = adapters({ tree: {} }).dnf;
  assert.deepEqual((await empty.discover()).proposals, []);
});

test("dnf cache discovery preserves invalid-byte repository paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "disktop-dnf-cache-"));
  try {
    const packages = Buffer.concat([Buffer.from(`${root}/repository-`), Buffer.from([0xff]), Buffer.from("/packages")]);
    await mkdir(packages, { recursive: true });
    await writeFile(Buffer.concat([packages, Buffer.from("/vim-9.1-1.fc40.x86_64.rpm")]), "package");
    const all = createPackageCacheAdapters({
      tools: fakeTools(), paths: createPathProbe(), installed: async (tool) => tool === "dnf", roots: { dnf: [root] },
    });
    const dnf = all.find((adapter) => adapter.id === "dnf");
    const discovery = await dnf.discover();
    assert.deepEqual(discovery.proposals[0].items.map((item) => item.id), ["vim-9.1-1.fc40.x86_64.rpm"]);
    assert.ok(discovery.proposals[0].estimatedBytes > 0n);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function aptScope(ids) {
  return managerScope({ action: "apt.clean", items: ids.map((id) => ({ id, bytes: 1n })), parameters: {}, count: { kind: "exact", value: BigInt(ids.length) }, estimatedBytes: BigInt(ids.length), preview: "listed" });
}

test("preflight skips a reviewed file that is already gone", async () => {
  const { apt } = adapters({ tree: { [APT]: ["b_1_all.deb"], [`${APT}/b_1_all.deb`]: 1n } });
  const result = await apt.preflight(aptScope(["a_1_all.deb", "b_1_all.deb"]));
  assert.equal(result.refusal, undefined);
  assert.deepEqual([...result.skipped.keys()], [0]);
});

test("verify fails a file the manager left in its cache", async () => {
  const { apt } = adapters({ tree: { [APT]: ["b_1_all.deb"], [`${APT}/b_1_all.deb`]: 1n } });
  const verification = await apt.verify(aptScope(["a_1_all.deb", "b_1_all.deb"]), new Set([0, 1]), []);
  assert.equal(verification.verdicts.get(0).outcome, "completed");
  assert.equal(verification.verdicts.get(1).outcome, "failed");
  assert.equal(verification.checks.find((check) => check.check === "manager-verified").outcome, "failed");
});
