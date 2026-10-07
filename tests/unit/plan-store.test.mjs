import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildPlan } from "../../dist/domain/actions.js";
import { rawPathFromBytes, rawPathFromUtf8 } from "../../dist/domain/paths.js";
import { createPlanStore } from "../../dist/storage/plans.js";

const sandboxes = [];

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "disktop-plans-"));
  sandboxes.push(root);
  return root;
}

after(async () => {
  for (const root of sandboxes) {
    await rm(root, { recursive: true, force: true });
  }
});

const NOW = new Date("2026-10-01T09:00:00.000Z");

test("a missing plan directory is empty, but directory read failures surface", async () => {
  const root = await sandbox();
  const store = createPlanStore(root);
  assert.deepEqual(await store.list(), []);
  await writeFile(join(root, "plans"), "a store directory was replaced by a file");
  await assert.rejects(store.list(), { code: "ENOTDIR" });
  await assert.rejects(store.prune(NOW), { code: "ENOTDIR" });
});

function plan(overrides = {}) {
  return buildPlan({
    operation: "trash",
    providerId: "cache.language",
    findingId: "cache.language:pip",
    scopeSummary: "1 directory under ~/.cache",
    createdAt: NOW,
    expiryMinutes: 60,
    warnings: [],
    entries: [
      {
        path: rawPathFromUtf8("/home/example/.cache/pip"),
        expected: {
          device: 66306n,
          inode: 1179651n,
          mountId: "29",
          kind: "directory",
          apparentBytes: 4096n,
          modifiedNanoseconds: 1758000000123456789n,
        },
        reviewedBytes: 41943040n,
      },
    ],
    ...overrides,
  });
}

test("a stored plan comes back with every byte it went in with", async () => {
  const store = createPlanStore(await sandbox());
  const saved = plan();
  await store.save(saved);

  const loaded = await store.get(saved.id);
  assert.deepEqual(loaded, saved);
});

test("a name that is not valid UTF-8 survives being stored and read back", async () => {
  const store = createPlanStore(await sandbox());
  const odd = rawPathFromBytes(new Uint8Array([0x2f, 0x74, 0x6d, 0x70, 0x2f, 0xff, 0xfe, 0x2e, 0x62]));
  const saved = plan({
    entries: [
      {
        path: odd,
        expected: {
          device: 1n,
          inode: 2n,
          mountId: "3",
          kind: "file",
          apparentBytes: 4n,
          modifiedNanoseconds: 5n,
        },
        reviewedBytes: 6n,
      },
    ],
  });
  await store.save(saved);

  const loaded = await store.get(saved.id);
  assert.equal(loaded.entries[0].path.bytesBase64, odd.bytesBase64);
  assert.equal(loaded.entries[0].path.utf8, undefined);
});

test("a plan file is readable only by the user who owns it", async () => {
  const root = await sandbox();
  const store = createPlanStore(root);
  const saved = plan();
  await store.save(saved);

  const [name] = await readdir(join(root, "plans"));
  const mode = (await stat(join(root, "plans", name))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("an id that could name another file is refused without touching the disk", async () => {
  const store = createPlanStore(await sandbox());
  for (const id of ["../escape", "plans/../../etc/passwd", "", ".", "..", "a/b"]) {
    assert.equal(await store.get(id), undefined, `${id} was resolved`);
  }
});

test("an unknown plan is absent rather than an error", async () => {
  const store = createPlanStore(await sandbox());
  assert.equal(await store.get("plan-does-not-exist"), undefined);
});

test("a plan file this build cannot read is skipped, not guessed at", async () => {
  const root = await sandbox();
  const store = createPlanStore(root);
  await store.save(plan());
  await writeFile(join(root, "plans", "plan-from-the-future.json"), '{"version":99}\n', "utf8");

  assert.equal(await store.get("plan-from-the-future"), undefined);
  assert.equal((await store.list()).length, 1);
});

test("pruning removes the plans that have expired and keeps the ones that have not", async () => {
  const root = await sandbox();
  const store = createPlanStore(root);
  const current = plan();
  const stale = plan({ createdAt: new Date("2026-09-01T09:00:00.000Z") });
  await store.save(current);
  await store.save(stale);

  assert.equal(await store.prune(new Date("2026-10-01T09:30:00.000Z")), 1);
  assert.equal(await store.get(stale.id), undefined);
  assert.notEqual(await store.get(current.id), undefined);
});

test("a stored plan's reversibility is re-derived, never believed", async () => {
  const root = await sandbox();
  const store = createPlanStore(root);
  const saved = plan({ operation: "permanent" });
  await store.save(saved);

  // A plan file claiming a permanent removal can be undone. Nothing but the
  // operation decides that, so the claim is ignored rather than acted on.
  const file = join(root, "plans", `${saved.id}.json`);
  const document = JSON.parse(await readFile(file, "utf8"));
  document.reversibility = "undo-from-trash";
  await writeFile(file, JSON.stringify(document));

  const loaded = await store.get(saved.id);
  assert.equal(loaded.reversibility, "irreversible");
});

test("a stored plan naming an operation this build does not know is skipped", async () => {
  const root = await sandbox();
  const store = createPlanStore(root);
  const saved = plan();
  await store.save(saved);

  const file = join(root, "plans", `${saved.id}.json`);
  const document = JSON.parse(await readFile(file, "utf8"));
  document.operation = "obliterate";
  await writeFile(file, JSON.stringify(document));

  assert.equal(await store.get(saved.id), undefined);
});

// --- Phase 5: a destination and a source disposition round-trip ---

test("a move plan's destination and source disposition survive being stored", async () => {
  const store = createPlanStore(await sandbox());
  const saved = plan({
    operation: "move",
    destination: rawPathFromUtf8("/mnt/archive"),
    sourceDisposition: "trash",
  });

  await store.save(saved);

  const loaded = await store.get(saved.id);
  assert.deepEqual(loaded, saved);
  assert.equal(loaded.destination.display, "/mnt/archive");
  assert.equal(loaded.sourceDisposition, "trash");
});

test("a destination whose bytes are not valid UTF-8 round-trips exactly", async () => {
  const store = createPlanStore(await sandbox());
  const odd = rawPathFromBytes(new Uint8Array([0x2f, 0x6d, 0x6e, 0x74, 0x2f, 0xff, 0xfe]));
  const saved = plan({ operation: "move", destination: odd, sourceDisposition: "permanent" });

  await store.save(saved);

  const loaded = await store.get(saved.id);
  assert.equal(loaded.destination.bytesBase64, odd.bytesBase64);
});

test("a stored file claiming a permanent move can be undone is not believed", async () => {
  const root = await sandbox();
  const store = createPlanStore(root);
  const saved = plan({
    operation: "move",
    destination: rawPathFromUtf8("/mnt/archive"),
    sourceDisposition: "permanent",
  });
  await store.save(saved);

  const file = join(root, "plans", `${saved.id}.json`);
  const tampered = JSON.parse(await readFile(file, "utf8"));
  tampered.reversibility = "undo-from-trash";
  await writeFile(file, JSON.stringify(tampered));

  const loaded = await store.get(saved.id);
  assert.equal(
    loaded.reversibility,
    "irreversible",
    "reversibility is re-derived from the operation and the disposition, never read",
  );
});

test("a stored file whose disposition is not one Disktop knows is skipped, not guessed at", async () => {
  const root = await sandbox();
  const store = createPlanStore(root);
  const saved = plan({
    operation: "move",
    destination: rawPathFromUtf8("/mnt/archive"),
    sourceDisposition: "trash",
  });
  await store.save(saved);

  const file = join(root, "plans", `${saved.id}.json`);
  const tampered = JSON.parse(await readFile(file, "utf8"));
  tampered.sourceDisposition = "shred";
  await writeFile(file, JSON.stringify(tampered));

  assert.equal(await store.get(saved.id), undefined);
});

// --- A stored plan that cannot vouch for itself is not read ---

async function tamper(edit) {
  const root = await sandbox();
  const store = createPlanStore(root);
  const saved = plan();
  await store.save(saved);
  const file = join(root, "plans", `${saved.id}.json`);
  const document = JSON.parse(await readFile(file, "utf8"));
  edit(document);
  await writeFile(file, JSON.stringify(document));
  return store.get(saved.id);
}

const TAMPERINGS = {
  "an expiry that is not a date": (document) => {
    document.expiresAt = "never";
  },
  "a creation time that is not a date": (document) => {
    document.createdAt = "yesterday";
  },
  "an expiry before its creation": (document) => {
    document.expiresAt = "2026-10-01T08:00:00.000Z";
  },
  "an expiry further out than any configuration allows": (document) => {
    document.expiresAt = "2026-10-03T09:00:00.000Z";
  },
  "no entries for a trash operation": (document) => {
    delete document.entries;
  },
  "an empty entry list": (document) => {
    document.entries = [];
  },
  "an entry of a kind Disktop never plans": (document) => {
    document.entries[0].expected.kind = "socket";
  },
  "a selected total that is not the sum of its entries": (document) => {
    document.selectedBytes = "999999999999";
  },
  "an item count that is not the number of its entries": (document) => {
    document.exactItemCount = "7";
  },
};

for (const [name, edit] of Object.entries(TAMPERINGS)) {
  test(`a stored plan is not read when it has ${name}`, async () => {
    assert.equal(await tamper(edit), undefined);
  });
}

test("a reviewed directory's subtree survives being stored", async () => {
  const store = createPlanStore(await sandbox());
  const base = plan();
  const saved = { ...base, entries: [{ ...base.entries[0], subtree: { entries: 12n, digest: "0f".repeat(32) } }] };
  await store.save(saved);
  assert.deepEqual(await store.get(saved.id), saved);
});

test("a stored subtree whose digest is not a digest is not read", async () => {
  assert.equal(
    await tamper((document) => {
      document.entries[0].subtree = { entries: "1", digest: "not-hex" };
    }),
    undefined,
  );
});

// --- Manager plans ---

async function managerPlan(scopeInput) {
  const { managerScope } = await import("../../dist/domain/managers.js");
  return buildPlan({
    operation: "manager",
    providerId: "managers",
    findingId: `managers:${scopeInput.action}`,
    scopeSummary: "Stopped containers",
    createdAt: NOW,
    expiryMinutes: 60,
    entries: [],
    manager: managerScope(scopeInput),
    warnings: [],
  });
}

const CONTAINERS = {
  action: "docker.remove-stopped-containers",
  items: [{ id: "c".repeat(64), bytes: 1024n }],
  parameters: {},
  count: { kind: "exact", value: 1n },
  estimatedBytes: 1024n,
  preview: "listed",
};

async function storedManager(edit) {
  const root = await sandbox();
  const store = createPlanStore(root);
  const saved = await managerPlan(CONTAINERS);
  await store.save(saved);
  const file = join(root, "plans", `${saved.id}.json`);
  const document = JSON.parse(await readFile(file, "utf8"));
  edit?.(document);
  await writeFile(file, JSON.stringify(document));
  return { saved, loaded: await store.get(saved.id), document };
}

test("a manager plan round-trips, and its commands are derived rather than stored", async () => {
  const { saved, loaded, document } = await storedManager();
  assert.deepEqual(loaded, saved);
  assert.equal(document.manager.commands, undefined, "no argv is written to the plan file");
  assert.deepEqual(loaded.manager.commands, [
    { tool: "docker", arguments: ["container", "rm", "--", "c".repeat(64)] },
  ]);
});

test("a manager plan with an unknown estimate stores no selected bytes and reads back without any", async () => {
  const root = await sandbox();
  const store = createPlanStore(root);
  const saved = await managerPlan({
    action: "journald.vacuum",
    items: [],
    parameters: { keepBytes: "536870912" },
    count: { kind: "unknown" },
    preview: "none",
  });
  await store.save(saved);
  const loaded = await store.get(saved.id);
  assert.equal(loaded.selectedBytes, undefined);
  assert.deepEqual(loaded, saved);
});

const MANAGER_TAMPERINGS = {
  "a command written into it": (document) => {
    document.manager.commands = [{ tool: "sh", arguments: ["-c", "rm -rf ~"] }];
  },
  "an item that reads as an option": (document) => {
    document.manager.items[0].id = "--all";
  },
  "an action this build does not know": (document) => {
    document.manager.action = "docker.system-prune";
  },
  "entries beside its manager selection": (document) => {
    document.entries = [];
  },
  "a selected total that is not its estimate": (document) => {
    document.selectedBytes = "999";
  },
  "a count that is not its item count": (document) => {
    document.exactItemCount = "9";
  },
  "a parameter its action does not take": (document) => {
    document.manager.parameters = { keepBytes: "1" };
  },
};

for (const [name, edit] of Object.entries(MANAGER_TAMPERINGS)) {
  test(`a stored manager plan is not read when it has ${name}`, async () => {
    const { loaded } = await storedManager(edit);
    assert.equal(loaded, undefined);
  });
}

test("a stored plan from the previous format is not read", async () => {
  const { loaded } = await storedManager((document) => {
    document.version = 1;
  });
  assert.equal(loaded, undefined);
});

test("a stored file cannot claim a manager plan needs no administrator rights", async () => {
  const root = await sandbox();
  const store = createPlanStore(root);
  const saved = await managerPlan({
    action: "apt.clean",
    items: [{ id: "curl_8.5.0-2_amd64.deb", bytes: 1n }],
    parameters: {},
    count: { kind: "exact", value: 1n },
    estimatedBytes: 1n,
    preview: "listed",
  });
  await store.save(saved);
  const file = join(root, "plans", `${saved.id}.json`);
  const document = JSON.parse(await readFile(file, "utf8"));
  document.permission = "user";
  await writeFile(file, JSON.stringify(document));
  assert.equal((await store.get(saved.id)).permission, "manager-privilege");
});

test("plan publication refuses to replace an existing reviewed ID", async () => {
  const root = await sandbox();
  const store = createPlanStore(root);
  const saved = plan();
  await store.save(saved);
  const file = join(root, "plans", `${saved.id}.json`);
  const before = await readFile(file);
  await assert.rejects(store.save({ ...saved, scopeSummary: "a different selection" }), (error) => error.code === "EEXIST");
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readdir(join(root, "plans")), [`${saved.id}.json`], "failed publication cleans its stage");
});

test("plan save refuses IDs that could write outside its store", async () => {
  const root = await sandbox();
  const store = createPlanStore(root);
  await assert.rejects(store.save({ ...plan(), id: "../outside" }), /plan ID/);
  assert.deepEqual(await readdir(root), []);
});

test("an internal plan ID must match its filename before reading or pruning", async () => {
  const root = await sandbox();
  const store = createPlanStore(root);
  const saved = plan({ createdAt: new Date("2026-09-01T09:00:00.000Z") });
  await store.save(saved);
  const file = join(root, "plans", `${saved.id}.json`);
  const outside = join(root, "outside.json");
  await writeFile(outside, "keep this");
  const document = JSON.parse(await readFile(file, "utf8"));
  document.id = "../outside";
  await writeFile(file, JSON.stringify(document));
  assert.equal(await store.get(saved.id), undefined);
  assert.equal((await store.list()).length, 0);
  assert.equal(await store.prune(NOW), 0);
  assert.equal(await readFile(outside, "utf8"), "keep this", "prune cannot resolve an ID read from untrusted contents");
});

test("pipes, symlinks and oversized plan files are refused without blocking or unbounded reads", async () => {
  const { open, symlink } = await import("node:fs/promises");
  const { spawnSync } = await import("node:child_process");
  const root = await sandbox();
  const store = createPlanStore(root);
  await store.save(plan());
  const directory = join(root, "plans");
  assert.equal(spawnSync("mkfifo", [join(directory, "pipe.json")]).status, 0);
  await symlink("/dev/zero", join(directory, "device.json"));
  const large = await open(join(directory, "large.json"), "w");
  try { await large.truncate(64 * 1024 * 1024 + 1); } finally { await large.close(); }
  for (const id of ["pipe", "device", "large"]) assert.equal(await store.get(id), undefined);
  assert.equal((await store.list()).length, 1, "only the regular bounded record is usable");
});
