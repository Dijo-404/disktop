import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlanService } from "../../dist/application/plan-action.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";

const NOW = new Date("2026-10-01T09:00:00.000Z");
const HOME = rawPathFromUtf8("/home/example");

function facts(overrides = {}) {
  return {
    kind: "directory",
    apparentBytes: 4096n,
    allocatedBytes: 41943040n,
    ownerId: 1000n,
    modifiedNanoseconds: 1758000000123456789n,
    device: 66306n,
    inode: 1179651n,
    mountId: "66306",
    ...overrides,
  };
}

function finding(overrides = {}) {
  return {
    id: "cache.language:pip",
    providerId: "cache.language",
    providerVersion: 1,
    category: "language-cache",
    title: "pip's download cache",
    evidence: ["~/.cache/pip holds wheels pip downloaded."],
    paths: [rawPathFromUtf8("/home/example/.cache/pip")],
    size: { bytes: 41943040n, basis: "measured-allocated", explanation: "Blocks on disk." },
    confidence: "observed",
    capability: { status: "available", explanation: "The directory was read." },
    availableActionIds: ["trash"],
    regenerationCost: "Re-downloaded on the next install.",
    active: false,
    ...overrides,
  };
}

function service(overrides = {}) {
  const saved = [];
  const built = {
    service: createPlanService({
      footprint: {
        async discover() {
          return {
            findings: overrides.findings ?? [finding()],
            providers: [],
            warnings: [],
            complete: true,
            categoryTotals: [],
            measured: true,
            capability: { status: "available", explanation: "1 of 1 detectors ran." },
          };
        },
      },
      inventory: {
        async list() {
          return {
            devices: [],
            filesystems: [
              {
                id: "fs-1",
                type: "ext4",
                source: "/dev/sda1",
                mounts: [rawPathFromUtf8("/"), rawPathFromUtf8("/home")],
                totalBytes: 1n,
                freeBytes: 1n,
                availableBytes: 1n,
                network: false,
                removable: false,
              },
            ],
            warnings: [],
            capability: { status: "available", explanation: "read" },
          };
        },
      },
      paths: {
        async facts(path) {
          return typeof overrides.facts === "function"
            ? overrides.facts(path)
            : (overrides.facts ?? facts());
        },
      },
      footprints: {
        async measure(paths) {
          return {
            measurements: paths.map((path) => ({
              path,
              ...(overrides.measured === null
                ? {}
                : { bytes: overrides.measured ?? 7_314_112_512n }),
              basis: overrides.measured === null ? "unknown" : "measured-allocated",
              explanation: "Blocks on disk, measured by the scan that covered this path.",
            })),
            warnings: [],
          };
        },
      },
      store: { async save(plan) { saved.push(plan); } },
      settings: {
        home: HOME,
        allowedRoots: [HOME],
        excludedRoots: [rawPathFromUtf8("/home/example/.local/state/disktop")],
        trashDirectory: rawPathFromUtf8("/home/example/.local/share/Trash"),
        expiryMinutes: 60,
      },
      now: () => NOW,
    }),
    saved,
  };
  return built;
}

const SIGNAL = new AbortController().signal;

test("planning a finding fixes the identity each path had at review time", async () => {
  const { service: planner, saved } = service();
  const outcome = await planner.plan({ operation: "trash", findingId: "cache.language:pip" }, SIGNAL);

  assert.equal(outcome.kind, "planned");
  assert.equal(outcome.plan.operation, "trash");
  assert.equal(outcome.plan.findingId, "cache.language:pip");
  assert.equal(outcome.plan.entries.length, 1);
  assert.deepEqual(outcome.plan.entries[0].expected, {
    device: 66306n,
    inode: 1179651n,
    mountId: "66306",
    kind: "directory",
    apparentBytes: 4096n,
    modifiedNanoseconds: 1758000000123456789n,
  });
  assert.equal(
    outcome.plan.entries[0].reviewedBytes,
    7_314_112_512n,
    "a directory is reviewed at its whole subtree, not at the bytes of its own inode",
  );
  assert.equal(outcome.plan.selectedBytes, 7_314_112_512n);
  assert.deepEqual(saved, [outcome.plan], "a plan is stored before it can be applied");
});

test("the operation the caller asked for is the operation the plan fixes", async () => {
  const { service: planner } = service();
  const outcome = await planner.plan({ operation: "permanent", findingId: "cache.language:pip" }, SIGNAL);
  assert.equal(outcome.plan.operation, "permanent");
  assert.equal(outcome.plan.reversibility, "irreversible");
});

test("a path under a protected root is refused before anything is stored", async () => {
  const { service: planner, saved } = service();
  const outcome = await planner.plan({ operation: "trash", path: rawPathFromUtf8("/etc/passwd") }, SIGNAL);

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "protected-path");
  assert.deepEqual(saved, []);
});

test("a mount root is refused even when it sits inside an allowed root", async () => {
  const { service: planner } = service();
  const outcome = await planner.plan({ operation: "trash", path: rawPathFromUtf8("/home") }, SIGNAL);
  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "protected-path");
});

test("an unknown finding is refused by name rather than planned as nothing", async () => {
  const { service: planner } = service();
  const outcome = await planner.plan({ operation: "trash", findingId: "cache.language:absent" }, SIGNAL);
  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-input");
  assert.match(outcome.failure.message, /cache\.language:absent/);
});

test("a finding that offers no generic action cannot be planned into one", async () => {
  const { service: planner } = service({ findings: [finding({ availableActionIds: [] })] });
  const outcome = await planner.plan({ operation: "trash", findingId: "cache.language:pip" }, SIGNAL);
  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-plan");
});

test("a finding whose data is in use is planned with the warning that says so", async () => {
  const { service: planner } = service({
    findings: [finding({ active: true, availableActionIds: ["trash"] })],
  });
  const outcome = await planner.plan({ operation: "trash", findingId: "cache.language:pip" }, SIGNAL);
  assert.equal(outcome.kind, "planned");
  assert.ok(
    outcome.plan.warnings.some((warning) => /in use/i.test(warning)),
    `warnings were ${JSON.stringify(outcome.plan.warnings)}`,
  );
});

test("a path that is no longer there is refused rather than planned against nothing", async () => {
  const { service: planner } = service({ facts: undefined });
  const planner2 = createPlanService({
    footprint: { async discover() { return { findings: [], providers: [], warnings: [], complete: true, categoryTotals: [], measured: true, capability: { status: "available", explanation: "" } }; } },
    inventory: {
      async list() {
        return {
          devices: [],
          filesystems: [{ id: "fs-1", type: "ext4", source: "/dev/sda1", mounts: [rawPathFromUtf8("/")], totalBytes: 1n, freeBytes: 1n, availableBytes: 1n, network: false, removable: false }],
          warnings: [],
          capability: { status: "available", explanation: "read" },
        };
      },
    },
    paths: { async facts() { return undefined; } },
    store: { async save() {} },
    settings: { home: HOME, allowedRoots: [HOME], excludedRoots: [rawPathFromUtf8("/home/example/.local/state/disktop")], expiryMinutes: 60 },
    now: () => NOW,
  });
  assert.ok(planner);
  const outcome = await planner2.plan(
    { operation: "trash", path: rawPathFromUtf8("/home/example/.cache/gone") },
    SIGNAL,
  );
  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "changed-target");
});

test("an inventory that could not be read refuses every plan rather than skipping the mount check", async () => {
  const planner = createPlanService({
    footprint: { async discover() { return { findings: [finding()], providers: [], warnings: [], complete: true, categoryTotals: [], measured: true, capability: { status: "available", explanation: "" } }; } },
    inventory: {
      async list() {
        return { devices: [], filesystems: [], warnings: [], capability: { status: "permission-denied", explanation: "mountinfo could not be read" } };
      },
    },
    paths: { async facts() { return facts(); } },
    store: { async save() {} },
    settings: { home: HOME, allowedRoots: [HOME], excludedRoots: [rawPathFromUtf8("/home/example/.local/state/disktop")], expiryMinutes: 60 },
    now: () => NOW,
  });

  const outcome = await planner.plan({ operation: "trash", findingId: "cache.language:pip" }, SIGNAL);
  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-plan");
});

test("a directory nothing could measure falls back to its own stat and says so", async () => {
  const { service: planner } = service({ measured: null });
  const outcome = await planner.plan({ operation: "trash", findingId: "cache.language:pip" }, SIGNAL);

  assert.equal(outcome.kind, "planned");
  assert.equal(outcome.plan.entries[0].reviewedBytes, 41943040n);
  assert.ok(
    outcome.plan.warnings.some((warning) => /could not be measured/i.test(warning)),
    `warnings were ${JSON.stringify(outcome.plan.warnings)}`,
  );
});

test("emptying Trash is planned against the Trash itself, and is irreversible", async () => {
  const { service: planner, saved } = service();
  const outcome = await planner.plan({ operation: "empty-trash" }, SIGNAL);

  assert.equal(outcome.kind, "planned");
  assert.equal(outcome.plan.operation, "empty-trash");
  assert.equal(outcome.plan.reversibility, "irreversible");
  assert.equal(
    outcome.plan.entries[0].path.display,
    "/home/example/.local/share/Trash",
    "with no path it means this user's own Trash",
  );
  assert.ok(outcome.plan.warnings.some((warning) => /cannot be undone/i.test(warning)));
  assert.equal(saved.length, 1);
});

test("emptying anything that is not a Trash directory is refused", async () => {
  const { service: planner, saved } = service();
  const outcome = await planner.plan(
    { operation: "empty-trash", path: rawPathFromUtf8("/home/example/documents") },
    SIGNAL,
  );

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "protected-path");
  assert.deepEqual(saved, []);
});

test("a file whose timestamp predates the epoch is planned, not crashed on", async () => {
  // Restored archives and some network filesystems produce these. The helper
  // clamps them; Node has to agree, or the command dies on an exception.
  const { service: planner } = service({ facts: facts({ modifiedNanoseconds: -86_400_000_000_000n }) });
  const outcome = await planner.plan({ operation: "trash", findingId: "cache.language:pip" }, SIGNAL);

  assert.equal(outcome.kind, "planned");
  assert.equal(outcome.plan.entries[0].expected.modifiedNanoseconds, 0n);
});

// --- Phase 5: move, compress, and hardlink plans ---

/** Facts that put one path on another filesystem, so a move is a real move. */
function acrossDisks(elsewhere) {
  return (path) =>
    path.display.startsWith(elsewhere)
      ? facts({ kind: "directory", device: 2049n, inode: 2n })
      : facts({ kind: "file", device: 66306n });
}

test("planning a move fixes where it publishes and what becomes of the source", async () => {
  const { service: planner, saved } = service({ facts: acrossDisks("/mnt/archive") });

  const outcome = await planner.plan(
    {
      operation: "move",
      path: rawPathFromUtf8("/home/example/big.iso"),
      destination: rawPathFromUtf8("/mnt/archive"),
      sourceDisposition: "trash",
    },
    SIGNAL,
  );

  assert.equal(outcome.kind, "planned");
  assert.equal(outcome.plan.operation, "move");
  assert.equal(outcome.plan.destination.display, "/mnt/archive");
  assert.equal(outcome.plan.sourceDisposition, "trash");
  assert.deepEqual(saved, [outcome.plan]);
});

test("a move onto the same filesystem is refused: that is a rename, not a move", async () => {
  const { service: planner } = service({
    facts: (path) =>
      path.display === "/home/example/elsewhere"
        ? facts({ kind: "directory", device: 66306n })
        : facts({ kind: "file", device: 66306n }),
  });

  const outcome = await planner.plan(
    {
      operation: "move",
      path: rawPathFromUtf8("/home/example/big.iso"),
      destination: rawPathFromUtf8("/home/example/elsewhere"),
      sourceDisposition: "trash",
    },
    SIGNAL,
  );

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-plan");
  assert.match(outcome.failure.message, /same filesystem/i);
});

test("a move whose destination sits inside its own source is refused", async () => {
  const { service: planner } = service({ facts: acrossDisks("/home/example/work/archive") });

  const outcome = await planner.plan(
    {
      operation: "move",
      path: rawPathFromUtf8("/home/example/work"),
      destination: rawPathFromUtf8("/home/example/work/archive"),
      sourceDisposition: "trash",
    },
    SIGNAL,
  );

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-plan");
  assert.match(outcome.failure.message, /inside/i);
});

test("a move without a destination is refused before anything is stored", async () => {
  const { service: planner, saved } = service({ facts: facts({ kind: "file" }) });

  const outcome = await planner.plan(
    { operation: "move", path: rawPathFromUtf8("/home/example/big.iso"), sourceDisposition: "trash" },
    SIGNAL,
  );

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-input");
  assert.deepEqual(saved, []);
});

test("a move without a source disposition is refused: apply time cannot choose", async () => {
  const { service: planner } = service({ facts: acrossDisks("/mnt/archive") });

  const outcome = await planner.plan(
    {
      operation: "move",
      path: rawPathFromUtf8("/home/example/big.iso"),
      destination: rawPathFromUtf8("/mnt/archive"),
    },
    SIGNAL,
  );

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-input");
});

test("a move whose destination is a protected root is refused", async () => {
  const { service: planner } = service({ facts: acrossDisks("/etc") });

  const outcome = await planner.plan(
    {
      operation: "move",
      path: rawPathFromUtf8("/home/example/big.iso"),
      destination: rawPathFromUtf8("/etc"),
      sourceDisposition: "trash",
    },
    SIGNAL,
  );

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "protected-path");
});

test("a move whose destination does not exist is refused rather than created", async () => {
  const { service: planner } = service({
    facts: (path) =>
      path.display === "/mnt/archive" ? undefined : facts({ kind: "file", device: 66306n }),
  });

  const outcome = await planner.plan(
    {
      operation: "move",
      path: rawPathFromUtf8("/home/example/big.iso"),
      destination: rawPathFromUtf8("/mnt/archive"),
      sourceDisposition: "trash",
    },
    SIGNAL,
  );

  assert.equal(outcome.kind, "refused");
  assert.match(outcome.failure.message, /\/mnt\/archive/);
});

test("a move whose destination is a file rather than a directory is refused", async () => {
  const { service: planner } = service({
    facts: (path) =>
      path.display === "/mnt/archive"
        ? facts({ kind: "file", device: 2049n })
        : facts({ kind: "file", device: 66306n }),
  });

  const outcome = await planner.plan(
    {
      operation: "move",
      path: rawPathFromUtf8("/home/example/big.iso"),
      destination: rawPathFromUtf8("/mnt/archive"),
      sourceDisposition: "trash",
    },
    SIGNAL,
  );

  assert.equal(outcome.kind, "refused");
  assert.match(outcome.failure.message, /directory/i);
});

test("planning a compress publishes beside the source when no destination is named", async () => {
  const { service: planner } = service({
    facts: (path) =>
      path.display === "/home/example"
        ? facts({ kind: "directory", device: 66306n })
        : facts({ kind: "directory", device: 66306n }),
  });

  const outcome = await planner.plan(
    {
      operation: "compress",
      path: rawPathFromUtf8("/home/example/work"),
      sourceDisposition: "trash",
    },
    SIGNAL,
  );

  assert.equal(outcome.kind, "planned");
  assert.equal(
    outcome.plan.destination.display,
    "/home/example",
    "an archive lands beside what it archives unless somebody said otherwise",
  );
  assert.equal(outcome.plan.sourceDisposition, "trash");
});

test("a permanent disposition makes the plan irreversible and says so", async () => {
  const { service: planner } = service({ facts: acrossDisks("/mnt/archive") });

  const outcome = await planner.plan(
    {
      operation: "move",
      path: rawPathFromUtf8("/home/example/big.iso"),
      destination: rawPathFromUtf8("/mnt/archive"),
      sourceDisposition: "permanent",
    },
    SIGNAL,
  );

  assert.equal(outcome.kind, "planned");
  assert.equal(outcome.plan.reversibility, "irreversible");
  assert.ok(outcome.plan.warnings.some((warning) => /cannot be undone/i.test(warning)));
});

test("planning a hardlink replacement over one file is refused", async () => {
  const { service: planner } = service({ facts: facts({ kind: "file" }) });

  const outcome = await planner.plan(
    { operation: "dedup-hardlink", path: rawPathFromUtf8("/home/example/a.bin") },
    SIGNAL,
  );

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-plan");
  assert.match(outcome.failure.message, /two/i);
});

test("a hardlink plan over a group of duplicates fixes every path in it", async () => {
  const { service: planner } = service({
    facts: facts({ kind: "file", device: 66306n }),
    findings: [
      finding({
        id: "duplicates:group-1",
        paths: [rawPathFromUtf8("/home/example/a.bin"), rawPathFromUtf8("/home/example/b.bin")],
        availableActionIds: ["dedup-hardlink"],
      }),
    ],
  });

  const outcome = await planner.plan(
    { operation: "dedup-hardlink", findingId: "duplicates:group-1" },
    SIGNAL,
  );

  assert.equal(outcome.kind, "planned");
  assert.equal(outcome.plan.entries.length, 2);
  assert.equal(outcome.plan.reversibility, "irreversible");
  assert.equal(outcome.plan.destination, undefined);
});

test("planning a hardlink from two explicit paths keeps the one named by --path", async () => {
  const { service: planner } = service({ facts: facts({ kind: "file", device: 66306n }) });

  const outcome = await planner.plan(
    {
      operation: "dedup-hardlink",
      path: rawPathFromUtf8("/home/example/a.bin"),
      replacePath: rawPathFromUtf8("/home/example/b.bin"),
    },
    SIGNAL,
  );

  assert.equal(outcome.kind, "planned");
  assert.equal(outcome.plan.entries.length, 2);
  assert.equal(outcome.plan.keepPath.display, "/home/example/a.bin");
  assert.deepEqual(
    outcome.plan.entries.map((planned) => planned.path.display),
    ["/home/example/a.bin", "/home/example/b.bin"],
  );
});

test("a hardlink plan that would replace a file with itself is refused", async () => {
  const { service: planner } = service({ facts: facts({ kind: "file" }) });

  const outcome = await planner.plan(
    {
      operation: "dedup-hardlink",
      path: rawPathFromUtf8("/home/example/a.bin"),
      replacePath: rawPathFromUtf8("/home/example/a.bin"),
    },
    SIGNAL,
  );

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-input");
});

test("--replace on an operation that keeps nothing is refused", async () => {
  const { service: planner } = service({ facts: facts({ kind: "file" }) });

  const outcome = await planner.plan(
    {
      operation: "trash",
      path: rawPathFromUtf8("/home/example/a.bin"),
      replacePath: rawPathFromUtf8("/home/example/b.bin"),
    },
    SIGNAL,
  );

  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-input");
});
