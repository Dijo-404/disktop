/**
 * Phase 7's export gate, run against the real helper on a real tree of
 * hostile names: scan it, export it as JSON, CSV, and HTML, and prove every
 * name came through exact where it has to be exact and inert where it has to
 * be inert. Disktop's own XDG locations point at a throwaway home, and the
 * reports are written to a throwaway directory.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHostileNameFixture } from "../fixtures/generate.mjs";
import { csvRows } from "../support/csv.mjs";
import { compileBundle } from "../support/schemas.mjs";

const validators = compileBundle("schemas/cli/v1");
let home;
let output;
let fixture;

before(async () => {
  home = await mkdtemp(join(tmpdir(), "disktop-home-"));
  output = await mkdtemp(join(tmpdir(), "disktop-reports-"));
  fixture = await createHostileNameFixture();
});

after(async () => {
  await fixture?.cleanup();
  await rm(home, { recursive: true, force: true });
  await rm(output, { recursive: true, force: true });
});

function disktop(args) {
  const result = spawnSync(process.execPath, ["dist/bin/disktop.js", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      NO_COLOR: "1",
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_STATE_HOME: join(home, "state"),
    },
  });
  assert.equal(result.error, undefined);
  return result;
}

function validated(schema, document) {
  const validate = validators.get(schema);
  assert.ok(validate(document), `${schema}: ${JSON.stringify(validate.errors)}`);
  return document;
}

/** Write one report to a new file and check what the envelope says about it. */
async function exportReport(format) {
  const target = join(output, `report.${format}`);
  const result = disktop(["report", "--format", format, "--path", fixture.root, "--output", target, "--json"]);
  assert.notEqual(result.stdout.trim(), "", `no stdout; stderr was: ${result.stderr}`);
  const envelope = validated("report", JSON.parse(result.stdout));
  // The capacity half reads this host, where a mount it may not stat makes
  // the report honestly incomplete; the scan half reads only the sandbox.
  assert.ok([0, 3].includes(result.status), `exit ${result.status}: ${result.stderr}`);
  assert.equal(result.status, envelope.exitCode);
  assert.deepEqual(envelope.data.sections, ["capacity", "scan"]);
  assert.equal(envelope.data.format, format);
  assert.equal(Buffer.from(envelope.data.output.bytesBase64, "base64").toString(), target);
  const bytes = await readFile(target);
  assert.equal(envelope.data.bytesWritten, String(bytes.length));
  assert.equal((await stat(target)).mode & 0o077, 0, "a report starts out private to its owner");
  return bytes.toString("utf8");
}

test("the hostile tree scans completely", () => {
  const result = disktop(["scan", fixture.root, "--json"]);
  const envelope = validated("scan", JSON.parse(result.stdout));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(envelope.data.completeness.complete, true);
});

test("the JSON report validates and carries every hostile name's exact bytes", async () => {
  const document = validated("report-document", JSON.parse(await exportReport("json")));
  assert.equal(document.scan.complete, true);
  const items = document.scan.entries.items;
  const listed = items.map((item) => Buffer.from(item.path.bytesBase64, "base64"));
  for (const entry of fixture.manifest) {
    assert.ok(
      listed.some((bytes) => bytes.equals(entry.bytes)),
      `${entry.name} is not in the report byte for byte`,
    );
  }
  for (const item of items) {
    assert.doesNotMatch(item.path.display, /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/);
  }
  const sizes = items.map((item) => BigInt(item.allocatedBytes));
  assert.deepEqual(sizes, [...sizes].sort((left, right) => (left < right ? 1 : left > right ? -1 : 0)), "largest first");
  assert.ok(document.scan.typeTotals.some((total) => total.extension === "=1+1"));
});

test("the CSV report parses, neutralises every formula, and round-trips every name", async () => {
  const { rows, raw } = csvRows(await exportReport("csv"));
  for (const cells of raw) {
    for (const cell of cells) {
      assert.doesNotMatch(cell, /^[=+\-@\t\r]/, `a cell a spreadsheet would evaluate: ${JSON.stringify(cell)}`);
      assert.doesNotMatch(cell, /[\u0000-\u001F\u007F-\u009F]/);
    }
  }
  const decoded = rows.filter((row) => row.section === "entry").map((row) => Buffer.from(row.path_bytes_base64, "base64"));
  for (const entry of fixture.manifest) {
    assert.ok(decoded.some((bytes) => bytes.equals(entry.bytes)), `${entry.name} is missing from the CSV`);
  }
  const extension = rows.find((row) => row.section === "type-total" && row.id === "'=1+1");
  assert.ok(extension, "the extension '=1+1' is in the CSV as text");
  assert.equal(rows.find((row) => row.section === "report" && row.id === "scan").status, "complete");
});

test("the HTML report runs nothing, loads nothing, and shows every name escaped", async () => {
  const html = await exportReport("html");
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`));
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /\s(src|href|on[a-z]+)\s*=/i);
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("=cmd|&#39; /C calc&#39;!A0"));
  assert.ok(html.includes("&lt;b&gt;=HYPERLINK(&quot;x&quot;)/inner &lt;i&gt;&amp;amp;&lt;i&gt;.log"));
  assert.ok(html.includes("invoice&lt;U+202E&gt;txt.exe"));
  assert.ok(html.includes("l".repeat(255)));
  assert.doesNotMatch(html, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/);
});

test("an existing file is refused and left alone, and nothing is staged beside it", async () => {
  const target = join(output, "taken.html");
  await writeFile(target, "keep me");
  const result = disktop(["report", "--format", "html", "--path", fixture.root, "--output", target, "--json"]);
  assert.equal(result.status, 2);
  const envelope = validated("report", JSON.parse(result.stdout));
  validated("error", envelope);
  assert.match(envelope.error.message, /already exists\. Disktop never replaces a file with a report/);
  assert.equal(await readFile(target, "utf8"), "keep me");
  assert.deepEqual((await readdir(output)).filter((name) => name.startsWith(".disktop-report-")), []);
});

test("--findings adds what this host's detectors found, short answers and all", () => {
  const result = disktop(["report", "--format", "json", "--findings"]);
  assert.ok([0, 3].includes(result.status), `exit ${result.status}: ${result.stderr}`);
  const document = validated("report-document", JSON.parse(result.stdout));
  assert.deepEqual(document.sections, ["capacity", "findings"]);
  const { findings } = document;
  assert.ok(findings.providers.length > 0, "every detector is listed, including the ones that could not look");
  for (const finding of findings.findings) {
    assert.equal(finding.size.basis === "unknown", finding.size.bytes === undefined, `${finding.id} hides an unknown size`);
  }
  // A short section says why, and makes the whole report short.
  if (!findings.complete) {
    assert.ok(findings.warnings.length > 0);
    assert.equal(document.status, "incomplete");
    assert.equal(result.status, 3);
  }
});

test("without --output the report is stdout's whole content", () => {
  const result = disktop(["report", "--format", "csv", "--path", fixture.root]);
  assert.ok([0, 3].includes(result.status), result.stderr);
  const { header, rows } = csvRows(result.stdout);
  assert.equal(header[0], "section");
  assert.ok(rows.some((row) => row.section === "entry"));
});
