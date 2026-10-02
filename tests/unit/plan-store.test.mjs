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
