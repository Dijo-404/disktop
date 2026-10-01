import assert from "node:assert/strict";
import { test } from "node:test";
import {
  categoryTotals,
  deduplicateFindings,
  findingSize,
  orderFindings,
} from "../../dist/domain/findings.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";

const AVAILABLE = { status: "available", explanation: "The directory was read." };

function finding(overrides) {
  return {
    id: "test.provider:one",
    providerId: "test.provider",
    providerVersion: 1,
    category: "language-cache",
    title: "A cache",
    evidence: [],
    paths: [rawPathFromUtf8("/home/person/.cache/pip")],
    size: findingSize(1024n, "measured-allocated", "What the last scan measured."),
    confidence: "observed",
    capability: AVAILABLE,
    availableActionIds: [],
    active: false,
    ...overrides,
  };
}

test("a size carries a number only when something measured it", () => {
  assert.deepEqual(findingSize(10n, "stat", "One stat call."), {
    bytes: 10n,
    basis: "stat",
    explanation: "One stat call.",
  });
  assert.deepEqual(findingSize(undefined, "unknown", "No scan covers it."), {
    basis: "unknown",
    explanation: "No scan covers it.",
  });
});

test("an unlabelled or contradictory size is refused", () => {
  assert.throws(() => findingSize(10n, "unknown", "No scan covers it."), RangeError);
  assert.throws(() => findingSize(undefined, "measured-allocated", "Measured."), RangeError);
  assert.throws(() => findingSize(10n, "stat", "   "), RangeError);
});

test("a narrower finding under another provider's finding is dropped and named", () => {
  const broad = finding({
    id: "cache.language:pip",
    providerId: "cache.language",
    paths: [rawPathFromUtf8("/home/person/.cache")],
  });
  const narrow = finding({
    id: "cache.electron:slack",
    providerId: "cache.electron",
    paths: [rawPathFromUtf8("/home/person/.cache/slack")],
  });

  const { kept, dropped } = deduplicateFindings([broad, narrow]);

  assert.deepEqual(
    kept.map((entry) => entry.id),
    ["cache.language:pip"],
  );
  assert.deepEqual(dropped, [{ id: "cache.electron:slack", supersededBy: "cache.language:pip" }]);
  assert.ok(
    kept[0].evidence.some((line) => line.includes("cache.electron:slack")),
    `the survivor names what it absorbed: ${JSON.stringify(kept[0].evidence)}`,
  );
});

test("one provider may report a tree and its parts", () => {
  const parent = finding({ id: "dev.conda:root", paths: [rawPathFromUtf8("/home/person/miniconda3")] });
  const child = finding({ id: "dev.conda:pkgs", paths: [rawPathFromUtf8("/home/person/miniconda3/pkgs")] });

  const { kept, dropped } = deduplicateFindings([parent, child]);

  assert.deepEqual(kept.map((entry) => entry.id).sort(), ["dev.conda:pkgs", "dev.conda:root"]);
  assert.deepEqual(dropped, []);
});

test("a repeated id survives once", () => {
  const first = finding({ id: "cache.ai:ollama", paths: [rawPathFromUtf8("/home/person/.ollama")] });
  const second = finding({
    id: "cache.ai:ollama",
    providerId: "cache.other",
    paths: [rawPathFromUtf8("/opt/ollama")],
  });

  const { kept, dropped } = deduplicateFindings([first, second]);

  assert.equal(kept.length, 1);
  assert.deepEqual(dropped, [{ id: "cache.ai:ollama", supersededBy: "cache.ai:ollama" }]);
});

test("a finding with no path is never dropped as an overlap", () => {
  const scoped = finding({
    id: "apps.installed:flatpak",
    paths: [],
    managerScope: "flatpak uninstall --unused",
    size: findingSize(2048n, "manager-reported", "Flatpak's own number."),
  });
  const broad = finding({ id: "cache.language:all", paths: [rawPathFromUtf8("/")] });

  const { kept } = deduplicateFindings([broad, scoped]);

  assert.deepEqual(kept.map((entry) => entry.id).sort(), ["apps.installed:flatpak", "cache.language:all"]);
});

test("the largest known size ranks first and every unknown size ranks last", () => {
  const small = finding({ id: "a:small", size: findingSize(10n, "stat", "One stat call.") });
  const large = finding({ id: "a:large", size: findingSize(4096n, "stat", "One stat call.") });
  const unsized = finding({ id: "a:unsized", size: findingSize(undefined, "unknown", "Not measured.") });
  const alsoUnsized = finding({ id: "a:also", size: findingSize(undefined, "unknown", "Not measured.") });

  const order = orderFindings([unsized, small, alsoUnsized, large]).map((entry) => entry.id);

  assert.deepEqual(order, ["a:large", "a:small", "a:also", "a:unsized"]);
});

test("category totals add only what was measured and count what was not", () => {
  const totals = categoryTotals([
    finding({ id: "a:1", category: "language-cache", size: findingSize(1000n, "stat", "One stat call.") }),
    finding({ id: "a:2", category: "language-cache", size: findingSize(undefined, "unknown", "Not measured.") }),
    finding({ id: "a:3", category: "game-data", size: findingSize(50n, "manager-reported", "Steam's number.") }),
  ]);

  assert.deepEqual(totals, [
    { category: "language-cache", findings: 2, bytes: 1000n, unmeasured: 1, nested: 0 },
    { category: "game-data", findings: 1, bytes: 50n, unmeasured: 0, nested: 0 },
  ]);
});

test("a subtree reported beside its parent is not added to the parent's category total", () => {
  // One provider may describe a tree and its parts: the browser detector
  // reports a profile and the caches inside it. Adding both into a total tells
  // the reader the category holds more bytes than the filesystem does.
  const profile = finding({
    id: "cache.browser:profile",
    providerId: "cache.browser",
    category: "browser-cache",
    paths: [rawPathFromUtf8("/home/person/.config/google-chrome/Default")],
    size: findingSize(51_793_920n, "measured-allocated", "Measured."),
  });
  const inside = finding({
    id: "cache.browser:service-worker",
    providerId: "cache.browser",
    category: "browser-cache",
    paths: [rawPathFromUtf8("/home/person/.config/google-chrome/Default/Service Worker")],
    size: findingSize(35_192_832n, "measured-allocated", "Measured."),
  });

  const totals = categoryTotals([profile, inside]);

  assert.deepEqual(totals, [
    { category: "browser-cache", findings: 2, bytes: 51_793_920n, unmeasured: 0, nested: 1 },
  ]);
});

test("two findings over unrelated paths both count", () => {
  const first = finding({ id: "a:1", paths: [rawPathFromUtf8("/home/person/.npm")], size: findingSize(10n, "stat", "One stat call.") });
  const second = finding({ id: "a:2", paths: [rawPathFromUtf8("/home/person/.cargo")], size: findingSize(20n, "stat", "One stat call.") });

  assert.deepEqual(categoryTotals([first, second]), [
    { category: "language-cache", findings: 2, bytes: 30n, unmeasured: 0, nested: 0 },
  ]);
});

test("a finding with no path is never treated as nested", () => {
  const broad = finding({ id: "a:1", paths: [rawPathFromUtf8("/")], size: findingSize(10n, "stat", "One stat call.") });
  const scoped = finding({ id: "a:2", paths: [], size: findingSize(20n, "manager-reported", "Flatpak's number.") });

  assert.deepEqual(categoryTotals([broad, scoped]), [
    { category: "language-cache", findings: 2, bytes: 30n, unmeasured: 0, nested: 0 },
  ]);
});
