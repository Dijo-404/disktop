import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runCli } from "../../dist/cli/run.js";
import { createReportFiles } from "../../dist/storage/report-files.js";
import { compileBundle } from "../support/schemas.mjs";
import { FIXTURE_VIEW, fakeContext } from "../support/cli-context.mjs";
import { footprintSummary } from "../support/report-fixture.mjs";

const validators = compileBundle("schemas/cli/v1");
const scratch = await mkdtemp(join(tmpdir(), "disktop-cli-report-"));
after(() => rm(scratch, { recursive: true, force: true }));

function validated(schema, document) {
  const validate = validators.get(schema);
  assert.ok(validate(document), `${schema}: ${JSON.stringify(validate.errors)}`);
  return document;
}

function envelopeOf(context) {
  return validated("report", JSON.parse(context.captured.stdout));
}

/** A context whose detectors answer, and count how often they were asked. */
function withFindings(summary = footprintSummary(), overrides = {}) {
  const context = fakeContext(overrides);
  context.discovered = 0;
  context.footprint = {
    async discover() {
      context.discovered += 1;
      return summary;
    },
  };
  return context;
}

test("without --output the report is all of stdout, in each format", async () => {
  const json = fakeContext();
  assert.equal(await runCli(["report", "--format", "json"], json), 0);
  const document = validated("report-document", JSON.parse(json.captured.stdout));
  assert.deepEqual(document.sections, ["capacity"]);
  assert.equal(document.generator.version, "1.2.3");
  assert.equal(json.captured.stderr, "");
  assert.equal(json.written.length, 0, "nothing is written to a file");

  const csv = fakeContext();
  assert.equal(await runCli(["report", "--format", "csv"], csv), 0);
  assert.ok(csv.captured.stdout.startsWith("section,id,kind,path_display,path_bytes_base64,"));
  assert.ok(csv.captured.stdout.endsWith("\r\n"));

  const html = fakeContext();
  assert.equal(await runCli(["report", "--format", "html", "--units", "si"], html), 0);
  assert.ok(html.captured.stdout.startsWith("<!DOCTYPE html>"));
  assert.match(html.captured.stdout, / TB</, "--units reaches the HTML");
});

test("--path includes the stored scan and --findings what the detectors found", async () => {
  const context = withFindings();
  assert.equal(await runCli(["report", "--format", "json", "--path", "/home/example/projects", "--findings", "--limit", "5"], context), 0);
  const document = validated("report-document", JSON.parse(context.captured.stdout));
  assert.deepEqual(document.sections, ["capacity", "scan", "findings"]);
  assert.equal(document.scan.entries.limit, 5);
  assert.equal(document.findings.findings.length, 2);
  assert.equal(context.discovered, 1);

  // The working directory is never assumed: without --path there is no scan.
  const plain = withFindings();
  await runCli(["report", "--format", "json"], plain);
  assert.equal(JSON.parse(plain.captured.stdout).scan.included, false);
  assert.equal(plain.discovered, 0);
});

test("a section short of what it covers exits 3 and says why on stderr, never in the report stream", async () => {
  const denied = { code: "provider-denied", message: "diagnostic.open-deleted was denied." };
  const context = withFindings(footprintSummary({ complete: false, warnings: [denied] }));
  assert.equal(await runCli(["report", "--format", "csv", "--findings"], context), 3);
  assert.match(context.captured.stderr, /warning: provider-denied: diagnostic\.open-deleted was denied\./);
  assert.match(context.captured.stdout, /\r\nreport,status,.*,incomplete,\r\n/);

  const inventory = fakeContext({ view: { ...FIXTURE_VIEW, complete: false, warnings: [{ code: "statfs-unreadable", message: "One mount could not be measured." }] } });
  assert.equal(await runCli(["report", "--format", "html"], inventory), 3);
});

test("--json writes the envelope to stdout and the report to --output", async () => {
  const context = withFindings();
  const status = await runCli(["report", "--format", "html", "--output", "/home/example/report.html", "--findings", "--json"], context);
  assert.equal(status, 0);
  const envelope = envelopeOf(context);
  assert.equal(envelope.status, "complete");
  assert.equal(envelope.data.format, "html");
  assert.equal(envelope.data.output.display, "/home/example/report.html");
  assert.equal(Buffer.from(envelope.data.output.bytesBase64, "base64").toString(), "/home/example/report.html");
  assert.deepEqual(envelope.data.sections, ["capacity", "findings"]);
  const [file] = context.written;
  assert.ok(file.text.startsWith("<!DOCTYPE html>"));
  assert.equal(envelope.data.bytesWritten, String(Buffer.byteLength(file.text)));
});

test("--json without --output is refused as ambiguous, in the envelope shape", async () => {
  const context = withFindings();
  assert.equal(await runCli(["report", "--format", "json", "--findings", "--json"], context), 2);
  const envelope = envelopeOf(context);
  validated("error", envelope);
  assert.equal(envelope.error.code, "invalid-input");
  assert.match(envelope.error.message, /needs --output FILE/);
  assert.equal(context.discovered, 0, "nothing ran before the refusal");
});

test("a missing format, a bad limit, and a path no scan covers are input errors", async () => {
  const missing = fakeContext();
  assert.equal(await runCli(["report"], missing), 2);
  assert.match(missing.captured.stderr, /needs --format json, csv, or html/);
  assert.equal(missing.captured.stdout, "");

  assert.equal((await runCli(["report", "--format", "pdf"], fakeContext())), 2, "the parser refuses an unknown format");

  for (const limit of ["0", "1001", "ten", "-5", "1e3"]) {
    const context = fakeContext();
    assert.equal(await runCli(["report", "--format", "json", "--limit", limit], context), 2, limit);
  }

  const uncovered = fakeContext();
  assert.equal(await runCli(["report", "--format", "json", "--path", "/srv/data", "--output", "/tmp/x.json", "--json"], uncovered), 2);
  assert.match(envelopeOf(uncovered).error.message, /Run 'disktop scan \/srv\/data' first/);
  assert.equal(uncovered.written.length, 0);
});

test("an existing output file is refused before any work, and is left as it was", async () => {
  const target = join(scratch, "existing.html");
  await writeFile(target, "keep");
  // Asking for findings proves the refusal comes before the detectors run.
  const context = withFindings(footprintSummary(), { reportFiles: createReportFiles() });
  const status = await runCli(["report", "--format", "html", "--output", target, "--findings", "--json"], context);
  assert.equal(status, 2);
  const envelope = envelopeOf(context);
  assert.equal(envelope.error.code, "invalid-input");
  assert.match(envelope.error.message, /existing\.html already exists\. Disktop never replaces a file with a report: name a new file, or move the old one away first\./);
  assert.equal(await readFile(target, "utf8"), "keep");
  assert.equal(context.discovered, 0);

  const text = fakeContext({ reportFiles: createReportFiles() });
  assert.equal(await runCli(["report", "--format", "csv", "--output", target], text), 2);
  assert.equal(text.captured.stdout, "");
  assert.match(text.captured.stderr, /already exists/);
});

test("--output writes a new file for real, and says so on stdout in text mode", async () => {
  const target = join(scratch, "fresh.csv");
  const context = fakeContext({ reportFiles: createReportFiles() });
  assert.equal(await runCli(["report", "--format", "csv", "--output", target], context), 0);
  const text = await readFile(target, "utf8");
  assert.ok(text.startsWith("section,id,"));
  assert.equal(context.captured.stdout, `Wrote the CSV report to ${target} (${Buffer.byteLength(text)} bytes, complete).\n`);
  assert.deepEqual((await readdir(scratch)).filter((name) => name.includes("partial")), []);
});

test("Ctrl+C while gathering writes nothing and exits 130", async () => {
  const context = fakeContext();
  let interrupt;
  context.signals = {
    listen(handler) {
      interrupt = handler;
    },
    stop() {},
  };
  context.footprint = {
    async discover() {
      interrupt();
      return footprintSummary({ complete: false, warnings: [{ code: "cancelled", message: "Discovery was cancelled." }] });
    },
  };
  const status = await runCli(["report", "--format", "json", "--findings", "--output", "/home/example/r.json", "--json"], context);
  assert.equal(status, 130);
  const envelope = envelopeOf(context);
  assert.equal(envelope.status, "error");
  assert.equal(envelope.exitCode, 130);
  assert.equal(envelope.error.code, "cancelled");
  assert.equal(context.written.length, 0);
});

test("as root the report goes to stdout only", async () => {
  const context = fakeContext({ effectiveUserId: 0 });
  assert.equal(await runCli(["report", "--format", "json", "--output", "/root/report.json"], context), 2);
  assert.match(context.captured.stderr, /Run as root, Disktop writes no file itself/);
  assert.equal(context.written.length, 0);

  const stdout = fakeContext({ effectiveUserId: 0 });
  assert.equal(await runCli(["report", "--format", "json"], stdout), 0);
});
