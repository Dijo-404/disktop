import assert from "node:assert/strict";
import { test } from "node:test";
import { categoryTotals } from "../../dist/domain/findings.js";
import { isWithin, pathBytes, rawPathFromUtf8 } from "../../dist/domain/paths.js";

/** The definition categoryTotals has always had, written out the slow, obvious way. */
function referenceTotals(findings) {
  const inside = (entry) =>
    entry.paths.length > 0 &&
    entry.paths.every((path) =>
      findings.some(
        (other) =>
          other.id !== entry.id &&
          other.paths.some((owned) => owned.bytesBase64 !== path.bytesBase64 && isWithin(pathBytes(owned), pathBytes(path))),
      ),
    );
  const totals = new Map();
  for (const entry of findings) {
    const current = totals.get(entry.category) ?? { findings: 0, bytes: 0n, unmeasured: 0, nested: 0 };
    const nested = inside(entry);
    totals.set(entry.category, {
      findings: current.findings + 1,
      bytes: current.bytes + (nested ? 0n : entry.size.bytes ?? 0n),
      unmeasured: current.unmeasured + (entry.size.bytes === undefined ? 1 : 0),
      nested: current.nested + (nested ? 1 : 0),
    });
  }
  return [...totals].map(([category, total]) => ({ category, ...total }));
}

let seed = 7;
function random(limit) {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
  return seed % limit;
}

function finding(id, paths, category, bytes) {
  return {
    id,
    category,
    paths: paths.map(rawPathFromUtf8),
    size: bytes === undefined ? { basis: "unknown", explanation: "x" } : { bytes, basis: "measured-allocated", explanation: "x" },
  };
}

test("category totals count a finding nested inside another exactly as before, on random trees", () => {
  const names = ["a", "b", "c", "cache", "node_modules", "é", "日本"];
  for (let round = 0; round < 200; round += 1) {
    const findings = [];
    const count = 1 + random(12);
    for (let index = 0; index < count; index += 1) {
      const paths = [];
      for (let path = 0; path < random(3); path += 1) {
        const depth = random(4);
        paths.push(depth === 0 && random(5) === 0 ? "/" : `/${Array.from({ length: depth + 1 }, () => names[random(names.length)]).join("/")}`);
      }
      const category = ["log", "temporary", "app-cache"][random(3)];
      findings.push(finding(`f${random(4) === 0 ? 0 : index}`, paths, category, random(4) === 0 ? undefined : BigInt(random(1000))));
    }
    assert.deepEqual(categoryTotals(findings), referenceTotals(findings), JSON.stringify(findings.map((f) => [f.id, f.paths.map((p) => p.display)])));
  }
});

test("category totals stay fast at the most findings discovery can return", () => {
  const findings = Array.from({ length: 1250 }, (_, index) =>
    finding(`p:${index}`, [`/home/u/project-${index % 300}/item-${index}`, `/home/u/project-${index % 300}`], "app-cache", BigInt(index)),
  );
  // Concurrent test files can deschedule this process, and a cold call can
  // coincide with V8's background compilation or garbage collection. Measure
  // the same CPU budget over warm samples; the isolated performance suite also
  // enforces the wall-clock limit and rejects quadratic scaling.
  for (let index = 0; index < 10; index += 1) categoryTotals(findings);
  const samples = [];
  for (let index = 0; index < 31; index += 1) {
    const started = process.cpuUsage();
    const totals = categoryTotals(findings);
    const usage = process.cpuUsage(started);
    samples.push((usage.user + usage.system) / 1000);
    assert.deepEqual(totals, [{ category: "app-cache", findings: 1250, bytes: 780625n, unmeasured: 0, nested: 0 }]);
  }
  const elapsed = samples.sort((left, right) => left - right)[15];
  assert.ok(elapsed < 50, `categoryTotals used ${elapsed.toFixed(1)} ms median CPU for 1250 findings`);
});
