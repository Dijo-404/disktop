/** Readings and service fakes for the TUI, so no test touches a real disk or terminal. */
import { FIXTURE_SNAPSHOT, FIXTURE_VIEW, rawPath } from "./cli-context.mjs";

export const NOW = Date.parse("2026-10-03T10:00:00Z");
export const HOME = "/home/example";

let nextId = 100;

export function entry(path, kind, allocated, overrides = {}) {
  nextId += 1;
  return {
    id: String(nextId),
    parentId: "41",
    path: rawPath(path),
    kind,
    device: 2049n,
    inode: BigInt(nextId),
    mountId: "29",
    linkCount: 1n,
    apparentBytes: allocated - 4096n > 0n ? allocated - 4096n : allocated,
    allocatedBytes: allocated,
    ownerId: 1000n,
    modifiedNanoseconds: BigInt(NOW - 3 * 86_400_000) * 1_000_000n,
    shared: false,
    ...(kind === "directory" ? { childEntries: 12n } : {}),
    ...overrides,
  };
}

export const ROOT_ENTRY = entry("/home/example/projects", "directory", 91_268_055_040n, { id: "41", parentId: undefined, childEntries: 5n });

export const CHILDREN = [
  entry("/home/example/projects/node_modules", "directory", 19_757_268_992n),
  entry("/home/example/projects/android-sdk", "directory", 12_884_901_888n),
  entry("/home/example/projects/vm-images", "directory", 10_307_921_510n),
  entry("/home/example/projects/disk.img", "file", 4_294_967_296n),
  entry("/home/example/projects/日本語のファイル名.txt", "file", 8192n),
  entry("/home/example/projects/emoji-🎉-party", "directory", 40960n),
  entry("/home/example/projects/dangling", "symlink", 0n, { broken: true }),
];

export const TYPE_TOTALS = [
  { extension: "js", entries: 40_000n, allocatedBytes: 9_000_000_000n, apparentBytes: 8_800_000_000n },
  { extension: "img", entries: 1n, allocatedBytes: 4_294_967_296n, apparentBytes: 4_294_967_296n },
  { extension: "map", entries: 9_000n, allocatedBytes: 2_000_000_000n, apparentBytes: 1_900_000_000n },
  { extension: "", entries: 3_000n, allocatedBytes: 1_000_000_000n, apparentBytes: 900_000_000n },
];

export const SNAPSHOT = { ...FIXTURE_SNAPSHOT, scope: { ...FIXTURE_SNAPSHOT.scope, roots: [rawPath("/home/example/projects")] } };

export function finding(id, category, title, bytes, overrides = {}) {
  return {
    id,
    providerId: id.split(":")[0],
    providerVersion: 1,
    category,
    title,
    evidence: [`${title} was found by a fixture.`],
    paths: [rawPath(`/home/example/${id.replace(/[^a-z]/g, "-")}`)],
    size: bytes === undefined ? { basis: "unknown", explanation: "Nothing measured it." } : { bytes, basis: "measured-allocated", explanation: "Measured from the index." },
    confidence: "observed",
    capability: { status: "available", explanation: "Readable." },
    availableActionIds: ["trash", "permanent"],
    regenerationCost: "Rebuilt by the next install.",
    active: false,
    ...overrides,
  };
}

export const FINDINGS = [
  finding("dev.artifacts:node-modules", "project-artifact", "node_modules in 14 projects", 18_400_000_000n),
  finding("caches.language:pip", "language-cache", "pip download cache", 2_100_000_000n),
  finding("caches.browser:firefox", "browser-cache", "Firefox cache", 1_200_000_000n, { active: true }),
  finding("managers:apt", "package-cache", "Downloaded apt packages", 900_000_000n, {
    paths: [],
    managerScope: "apt-get clean",
    size: { bytes: 900_000_000n, basis: "manager-reported", explanation: "apt says so." },
    availableActionIds: ["manager"],
  }),
  finding("apps.installed:dpkg", "installed-app", "412 dpkg packages", 9_800_000_000n, { availableActionIds: [] }),
  finding("diagnostics.smart:nvme0", "diagnostic", "SMART health", undefined, {
    availableActionIds: [],
    capability: { status: "missing-tool", explanation: "smartctl is not installed." },
  }),
];

export const SUMMARY = {
  findings: FINDINGS,
  providers: [
    { providerId: "dev.artifacts", version: 1, capability: { status: "available", explanation: "ok" }, findings: 1, complete: true, ran: true },
    { providerId: "diagnostics.smart", version: 1, capability: { status: "missing-tool", explanation: "smartctl is not installed." }, findings: 0, complete: true, ran: false },
  ],
  warnings: [],
  complete: true,
  categoryTotals: [],
  measured: true,
  capability: { status: "available", explanation: "ok" },
};

export const PLAN = {
  id: "plan-20261003100000-abcdefgh",
  operation: "trash",
  createdAt: "2026-10-03T10:00:00.000Z",
  expiresAt: "2026-10-03T11:00:00.000Z",
  providerId: "explore",
  scopeSummary: "1 directory under ~/projects",
  reversibility: "undo-from-trash",
  permission: "user",
  exactItemCount: 1n,
  selectedBytes: 19_757_268_992n,
  entries: [
    {
      path: rawPath("/home/example/projects/node_modules"),
      expected: { device: 2049n, inode: 1n, mountId: "29", kind: "directory", apparentBytes: 4096n, modifiedNanoseconds: 1n },
      reviewedBytes: 19_757_268_992n,
    },
  ],
  warnings: ["A Trash move on the same filesystem usually frees nothing until Trash is emptied."],
};

export const RECORDS = [
  {
    id: "journal-20261003-0001",
    planId: PLAN.id,
    operation: "trash",
    startedAt: "2026-10-03T09:00:00.000Z",
    finishedAt: "2026-10-03T09:00:02.000Z",
    state: "complete",
    completed: 1n,
    skipped: 0n,
    failed: 0n,
    selectedBytes: 19_757_268_992n,
    bytesMovedToTrash: 19_757_268_992n,
    freeBytesBefore: 100n,
    freeBytesAfter: 100n,
    items: [
      {
        path: rawPath("/home/example/projects/node_modules"),
        destination: rawPath("/home/example/.local/share/Trash/files/node_modules"),
        outcome: "completed",
        bytes: 19_757_268_992n,
      },
    ],
  },
  {
    id: "journal-20261002-0007",
    planId: "plan-x",
    operation: "erase",
    startedAt: "2026-10-02T09:00:00.000Z",
    state: "uncertain",
    completed: 3n,
    skipped: 0n,
    failed: 0n,
    bytesMovedToTrash: 0n,
    items: [{ path: rawPath("/home/example/tmp/a"), outcome: "uncertain", bytes: 1n }],
  },
];

/** Every service the TUI reaches, answering from the fixtures above and recording what it was asked. */
export function fakeServices(overrides = {}) {
  const calls = [];
  const services = {
    calls,
    dashboard: {
      async dashboard() {
        const { devices, ...rest } = FIXTURE_VIEW;
        void devices;
        return rest;
      },
      async inventory() {
        calls.push(["inventory"]);
        return overrides.view ?? FIXTURE_VIEW;
      },
    },
    scan: {
      async run(roots, scanOverrides, signal, onProgress) {
        calls.push(["scan", roots[0].display]);
        onProgress?.({ scannedEntries: 1000n, processedBytes: 4096n, inaccessibleDirectories: 0n, currentPath: rawPath(`${roots[0].display}/a`) });
        if (overrides.scanWaits) {
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          return {
            kind: "scanned",
            summary: {
              scanId: "scan-cancelled",
              accounting: "allocated",
              roots,
              completeness: { complete: false, scannedEntries: 1000n, inaccessibleDirectories: 0n, excludedMounts: [], warnings: [{ code: "cancelled", message: "The scan was cancelled." }] },
              totals: { allocatedBytes: 1n, apparentBytes: 1n, sharedBytes: 0n },
              filesystems: ["fs-259-2"],
              crossFilesystems: false,
            },
          };
        }
        return {
          kind: "scanned",
          summary: {
            scanId: SNAPSHOT.scanId,
            accounting: "allocated",
            roots,
            completeness: SNAPSHOT.completeness,
            totals: SNAPSHOT.totals,
            filesystems: ["fs-259-2"],
            crossFilesystems: false,
          },
        };
      },
    },
    explore: {
      async page(request) {
        calls.push(["page", request.filter]);
        if (overrides.explorePage !== undefined) {
          return overrides.explorePage(request);
        }
        if (request.filter.atPath !== undefined) {
          return { kind: "page", page: { entries: request.filter.atPath.display === ROOT_ENTRY.path.display ? [ROOT_ENTRY] : [entry(request.filter.atPath.display, "directory", 1000n, { id: "77" })] } };
        }
        if (request.includeTypeTotals) {
          return { kind: "page", page: { entries: [], typeTotals: TYPE_TOTALS } };
        }
        if (request.filter.parentId !== undefined) {
          return { kind: "page", page: { entries: request.filter.parentId === "41" ? CHILDREN : [] } };
        }
        return { kind: "page", page: { entries: CHILDREN.filter((child) => child.kind === "file") } };
      },
    },
    snapshots: {
      saved: [],
      async list() {
        return overrides.snapshots ?? [SNAPSHOT];
      },
      async record(summary, scope, now) {
        calls.push(["record", summary.scanId]);
        return SNAPSHOT;
      },
      async prune() {
        return 0;
      },
      async diff() {
        return { kind: "missing", id: "x" };
      },
      async latestFor() {
        return undefined;
      },
    },
    find: {
      async find(request) {
        calls.push(["find", request.kind]);
        if (request.kind === "duplicates") {
          return { kind: "duplicates", result: { kind: "found", groups: [], reclaimableBytes: 0n, complete: true, warnings: [], candidatesRead: 0n, filesHashed: 0n } };
        }
        return { kind: "found", entries: [] };
      },
    },
    footprint: {
      async discover(request, signal) {
        calls.push(["discover"]);
        if (overrides.discoverWaits) {
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        }
        return overrides.summary ?? SUMMARY;
      },
    },
    async plan(request) {
      calls.push(["plan", request.operation, request.findingId ?? request.path?.display]);
      if (overrides.plan !== undefined) {
        return overrides.plan(request);
      }
      return { kind: "planned", plan: { ...PLAN, operation: request.operation, reversibility: request.operation === "trash" ? "undo-from-trash" : "irreversible" } };
    },
    async apply(request, signal) {
      calls.push(["apply", request.planId, request.acknowledgePermanent, signal.aborted]);
      if (overrides.applyWaits) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        calls.push(["apply-stopped"]);
      }
      return {
        kind: "applied",
        plan: PLAN,
        result: {
          planId: PLAN.id,
          completed: 1n,
          skipped: 0n,
          failed: 0n,
          selectedBytes: PLAN.selectedBytes,
          bytesMovedToTrash: PLAN.selectedBytes,
          freeBytesBefore: 100n,
          freeBytesAfter: 100n,
          state: "complete",
          journalId: "journal-20261003-0001",
          undoAvailable: true,
          verification: [{ check: "source-disposed", outcome: "passed", detail: "The source is gone from its path." }],
        },
        observedFreeSpaceChange: 0n,
        notes: ["A Trash move on the same filesystem usually frees nothing until Trash is emptied."],
      };
    },
    async history(cursor, limit) {
      calls.push(["history", cursor, limit]);
      return { records: overrides.records ?? RECORDS, reconciled: 0n };
    },
    async restore(journalId) {
      calls.push(["restore", journalId]);
      return { kind: "restored", record: RECORDS[0], result: { planId: "p", completed: 1n, skipped: 0n, failed: 0n, selectedBytes: 1n, bytesMovedToTrash: 0n, state: "complete", journalId, undoAvailable: false, verification: [] }, notes: [] };
    },
    defaults: { excludes: [], retention: { keepLatest: 20 }, staleAfterDays: 183 },
    home: rawPath(HOME),
    now: () => new Date(NOW),
  };
  return services;
}

/** Hooks that record what the controller asked of the terminal. */
export function fakeHooks() {
  const hooks = {
    changes: 0,
    exits: [],
    suspended: [],
    resumed: 0,
    changed() {
      hooks.changes += 1;
    },
    pageRows: () => 10,
    suspend(message) {
      hooks.suspended.push(message);
    },
    resume() {
      hooks.resumed += 1;
    },
    exit(code) {
      hooks.exits.push(code);
    },
  };
  return hooks;
}
