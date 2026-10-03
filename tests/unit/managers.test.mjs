import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlan } from "../../dist/domain/actions.js";
import {
  MANAGER_ACTIONS,
  MANAGER_TOOLS,
  describeCommand,
  isManagerAction,
  managerScope,
} from "../../dist/domain/managers.js";

const NOW = new Date("2026-10-01T09:00:00.000Z");
const IMAGE = `sha256:${"a".repeat(64)}`;

function scope(overrides = {}) {
  return managerScope({
    action: "apt.clean",
    items: [{ id: "curl_8.5.0-2_amd64.deb", bytes: 400_000n }],
    parameters: {},
    count: { kind: "exact", value: 1n },
    estimatedBytes: 400_000n,
    preview: "listed",
    ...overrides,
  });
}

test("argv is derived from the action, never accepted from a caller", () => {
  const derived = scope();
  assert.deepEqual(derived.commands, [{ tool: "apt-get", arguments: ["clean"] }]);
  assert.equal(derived.privilege, "root");
  assert.equal(derived.adapter, "apt");
  assert.equal(derived.perItem, false);
});

test("a per-item action runs one command per reviewed item", () => {
  const derived = scope({
    action: "docker.remove-dangling-images",
    items: [{ id: IMAGE }, { id: `sha256:${"b".repeat(64)}` }],
    count: { kind: "exact", value: 2n },
    estimatedBytes: undefined,
  });
  assert.deepEqual(derived.commands, [
    { tool: "docker", arguments: ["image", "rm", "--", IMAGE] },
    { tool: "docker", arguments: ["image", "rm", "--", `sha256:${"b".repeat(64)}`] },
  ]);
  assert.equal(derived.privilege, "user");
});

test("an item that could be read as an option is refused", () => {
  for (const id of ["--all", "-f", "", " curl.deb"]) {
    assert.throws(
      () => scope({ action: "docker.remove-stopped-containers", items: [{ id }], count: { kind: "exact", value: 1n } }),
      RangeError,
      id,
    );
  }
});

test("an item outside its action's own pattern is refused", () => {
  assert.throws(() => scope({ items: [{ id: "../../etc/passwd" }] }), RangeError);
  assert.throws(
    () => scope({ action: "snap.remove-disabled", items: [{ id: "Core20=1974" }], count: { kind: "exact", value: 1n } }),
    RangeError,
  );
});

test("a repeated item is refused rather than run twice", () => {
  assert.throws(
    () =>
      scope({
        action: "docker.remove-dangling-images",
        items: [{ id: IMAGE }, { id: IMAGE }],
        count: { kind: "exact", value: 2n },
      }),
    RangeError,
  );
});

test("a per-item action with nothing to act on is refused", () => {
  assert.throws(
    () => scope({ action: "snap.remove-disabled", items: [], count: { kind: "exact", value: 0n } }),
    RangeError,
  );
});

test("an exact count has to be the number of reviewed items", () => {
  assert.throws(() => scope({ count: { kind: "exact", value: 2n } }), RangeError);
});

test("an action whose manager chooses for itself takes no items", () => {
  assert.throws(
    () => scope({ action: "flatpak.remove-unused-user", items: [{ id: "x" }], count: { kind: "unknown" } }),
    RangeError,
  );
  const unknown = scope({ action: "flatpak.remove-unused-user", items: [], count: { kind: "unknown" }, estimatedBytes: undefined, preview: "none" });
  assert.deepEqual(unknown.commands, [
    { tool: "flatpak", arguments: ["uninstall", "--user", "--unused", "--noninteractive", "-y"] },
  ]);
});

test("a parameter is validated by its own pattern, and an unknown one is refused", () => {
  const journal = (parameters) =>
    scope({ action: "journald.vacuum", items: [], parameters, count: { kind: "unknown" }, preview: "none" });
  assert.deepEqual(journal({ keepBytes: "536870912" }).commands, [
    { tool: "journalctl", arguments: ["--vacuum-size=536870912"] },
  ]);
  assert.throws(() => journal({ keepBytes: "1G" }), RangeError);
  assert.throws(() => journal({}), RangeError);
  assert.throws(() => journal({ keepBytes: "536870912", extra: "1" }), RangeError);
});

test("the crash policy names exactly its two prefixes", () => {
  const crash = scope({ action: "tmpfiles.clean-crash", items: [], count: { kind: "unknown" }, preview: "none" });
  assert.deepEqual(crash.commands, [
    {
      tool: "systemd-tmpfiles",
      arguments: ["--clean", "--prefix=/var/crash", "--prefix=/var/lib/systemd/coredump"],
    },
  ]);
});

test("no removal of an image, container, or volume is forced", () => {
  for (const spec of Object.values(MANAGER_ACTIONS)) {
    const items = spec.itemPattern === undefined ? [] : [sampleItem(spec.action)];
    const parameters = Object.hasOwn(spec.parameterPatterns, "keepBytes") ? { keepBytes: "536870912" } : {};
    for (const command of spec.commands(items, parameters)) {
      assert.ok(MANAGER_TOOLS.includes(command.tool), `${spec.action} names ${command.tool}`);
      assert.equal(command.arguments.includes("-f"), false, spec.action);
      assert.equal(command.arguments.includes("--force") && command.tool !== "docker", false, spec.action);
    }
  }
});

test("only the build cache prune passes --force, which there means 'do not prompt'", () => {
  const forced = Object.values(MANAGER_ACTIONS).filter((spec) =>
    spec.commands(spec.itemPattern === undefined ? [] : [sampleItem(spec.action)], { keepBytes: "536870912" }).some((command) =>
      command.arguments.includes("--force"),
    ),
  );
  assert.deepEqual(forced.map((spec) => spec.action), ["docker.prune-build-cache"]);
});

test("an action id is recognised only when it is one of the declared ones", () => {
  assert.equal(isManagerAction("apt.clean"), true);
  assert.equal(isManagerAction("apt.remove-everything"), false);
  assert.equal(isManagerAction("__proto__"), false);
});

test("a command reads as what will be run, with the escalation it needs", () => {
  assert.equal(describeCommand({ tool: "apt-get", arguments: ["clean"] }, "root"), "sudo apt-get clean");
  assert.equal(describeCommand({ tool: "docker", arguments: ["image", "rm", "--", IMAGE] }, "user"), `docker image rm -- ${IMAGE}`);
});

test("a manager plan is irreversible, carries no entries, and promises only what its manager could", () => {
  const plan = buildPlan({
    operation: "manager",
    providerId: "managers",
    findingId: "managers:journald.vacuum",
    scopeSummary: "Archived journal files",
    createdAt: NOW,
    expiryMinutes: 60,
    entries: [],
    manager: scope({ action: "journald.vacuum", items: [], parameters: { keepBytes: "536870912" }, count: { kind: "unknown" }, estimatedBytes: undefined, preview: "none" }),
    warnings: [],
  });
  assert.equal(plan.reversibility, "irreversible");
  assert.equal(plan.permission, "manager-privilege");
  assert.equal(plan.exactItemCount, undefined);
  assert.equal(plan.selectedBytes, undefined, "an unknown estimate is absent, never zero");
  assert.equal(plan.entries, undefined);
  assert.ok(plan.warnings.some((warning) => /cannot be undone/.test(warning)));
});

test("a manager plan with an exact count carries it, and a user-privilege one says so", () => {
  const plan = buildPlan({
    operation: "manager",
    providerId: "managers",
    scopeSummary: "Stopped containers",
    createdAt: NOW,
    expiryMinutes: 60,
    entries: [],
    manager: scope({
      action: "docker.remove-stopped-containers",
      items: [{ id: "c".repeat(64), bytes: 10n }],
      count: { kind: "exact", value: 1n },
      estimatedBytes: 10n,
    }),
    warnings: [],
  });
  assert.equal(plan.exactItemCount, 1n);
  assert.equal(plan.selectedBytes, 10n);
  assert.equal(plan.permission, "user");
});

test("a manager plan without a manager scope, or a trash plan with one, is refused", () => {
  const base = { providerId: "p", scopeSummary: "s", createdAt: NOW, expiryMinutes: 60, warnings: [] };
  assert.throws(() => buildPlan({ ...base, operation: "manager", entries: [] }), RangeError);
  assert.throws(
    () =>
      buildPlan({
        ...base,
        operation: "trash",
        entries: [{ path: { bytesBase64: "L3g=", display: "/x", utf8: "/x" }, expected: { device: 1n, inode: 1n, mountId: "1", kind: "file", apparentBytes: 1n, modifiedNanoseconds: 1n }, reviewedBytes: 1n }],
        manager: scope(),
      }),
    RangeError,
  );
});

function sampleItem(action) {
  const samples = {
    "apt.clean": "a_1.0_amd64.deb",
    "dnf.clean-packages": "a-1.0-1.fc40.x86_64.rpm",
    "pacman.clean-uninstalled": "a-1.0-1-x86_64.pkg.tar.zst",
    "snap.remove-disabled": "core20=1974",
    "docker.remove-dangling-images": IMAGE,
    "podman.remove-dangling-images": IMAGE,
    "kernels.dpkg-purge": "linux-image-6.8.0-40-generic",
    "kernels.rpm-erase": "kernel-core-6.10.6-200.fc40.x86_64",
  };
  return samples[action] ?? "c".repeat(64);
}

test("a manager plan in text shows every command it runs and what it needs to run them", async () => {
  const { planLines } = await import("../../dist/cli/text.js");
  const plan = buildPlan({
    operation: "manager",
    providerId: "managers",
    scopeSummary: "Archived systemd journal files",
    createdAt: NOW,
    expiryMinutes: 60,
    entries: [],
    manager: scope({ action: "journald.vacuum", items: [], parameters: { keepBytes: "536870912" }, count: { kind: "unknown" }, estimatedBytes: undefined, preview: "none" }),
    warnings: [],
  });
  const text = planLines(plan, "iec").join("\n");
  assert.match(text, /Runs: sudo journalctl --vacuum-size=536870912/);
  assert.match(text, /Estimated: unknown/);
  assert.match(text, /Selected: unknown/);
  assert.match(text, /administrator rights/);
  assert.match(text, /--permanent/);
});
