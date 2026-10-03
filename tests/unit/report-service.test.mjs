import assert from "node:assert/strict";
import { test } from "node:test";
import { createReportService, includedSections, reportWarnings } from "../../dist/application/report.js";
import { CapabilityUnavailable, StaleScanIndex } from "../../dist/domain/errors.js";
import { FIXTURE_ENTRY, FIXTURE_SNAPSHOT, FIXTURE_VIEW, memoryReportFiles, rawPath } from "../support/cli-context.mjs";
import { footprintSummary } from "../support/report-fixture.mjs";

const NOW = new Date("2026-09-29T08:15:04.117Z");

function service(overrides = {}) {
  const asked = { explore: [], discover: [], written: [] };
  const report = createReportService({
    dashboard: {
      async dashboard() {
        throw new Error("a report reads the inventory, which includes devices");
      },
      async inventory() {
        return overrides.view ?? FIXTURE_VIEW;
      },
    },
    snapshots: {
      async list() {
        return overrides.snapshots ?? [FIXTURE_SNAPSHOT];
      },
    },
    explore: {
      async page(request) {
        asked.explore.push(request);
        if (overrides.explore !== undefined) {
          return overrides.explore(request);
        }
        return { kind: "page", page: { entries: [FIXTURE_ENTRY], nextCursor: "next", typeTotals: [] } };
      },
    },
    footprint: {
      async discover(request, signal) {
        asked.discover.push(request);
        overrides.onDiscover?.(signal);
        return overrides.summary ?? footprintSummary();
      },
    },
    files: overrides.files ?? memoryReportFiles(asked.written),
    effectiveUserId: overrides.effectiveUserId ?? 1000,
  });
  return { report, asked };
}

const request = (overrides = {}) => ({ limit: 50, findings: false, generatedAt: NOW, version: "1.2.3", ...overrides });

test("without a path or --findings, a report is the capacity view and says what it left out", async () => {
  const { report, asked } = service();
  const outcome = await report.gather(request(), new AbortController().signal);
  assert.equal(outcome.kind, "report");
  assert.equal(outcome.report.complete, true);
  assert.deepEqual(includedSections(outcome.report), ["capacity"]);
  assert.equal(outcome.report.capacity.devices.length, FIXTURE_VIEW.devices.length);
  assert.match(outcome.report.scan.reason, /--path PATH/);
  assert.match(outcome.report.findings.reason, /--findings/);
  assert.equal(asked.explore.length, 0);
  assert.equal(asked.discover.length, 0, "no detector runs unless asked");
});

test("a path selects the newest scan covering it and lists the largest entries under it", async () => {
  const { report, asked } = service();
  const subject = rawPath("/home/example/projects/node_modules");
  const outcome = await report.gather(request({ subject, limit: 7 }), new AbortController().signal);
  assert.equal(outcome.kind, "report");
  const { scan } = outcome.report;
  assert.equal(scan.included, true);
  assert.equal(scan.complete, true);
  assert.equal(scan.snapshot.id, FIXTURE_SNAPSHOT.id);
  assert.deepEqual(scan.subject, subject);
  assert.equal(scan.largest.limit, 7);
  assert.equal(scan.largest.more, true, "a cursor means more entries exist");
  assert.deepEqual(scan.typeTotals, []);

  const [query] = asked.explore;
  assert.equal(query.scanId, FIXTURE_SNAPSHOT.scanId);
  assert.deepEqual(query.filter, { underPath: subject }, "entries are narrowed to the path, not the whole scan");
  assert.equal(query.sort, "allocated");
  assert.equal(query.order, "descending");
  assert.equal(query.limit, 7);
  assert.equal(query.includeTypeTotals, true);
});

test("a path no stored scan covers is refused with the command that would cover it", async () => {
  const { report } = service();
  const outcome = await report.gather(request({ subject: rawPath("/srv/data") }), new AbortController().signal);
  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "invalid-input");
  assert.match(outcome.failure.message, /No stored scan covers \/srv\/data\. Run 'disktop scan \/srv\/data' first/);

  // A sibling sharing a prefix is not covered: /home/example/projects-old.
  const sibling = await report.gather(request({ subject: rawPath("/home/example/projects-old") }), new AbortController().signal);
  assert.equal(sibling.kind, "refused");
});

test("a partial scan makes its section incomplete and carries the scan's own warnings", async () => {
  const warning = { code: "inaccessible-directory", message: "Permission denied.", path: rawPath("/home/example/projects/private") };
  const partial = { ...FIXTURE_SNAPSHOT, completeness: { ...FIXTURE_SNAPSHOT.completeness, complete: false, inaccessibleDirectories: 1n, warnings: [warning] } };
  const { report } = service({ snapshots: [partial] });
  const outcome = await report.gather(request({ subject: rawPath("/home/example/projects") }), new AbortController().signal);
  assert.equal(outcome.report.complete, false);
  assert.equal(outcome.report.scan.complete, false);
  assert.deepEqual(outcome.report.scan.warnings, [warning]);
  assert.deepEqual(reportWarnings(outcome.report), [warning]);
});

test("an index that cannot answer leaves the summary in and says what is missing", async () => {
  const subject = rawPath("/home/example/projects");
  const cases = [
    () => ({ kind: "unavailable", capability: { status: "missing-tool", explanation: "The helper binary is missing." } }),
    () => {
      throw new CapabilityUnavailable({ status: "unsupported-kernel", explanation: "openat2 is not available." });
    },
    () => {
      throw new StaleScanIndex(FIXTURE_SNAPSHOT.scanId, "unknown scan");
    },
  ];
  for (const explore of cases) {
    const { report } = service({ explore });
    const outcome = await report.gather(request({ subject }), new AbortController().signal);
    assert.equal(outcome.kind, "report");
    const { scan } = outcome.report;
    assert.equal(scan.complete, false);
    assert.equal(outcome.report.complete, false);
    assert.equal(scan.largest, undefined, "no listing rather than an empty one");
    assert.equal(scan.typeTotals, undefined);
    assert.equal(scan.snapshot.totals.allocatedBytes, FIXTURE_SNAPSHOT.totals.allocatedBytes, "the summary survives");
    assert.equal(scan.warnings.at(-1).code, "index-unavailable");
  }

  const { report } = service({
    explore() {
      throw new StaleScanIndex(FIXTURE_SNAPSHOT.scanId, "unknown scan");
    },
  });
  const stale = await report.gather(request({ subject }), new AbortController().signal);
  assert.match(stale.report.scan.warnings.at(-1).message, /no longer holds scan .* Run 'disktop scan \/home\/example\/projects' again/);

  const { report: broken } = service({
    explore() {
      throw new Error("the helper crashed");
    },
  });
  await assert.rejects(broken.gather(request({ subject }), new AbortController().signal), /the helper crashed/);
});

test("--findings runs every detector with sizes measured, and its completeness counts", async () => {
  const { report, asked } = service();
  const outcome = await report.gather(request({ findings: true }), new AbortController().signal);
  assert.deepEqual(asked.discover, [{ measureSizes: true }]);
  assert.equal(outcome.report.findings.included, true);
  assert.equal(outcome.report.complete, true);
  assert.deepEqual(includedSections(outcome.report), ["capacity", "findings"]);

  const denied = { code: "provider-denied", message: "diagnostic.open-deleted was denied." };
  const { report: short } = service({ summary: footprintSummary({ complete: false, warnings: [denied] }) });
  const incomplete = await short.gather(request({ findings: true }), new AbortController().signal);
  assert.equal(incomplete.report.complete, false);
  assert.equal(incomplete.report.findings.complete, false);
  assert.deepEqual(reportWarnings(incomplete.report), [denied]);
});

test("an incomplete inventory makes the report incomplete", async () => {
  const warning = { code: "statfs-unreadable", message: "One mount could not be measured." };
  const { report } = service({ view: { ...FIXTURE_VIEW, complete: false, warnings: [warning] } });
  const outcome = await report.gather(request(), new AbortController().signal);
  assert.equal(outcome.report.complete, false);
  assert.deepEqual(reportWarnings(outcome.report), [warning]);
});

test("an interrupted report is refused as cancelled, so nothing half-done is written", async () => {
  const controller = new AbortController();
  const { report } = service({ onDiscover: () => controller.abort() });
  const outcome = await report.gather(request({ findings: true }), controller.signal);
  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "cancelled");
});

test("a limit outside 1 to 1000 is refused rather than clamped", async () => {
  const { report } = service();
  for (const limit of [0, 1001, 2.5, Number.NaN]) {
    const outcome = await report.gather(request({ limit }), new AbortController().signal);
    assert.equal(outcome.kind, "refused", String(limit));
    assert.equal(outcome.failure.code, "invalid-input");
  }
});

test("as root, a report is never written to a file, and the port is never asked", async () => {
  let asked = 0;
  const files = {
    async check() {
      asked += 1;
      return { kind: "clear" };
    },
    async createExclusive() {
      asked += 1;
      return { kind: "written", bytesWritten: 0n, warnings: [] };
    },
  };
  const { report } = service({ files, effectiveUserId: 0 });
  const target = rawPath("/root/report.html");
  for (const outcome of [await report.check(target), await report.publish(target, Buffer.from("x"))]) {
    assert.equal(outcome.kind, "refused");
    assert.equal(outcome.failure.code, "permission-denied");
    assert.match(outcome.failure.message, /redirect standard output/);
  }
  assert.equal(asked, 0);

  // Gathering is reading, and reading as root is allowed.
  const gathered = await report.gather(request(), new AbortController().signal);
  assert.equal(gathered.kind, "report");
});

test("as anybody else, publishing goes to the file port", async () => {
  const { report, asked } = service();
  const target = rawPath("/home/example/report.csv");
  assert.deepEqual(await report.check(target), { kind: "clear" });
  const outcome = await report.publish(target, Buffer.from("a,b\r\n"));
  assert.deepEqual(outcome, { kind: "written", bytesWritten: 5n, warnings: [] });
  assert.equal(asked.written[0].text, "a,b\r\n");
});
