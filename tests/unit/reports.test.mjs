import { rawPathFromUtf8 } from "../../dist/domain/paths.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { CSV_COLUMNS, csvCell, renderCsvReport } from "../../dist/reports/csv.js";
import { REPORT_CSP, escapeHtml, renderHtmlReport } from "../../dist/reports/html.js";
import { renderJsonReport } from "../../dist/reports/json.js";
import { compileBundle } from "../support/schemas.mjs";
import { HOSTILE_EXTENSIONS, HOSTILE_NAMES, HOSTILE_PATHS, hostileReport } from "../support/report-fixture.mjs";
import { FIXTURE_VIEW } from "../support/cli-context.mjs";
import { csvRows } from "../support/csv.mjs";

const validators = compileBundle("schemas/cli/v1");

/** Anything that can command a terminal or reorder text: C0, DEL, C1, and the bidi controls. */
const UNSAFE_CHARACTER = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/;

test("a CSV cell a spreadsheet would evaluate is shown as text instead", () => {
  assert.equal(csvCell("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0");
  assert.equal(csvCell("+1+1"), "'+1+1");
  assert.equal(csvCell("-2+3"), "'-2+3");
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  // Tab and carriage return become their Control Pictures before the check,
  // so the lead the spreadsheet would see is never there to begin with.
  assert.equal(csvCell("\t=1"), "␉=1");
  assert.equal(csvCell("\r=1"), "␍=1");
  // A cell that already starts with an apostrophe gains one more, so taking
  // exactly one away from any cell that has one gives the original back.
  assert.equal(csvCell("'=1"), "''=1");
  assert.equal(csvCell("'plain"), "''plain");
  assert.equal(csvCell("/home/example/=x"), "/home/example/=x", "only the first character matters");
  assert.equal(csvCell("9007199254740993"), "9007199254740993", "numbers stay numbers");
  assert.equal(csvCell(""), "");
});

test("a CSV cell is quoted only when it has to be, with its quotes doubled", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("=a,\"b\""), '"\'=a,""b"""', "neutralised and then quoted");
  assert.equal(csvCell("one\ntwo"), "one␊two", "a line break never reaches a record");
});

test("every CSV record has the documented columns and parses as RFC 4180", () => {
  const text = renderCsvReport(hostileReport());
  assert.ok(text.endsWith("\r\n"));
  assert.doesNotMatch(text.replace(/\r\n/g, ""), /[\r\n]/, "no line break outside a record end");
  const { header, raw } = csvRows(text);
  assert.deepEqual(header, [...CSV_COLUMNS]);
  for (const cells of raw) {
    assert.equal(cells.length, CSV_COLUMNS.length, `a record has ${cells.length} cells: ${JSON.stringify(cells)}`);
  }
});

test("no CSV cell can start a formula, and none carries a control character", () => {
  const { raw } = csvRows(renderCsvReport(hostileReport()));
  for (const cells of raw) {
    for (const cell of cells) {
      assert.doesNotMatch(cell, /^[=+\-@\t\r]/, `a cell a spreadsheet would evaluate: ${JSON.stringify(cell)}`);
      assert.doesNotMatch(cell, UNSAFE_CHARACTER, `a cell with a control character: ${JSON.stringify(cell)}`);
    }
  }
  const { rows } = csvRows(renderCsvReport(hostileReport()));
  const extensions = rows.filter((row) => row.section === "type-total").map((row) => row.id);
  assert.deepEqual(extensions, ["'=1+1", "'+1", "'-2+3", "'@sum(a1)", "''quoted", "log", ""]);
  // Undoing the documented rule gives every extension back exactly.
  assert.deepEqual(
    extensions.map((cell) => (cell.startsWith("'") ? cell.slice(1) : cell)),
    [...HOSTILE_EXTENSIONS, ""],
  );
  const finding = rows.find((row) => row.section === "finding" && row.id === "rules:formula");
  assert.ok(finding.detail.startsWith("'=HYPERLINK("), finding.detail);
});

test("every CSV path carries its exact bytes beside a display form that is safe to show", () => {
  const { rows } = csvRows(renderCsvReport(hostileReport()));
  const decoded = rows
    .filter((row) => row.path_bytes_base64 !== "")
    .map((row) => Buffer.from(row.path_bytes_base64, "base64"));
  for (const [name, path] of HOSTILE_PATHS) {
    const bytes = Buffer.from(path.bytesBase64, "base64");
    assert.ok(decoded.some((candidate) => candidate.equals(bytes)), `${name} did not survive the round trip`);
    assert.ok(bytes.subarray(-HOSTILE_NAMES.get(name).length).equals(HOSTILE_NAMES.get(name)));
  }
  const entry = rows.find((row) => row.section === "entry" && row.path_bytes_base64 === HOSTILE_PATHS.get("invalid-utf8").bytesBase64);
  assert.equal(entry.path_display, HOSTILE_PATHS.get("invalid-utf8").display);
  assert.match(entry.path_display, /�/);
  const long = rows.find((row) => row.path_bytes_base64 === HOSTILE_PATHS.get("long").bytesBase64);
  assert.ok(long.path_display.endsWith("l".repeat(255)), "a long name is kept whole");
});

test("CSV keeps byte counts exact and never writes an unknown size as zero", () => {
  const { rows } = csvRows(renderCsvReport(hostileReport()));
  const root = rows.find((row) => row.section === "entry" && row.path_display === "/home/example/projects");
  assert.equal(root.allocated_bytes, "9007199254740993");
  assert.equal(root.entries, "14");

  const unknown = rows.find((row) => row.section === "finding" && row.id === "rules:formula");
  assert.equal(unknown.size_bytes, "", "an unmeasured size is empty");
  assert.equal(unknown.size_basis, "unknown");
  const measured = rows.find((row) => row.section === "finding" && row.id === "cache.language:cargo-registry");
  assert.equal(measured.size_bytes, "9007199254740993");

  const sshfs = rows.find((row) => row.section === "filesystem" && row.id === "fs-0-99");
  assert.equal(sshfs.inodes_used_percent, "", "a filesystem reporting no inodes has no inode share");
  const root_fs = rows.find((row) => row.section === "filesystem" && row.id === "fs-259-2");
  assert.equal(root_fs.used_percent, "52");
  assert.equal(rows.filter((row) => row.section === "mount" && row.id === "fs-259-2").length, 1, "a second mount point has its own row");

  const shared = rows.find((row) => row.section === "entry" && row.id === "9400");
  assert.equal(shared.status, "shared-hardlink");
  assert.ok(rows.some((row) => row.section === "entry-limit"), "a ranking cut at its limit says so");
  assert.equal(rows.filter((row) => row.section === "finding-path" && row.id === "rules:formula").length, 2);
});

test("CSV says which sections are short and what they missed", () => {
  const report = hostileReport({
    complete: false,
    findings: {
      included: true,
      complete: false,
      warnings: [{ code: "provider-denied", message: "-lsof was denied" }],
      summary: hostileReport().findings.summary,
    },
    scan: { included: false, reason: "No --path was given." },
  });
  const { rows } = csvRows(renderCsvReport(report));
  assert.equal(rows.find((row) => row.section === "report" && row.id === "status").status, "incomplete");
  assert.equal(rows.find((row) => row.section === "report" && row.id === "findings").status, "incomplete");
  const omitted = rows.find((row) => row.section === "report" && row.id === "scan");
  assert.equal(omitted.status, "omitted");
  assert.equal(omitted.detail, "No --path was given.");
  const warning = rows.find((row) => row.section === "warning");
  assert.deepEqual([warning.id, warning.kind, warning.detail], ["provider-denied", "findings", "'-lsof was denied"]);
  assert.ok(!rows.some((row) => row.section === "entry"), "an omitted scan lists no entries");
});

test("HTML escapes every name, in text and in attributes", () => {
  const html = renderHtmlReport(hostileReport(), "iec");
  assert.ok(html.includes("=cmd|&#39; /C calc&#39;!A0"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&quot;quoted&quot;, with a comma"));
  assert.ok(html.includes("a&amp;b&lt;c&gt;d&#39;e&amp;amp;"));
  assert.ok(html.includes("&lt;b&gt;now&lt;/b&gt;"), "a message is escaped as well as a name");
  assert.ok(html.includes("invoice&lt;U+202E&gt;txt.exe"), "a direction override is shown, not obeyed");
  assert.ok(html.includes("l".repeat(255)));
  assert.ok(html.includes("report \u{1F4C4}\u200D\u{1F525}.txt"), "an emoji sequence is kept as written");
  // The page's own line breaks between tags are the only control character in it.
  assert.doesNotMatch(html, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/);
});

test("HTML can neither run nor load anything", () => {
  const html = renderHtmlReport(hostileReport(), "iec");
  assert.ok(html.startsWith("<!DOCTYPE html>\n"));
  assert.equal(REPORT_CSP, "default-src 'none'; style-src 'unsafe-inline'");
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`));
  assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<title>"), "the policy comes before anything it governs");
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<(iframe|img|link|object|embed|form|base|svg|video|audio|source)\b/i);
  assert.doesNotMatch(html, /\s(src|href|action|srcset|on[a-z]+)\s*=/i);
  assert.doesNotMatch(html, /url\(|@import|javascript:/i);
  // The only style attribute is a capacity bar's width, which Disktop computed.
  for (const [, style] of html.matchAll(/style="([^"]*)"/g)) {
    assert.match(style, /^width: (100|[1-9]?[0-9])%$/);
  }
});

test("HTML shows capacity bars, unknowns as unknown, and marks names shown with substitutions", () => {
  const html = renderHtmlReport(hostileReport(), "iec");
  assert.ok(html.includes('<span class="bar alert" role="img" aria-label="52% used"><span style="width: 52%"></span></span>'));
  assert.match(html, /<td class="num">unknown<\/td>/, "an unmeasured finding says unknown");
  assert.match(html, /not reported/, "a filesystem with no inode counts says so instead of 0%");
  const invalid = HOSTILE_PATHS.get("invalid-utf8");
  assert.ok(html.includes(`Raw bytes, base64: ${invalid.bytesBase64}`), "the exact bytes are one hover away");
  assert.ok(html.includes(`${escapeHtml(invalid.display)}&#8224;`));
  assert.ok(html.includes('title="9007199254740993 bytes"'), "the exact count is beside the rounded one");
  for (const tag of ["table", "tr", "td", "section", "ul", "li", "dl"]) {
    const opened = (html.match(new RegExp(`<${tag}[\\s>]`, "g")) ?? []).length;
    const closed = (html.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
    assert.equal(opened, closed, `<${tag}> opened ${opened} times and closed ${closed}`);
  }
  assert.match(renderHtmlReport(hostileReport(), "si"), /GB/);
  assert.match(html, /GiB|PiB|EiB/);
});

test("HTML says what an incomplete or omitted section is missing", () => {
  const html = renderHtmlReport(
    hostileReport({
      complete: false,
      capacity: { ...FIXTURE_VIEW, complete: false, warnings: [{ code: "statfs-unreadable", message: "One mount <could not> be measured." }] },
      scan: { included: false, reason: "No --path was given, so no scan is included." },
      findings: { included: false, reason: "Detectors were not run." },
    }),
    "iec",
  );
  assert.match(html, /class="status incomplete">Incomplete/);
  assert.ok(html.includes("<strong>statfs-unreadable</strong>: One mount &lt;could not&gt; be measured."));
  assert.ok(html.includes("No --path was given, so no scan is included."));
  assert.ok(html.includes("Detectors were not run."));
  assert.ok(html.includes("Sections: capacity."));
});

test("the JSON report validates, keeps byte counts exact, and carries every name's bytes", () => {
  const text = renderJsonReport(hostileReport());
  const document = JSON.parse(text);
  const validate = validators.get("report-document");
  assert.ok(validate(document), JSON.stringify(validate.errors));
  assert.equal(document.generator.version, "1.2.3");
  assert.deepEqual(document.sections, ["capacity", "scan", "findings"]);
  assert.equal(document.scan.entries.items[0].allocatedBytes, "9007199254740993");
  assert.match(text, /"allocatedBytes": "9007199254740993"/, "never a JSON number");
  const bytes = document.scan.entries.items.map((item) => item.path.bytesBase64);
  for (const [name, path] of HOSTILE_PATHS) {
    assert.ok(bytes.includes(path.bytesBase64), `${name} is missing its bytes`);
  }
  const unknown = document.findings.findings.find((finding) => finding.id === "rules:formula");
  assert.equal(unknown.size.basis, "unknown");
  assert.equal("bytes" in unknown.size, false, "an unknown size carries no number");
  const sshfs = document.capacity.filesystems.find((usage) => usage.filesystem.id === "fs-0-99");
  assert.equal("inodesUsedPercent" in sshfs, false);
});

test("a JSON report with omitted and incomplete sections validates and says which", () => {
  const document = JSON.parse(
    renderJsonReport(
      hostileReport({
        complete: false,
        scan: { ...hostileReport().scan, complete: false, warnings: [{ code: "index-unavailable", message: "The index could not be read." }], largest: undefined, children: undefined, largestFiles: undefined, typeTotals: undefined },
        findings: { included: false, reason: "Detectors were not run." },
      }),
    ),
  );
  const validate = validators.get("report-document");
  assert.ok(validate(document), JSON.stringify(validate.errors));
  assert.equal(document.status, "incomplete");
  assert.deepEqual(document.sections, ["capacity", "scan"]);
  assert.equal("entries" in document.scan, false);
  assert.deepEqual(document.findings, { included: false, reason: "Detectors were not run." });
});

test("HTML groups many warnings of one kind into one line that opens to their paths", () => {
  const base = hostileReport();
  const unreadable = Array.from({ length: 40 }, (_, index) => ({
    code: "inaccessible-directory",
    message: "The directory could not be read: Permission denied (os error 13)",
    path: rawPathFromUtf8(`/var/lib/private-${index}`),
  }));
  const report = { ...base, complete: false, scan: { ...base.scan, complete: false, warnings: unreadable } };
  const html = renderHtmlReport(report, "iec");
  assert.equal((html.match(/<summary><strong>inaccessible-directory<\/strong> &times; 40/g) ?? []).length, 1);
  assert.ok(html.includes("/var/lib/private-39"), "every path is still in the page");
  assert.equal((html.match(/Permission denied \(os error 13\)/g) ?? []).length, 1, "the shared message is written once");
});
