/** Measure aggregation wall time separately from concurrent unit-test workers. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("category aggregation stays responsive and scales below the former quadratic implementation", { timeout: 60_000 }, (context) => {
  const moduleUrl = (relative) => JSON.stringify(new URL(relative, import.meta.url).href);
  const script = `
    import assert from "node:assert/strict";
    import { categoryTotals } from ${moduleUrl("../../dist/domain/findings.js")};
    import { isWithin, pathBytes, rawPathFromUtf8 } from ${moduleUrl("../../dist/domain/paths.js")};

    function finding(id, paths, category, bytes) {
      return { id, category, paths: paths.map(rawPathFromUtf8),
        size: bytes === undefined ? { basis: "unknown", explanation: "unmeasured fixture" }
          : { bytes, basis: "measured-allocated", explanation: "measured fixture" } };
    }
    function fixture(groups) {
      return Array.from({ length: groups }, (_, index) => {
        const directory = "/home/u/project-" + index;
        return [
          finding("parent:" + index, [directory], "app-cache", 10000n),
          finding("cache:" + index, [directory + "/cache-a", directory + "/cache-b"], "app-cache", 1000n),
          finding("unknown:" + index, [directory + "/logs"], "log", undefined),
          finding("loose:" + index, ["/home/u/unowned-project-" + index + "/one"], "temporary", 500n),
          finding("mixed:" + index, [directory + "/cache-a/child", "/home/u/loose-project-" + index], "log", 42n),
        ];
      }).flat();
    }
    function expected(groups) {
      return [
        { category: "app-cache", findings: groups * 2, bytes: BigInt(groups) * 10000n, unmeasured: 0, nested: groups },
        { category: "log", findings: groups * 2, bytes: BigInt(groups) * 42n, unmeasured: groups, nested: groups },
        { category: "temporary", findings: groups, bytes: BigInt(groups) * 500n, unmeasured: 0, nested: 0 },
      ];
    }
    // The previous implementation is deliberately kept as the slow reference.
    // An accidental return to its all-pairs search must fail even on a machine
    // where an absolute latency budget alone might conceal the regression.
    function referenceTotals(findings) {
      const inside = (entry) => entry.paths.length > 0 && entry.paths.every((path) =>
        findings.some((other) => other.id !== entry.id && other.paths.some((owned) =>
          owned.bytesBase64 !== path.bytesBase64 && isWithin(pathBytes(owned), pathBytes(path)))));
      const totals = new Map();
      for (const entry of findings) {
        const current = totals.get(entry.category) ?? { findings: 0, bytes: 0n, unmeasured: 0, nested: 0 };
        const nested = inside(entry);
        totals.set(entry.category, { findings: current.findings + 1,
          bytes: current.bytes + (nested ? 0n : entry.size.bytes ?? 0n),
          unmeasured: current.unmeasured + (entry.size.bytes === undefined ? 1 : 0),
          nested: current.nested + (nested ? 1 : 0) });
      }
      return [...totals].map(([category, total]) => ({ category, ...total }));
    }
    const small = fixture(50);
    const large = fixture(250);
    const smallExpected = expected(50);
    const largeExpected = expected(250);
    assert.equal(large.length, 1250);
    assert.deepEqual(referenceTotals(small), smallExpected);
    assert.deepEqual(referenceTotals(large), largeExpected);
    function sample(aggregate, input, expectedResult) {
      const started = performance.now();
      const result = aggregate(input);
      const elapsed = performance.now() - started;
      // Correctness checks are outside the timed region, but verify every
      // result: dropping nested/unmeasured work cannot buy a passing budget.
      assert.deepEqual(result, expectedResult);
      return elapsed;
    }
    for (let index = 0; index < 30; index += 1) {
      categoryTotals(small);
      categoryTotals(large);
    }
    for (let index = 0; index < 5; index += 1) referenceTotals(fixture(10));
    const readings = { small: [], large: [], referenceSmall: [], referenceLarge: [] };
    // Alternate sizes and their order. Fifty-one samples make a single GC or
    // scheduler pause an outlier, while retaining a per-call wall-time budget.
    for (let index = 0; index < 51; index += 1) {
      if (index % 2 === 0) {
        readings.small.push(sample(categoryTotals, small, smallExpected));
        readings.large.push(sample(categoryTotals, large, largeExpected));
      } else {
        readings.large.push(sample(categoryTotals, large, largeExpected));
        readings.small.push(sample(categoryTotals, small, smallExpected));
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (let index = 0; index < 3; index += 1) {
      readings.referenceSmall.push(sample(referenceTotals, small, smallExpected));
      readings.referenceLarge.push(sample(referenceTotals, large, largeExpected));
    }
    const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
    process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(readings).map(([name, values]) => [name, median(values)]))));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 55_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const reading = JSON.parse(result.stdout);
  assert.ok(reading.large < 50, `1250 findings took ${reading.large.toFixed(2)} ms median wall time (budget 50 ms)`);
  const growth = reading.large / reading.small;
  assert.ok(growth < 9, `5× as many findings increased median aggregation time by ${growth.toFixed(2)}× (quadratic growth is 25×)`);
  assert.ok(reading.large < reading.referenceLarge / 4,
    `aggregation took ${reading.large.toFixed(2)} ms versus the quadratic reference's ${reading.referenceLarge.toFixed(2)} ms; expected at least 4× faster`);
  context.diagnostic(`51 warm samples: 250 findings ${reading.small.toFixed(2)} ms, 1250 findings ${reading.large.toFixed(2)} ms; ${growth.toFixed(2)}× growth for 5× inputs; quadratic reference ${reading.referenceLarge.toFixed(2)} ms`);
});
