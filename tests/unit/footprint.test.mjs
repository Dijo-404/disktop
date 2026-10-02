import assert from "node:assert/strict";
import { test } from "node:test";
import { createFootprintService } from "../../dist/application/footprint.js";
import { findingSize } from "../../dist/domain/findings.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";

const CACHE = rawPathFromUtf8("/home/person/.cache/pip");
const MODELS = rawPathFromUtf8("/home/person/.ollama/models");

function finding(overrides) {
  return {
    id: "cache.language:pip",
    providerId: "cache.language",
    providerVersion: 1,
    category: "language-cache",
    title: "pip cache",
    evidence: [],
    paths: [CACHE],
    size: findingSize(undefined, "unknown", "Not measured yet."),
    confidence: "observed",
    capability: { status: "available", explanation: "The directory was read." },
    availableActionIds: ["trash"],
    active: false,
    ...overrides,
  };
}

function provider(id, capability, result) {
  return {
    id,
    version: 1,
    categories: ["language-cache"],
    probe: async () => capability,
    discover: async () => {
      if (typeof result === "function") {
        return result();
      }
      return result;
    },
  };
}

const AVAILABLE = { status: "available", explanation: "Its roots exist." };
const EMPTY = { findings: [], warnings: [], complete: true };

/** Measures anything it is asked about, so a filled size is visibly the port's. */
const measuring = {
  async measure(paths) {
    return {
      measurements: paths.map((path) => ({
        path,
        bytes: 4096n,
        basis: "measured-allocated",
        explanation: "Blocks on disk, from the scan index.",
      })),
      warnings: [],
    };
  },
};

function environment() {
  return {
    home: rawPathFromUtf8("/home/person"),
    variables: {},
    userId: 1000n,
    now: new Date("2026-10-01T00:00:00.000Z"),
    staleAfterDays: 183,
    appImageRoots: [],
    artifactDirectories: ["node_modules"],
    largeLogBytes: 134217728n,
    maxFindingsPerProvider: 50,
    paths: { facts: async () => undefined, list: async () => [], readText: async () => undefined },
    tools: { run: async () => ({ capability: AVAILABLE, stdout: "", stderr: "", exitCode: 0 }) },
    index: { directoriesNamed: async () => ({ paths: [], searched: false }) },
  };
}

function run(providers, request = { measureSizes: true }, footprints = measuring) {
  const service = createFootprintService(providers, environment(), footprints);
  return service.discover(request, new AbortController().signal);
}

test("every provider is listed, including the ones that could not look", async () => {
  const summary = await run([
    provider("cache.language", AVAILABLE, { findings: [finding({})], warnings: [], complete: true }),
    provider("storage.steam", { status: "missing-tool", explanation: "No Steam library exists." }, EMPTY),
  ]);

  assert.deepEqual(
    summary.providers.map((report) => [report.providerId, report.capability.status, report.findings]),
    [
      ["cache.language", "available", 1],
      ["storage.steam", "missing-tool", 0],
    ],
  );
  assert.deepEqual(
    summary.findings.map((entry) => entry.id),
    ["cache.language:pip"],
  );
});

test("a missing tool is not an incomplete answer, but a denied one is", async () => {
  const absent = await run([provider("storage.steam", { status: "missing-tool", explanation: "Absent." }, EMPTY)]);
  assert.equal(absent.complete, true, "an absent feature is absent, not hidden");
  assert.deepEqual(absent.warnings, []);

  const denied = await run([
    provider("diagnostic.open-deleted", { status: "permission-denied", explanation: "lsof refused." }, EMPTY),
  ]);
  assert.equal(denied.complete, false);
  assert.ok(
    denied.warnings.some((warning) => warning.message.includes("diagnostic.open-deleted")),
    `the denied provider is named: ${JSON.stringify(denied.warnings)}`,
  );
});

test("one provider that throws does not end the run", async () => {
  const summary = await run([
    provider("cache.broken", AVAILABLE, () => {
      throw new Error("the parser gave up");
    }),
    provider("cache.language", AVAILABLE, { findings: [finding({})], warnings: [], complete: true }),
  ]);

  assert.equal(summary.complete, false);
  assert.equal(summary.findings.length, 1, "the working provider still reported");
  const broken = summary.providers.find((report) => report.providerId === "cache.broken");
  assert.equal(broken.complete, false);
  assert.ok(
    summary.warnings.some((warning) => warning.message.includes("cache.broken")),
    `the failing provider is named: ${JSON.stringify(summary.warnings)}`,
  );
});

test("a provider's own incomplete result makes the summary incomplete", async () => {
  const summary = await run([
    provider("dev.project-artifacts", AVAILABLE, {
      findings: [],
      warnings: [{ code: "no-stored-scan", message: "No scan covers the home directory." }],
      complete: false,
    }),
  ]);

  assert.equal(summary.complete, false);
  assert.deepEqual(
    summary.warnings.map((warning) => warning.code),
    ["no-stored-scan"],
  );
});

test("measuring replaces an unknown size and leaves a manager's number alone", async () => {
  const summary = await run([
    provider("cache.language", AVAILABLE, {
      findings: [
        finding({}),
        finding({
          id: "apps.installed:flatpak",
          paths: [],
          managerScope: "flatpak uninstall --unused",
          size: findingSize(99n, "manager-reported", "Flatpak's own figure."),
        }),
      ],
      warnings: [],
      complete: true,
    }),
  ]);

  assert.equal(summary.measured, true);
  const byId = new Map(summary.findings.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.get("cache.language:pip").size, {
    bytes: 4096n,
    basis: "measured-allocated",
    explanation: "Blocks on disk, from the scan index.",
  });
  assert.deepEqual(byId.get("apps.installed:flatpak").size, {
    bytes: 99n,
    basis: "manager-reported",
    explanation: "Flatpak's own figure.",
  });
});

test("without measurement an unknown size stays unknown rather than becoming zero", async () => {
  const summary = await run(
    [provider("cache.language", AVAILABLE, { findings: [finding({})], warnings: [], complete: true })],
    { measureSizes: false },
  );

  assert.equal(summary.measured, false);
  assert.deepEqual(summary.findings[0].size.basis, "unknown");
  assert.equal(summary.findings[0].size.bytes, undefined);
  assert.deepEqual(summary.categoryTotals, [
    { category: "language-cache", findings: 1, bytes: 0n, unmeasured: 1, nested: 0 },
  ]);
});

test("a measurement that fails leaves the size unknown and says why", async () => {
  const refusing = {
    async measure(paths) {
      return {
        measurements: paths.map((path) => ({
          path,
          basis: "unknown",
          explanation: "The helper could not be started.",
        })),
        warnings: [{ code: "measurement-unavailable", message: "The helper could not be started." }],
      };
    },
  };

  const summary = await run(
    [provider("cache.language", AVAILABLE, { findings: [finding({})], warnings: [], complete: true })],
    { measureSizes: true },
    refusing,
  );

  assert.equal(summary.measured, false);
  assert.equal(summary.findings[0].size.basis, "unknown");
  assert.deepEqual(
    summary.warnings.map((warning) => warning.code),
    ["measurement-unavailable"],
  );
});

test("a category filter asks only the providers that could answer it", async () => {
  const asked = [];
  const watcher = (id, categories) => ({
    id,
    version: 1,
    categories,
    probe: async () => AVAILABLE,
    discover: async () => {
      asked.push(id);
      return EMPTY;
    },
  });

  const service = createFootprintService(
    [watcher("cache.language", ["language-cache"]), watcher("diagnostic.smart", ["diagnostic"])],
    environment(),
    measuring,
  );
  const summary = await service.discover(
    { measureSizes: false, categories: ["diagnostic"] },
    new AbortController().signal,
  );

  assert.deepEqual(asked, ["diagnostic.smart"]);
  assert.deepEqual(
    summary.providers.map((report) => report.providerId),
    ["diagnostic.smart"],
  );
});

test("an already-aborted run reports cancellation rather than an empty disk", async () => {
  const controller = new AbortController();
  controller.abort();
  const service = createFootprintService(
    [provider("cache.language", AVAILABLE, { findings: [finding({})], warnings: [], complete: true })],
    environment(),
    measuring,
  );

  const summary = await service.discover({ measureSizes: true }, controller.signal);

  assert.equal(summary.complete, false);
  assert.deepEqual(
    summary.warnings.map((warning) => warning.code),
    ["cancelled"],
  );
  assert.deepEqual(summary.findings, []);
});

test("findings from two providers over the same directory are merged once", async () => {
  const summary = await run(
    [
      provider("cache.ide", AVAILABLE, {
        findings: [finding({ id: "cache.ide:code", providerId: "cache.ide", paths: [rawPathFromUtf8("/home/person/.config/Code")] })],
        warnings: [],
        complete: true,
      }),
      provider("cache.electron", AVAILABLE, {
        findings: [
          finding({
            id: "cache.electron:code",
            providerId: "cache.electron",
            paths: [rawPathFromUtf8("/home/person/.config/Code/Cache")],
          }),
        ],
        warnings: [],
        complete: true,
      }),
    ],
    { measureSizes: false },
  );

  assert.deepEqual(
    summary.findings.map((entry) => entry.id),
    ["cache.ide:code"],
  );
});

test("a measurement that found nothing makes the whole result incomplete", async () => {
  const refusing = {
    async measure(paths) {
      return {
        measurements: paths.map((path) => ({ path, basis: "unknown", explanation: "The helper could not be started." })),
        warnings: [{ code: "measurement-unavailable", message: "The helper could not be started." }],
      };
    },
  };

  const summary = await run(
    [provider("cache.language", AVAILABLE, { findings: [finding({})], warnings: [], complete: true })],
    { measureSizes: true },
    refusing,
  );

  assert.equal(summary.measured, false);
  assert.equal(summary.complete, false, "sizes were asked for and none were established");
});

test("skipping measurement on purpose leaves the result complete", async () => {
  const summary = await run(
    [provider("cache.language", AVAILABLE, { findings: [finding({})], warnings: [], complete: true })],
    { measureSizes: false },
  );

  assert.equal(summary.measured, false);
  assert.equal(summary.complete, true, "nobody asked for sizes, so nothing was missed");
});

test("a detector that crashed is not reported as one that ran", async () => {
  const summary = await run([
    provider("cache.broken", AVAILABLE, () => {
      throw new Error("the parser gave up");
    }),
    provider("cache.language", AVAILABLE, { findings: [finding({})], warnings: [], complete: true }),
  ]);

  assert.match(summary.capability.explanation, /1 of 2/, summary.capability.explanation);
});

test("an abort partway through stops the run and says it was cancelled", async () => {
  const controller = new AbortController();
  const slow = (id) => ({
    id,
    version: 1,
    categories: ["language-cache"],
    probe: async () => AVAILABLE,
    discover: async () => {
      controller.abort();
      return { findings: [], warnings: [], complete: true };
    },
  });

  // Four run at a time; the ones behind them are never started.
  const many = ["one", "two", "three", "four", "five", "six", "seven", "eight"].map(slow);
  const service = createFootprintService(many, environment(), measuring);
  const summary = await service.discover({ measureSizes: false }, controller.signal);

  assert.equal(summary.complete, false);
  assert.ok(summary.warnings.some((warning) => warning.code === "cancelled"), JSON.stringify(summary.warnings));
  assert.ok(
    summary.providers.length <= 4,
    `detectors behind the running four should not have been asked: ${summary.providers.length}`,
  );
});

test("a category filter narrows the findings of a provider that spans several categories", async () => {
  const spanning = {
    id: "managers",
    version: 1,
    categories: ["package-cache", "log"],
    probe: async () => AVAILABLE,
    discover: async () => ({
      findings: [
        finding({ id: "managers:apt.clean", providerId: "managers", category: "package-cache", paths: [] }),
        finding({ id: "managers:journald.vacuum", providerId: "managers", category: "log", paths: [] }),
      ],
      warnings: [],
      complete: true,
    }),
  };
  const service = createFootprintService([spanning], environment(), measuring);
  const summary = await service.discover({ measureSizes: false, categories: ["log"] }, new AbortController().signal);
  assert.deepEqual(summary.findings.map((entry) => entry.id), ["managers:journald.vacuum"]);
  assert.deepEqual(summary.categoryTotals.map((total) => total.category), ["log"]);
});
