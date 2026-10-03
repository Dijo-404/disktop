import assert from "node:assert/strict";
import { test } from "node:test";
import { lineText, MINIMUM_SIZE } from "../../dist/tui/frame.js";
import { renderScreen } from "../../dist/tui/screen.js";
import { initialState } from "../../dist/tui/state.js";
import { ASCII_THEME, buildTheme } from "../../dist/tui/themes.js";
import { cellWidth } from "../../dist/tui/text.js";
import { FIXTURE_VIEW, rawPath } from "../support/cli-context.mjs";
import { CHILDREN, HOME, NOW, PLAN, RECORDS, ROOT_ENTRY, SNAPSHOT, SUMMARY, TYPE_TOTALS, entry } from "../support/tui-fixtures.mjs";

const UNICODE = buildTheme("256", true);
const SIZES = [MINIMUM_SIZE, { columns: 40, rows: 10 }, { columns: 60, rows: 20 }, { columns: 132, rows: 43 }, { columns: 220, rows: 60 }];

function render(state, size = MINIMUM_SIZE, theme = ASCII_THEME) {
  return renderScreen(state, size, { theme, now: NOW, threshold: 90, home: HOME });
}

function text(state, size, theme) {
  return render(state, size, theme).lines.map(lineText);
}

const BASE = initialState(FIXTURE_VIEW, "iec");

const EXPLORING = {
  ...BASE,
  tab: "Explore",
  explore: {
    ...BASE.explore,
    root: ROOT_ENTRY.path,
    snapshot: SNAPSHOT,
    directory: { path: ROOT_ENTRY.path, id: ROOT_ENTRY.id, entry: ROOT_ENTRY },
    rows: CHILDREN.map((child) => ({ kind: "entry", entry: child })),
    typeTotals: TYPE_TOTALS,
    trend: { values: [80n * 1024n ** 3n, 85n * 1024n ** 3n, 91n * 1024n ** 3n], since: "Sep 1", delta: 11n * 1024n ** 3n },
    growth: new Map([[CHILDREN[0].path.bytesBase64, 3n * 1024n ** 3n]]),
  },
};
const CLEANING = { ...BASE, tab: "Clean", findings: { ...BASE.findings, summary: SUMMARY, loadedAt: NOW } };
const HISTORY = { ...BASE, tab: "History", history: { ...BASE.history, records: RECORDS, loaded: true } };
const REVIEWING = { ...CLEANING, dialog: { kind: "review", plan: PLAN, alternatives: ["trash", "permanent"], typed: "", origin: "finding", findingId: "x" } };
const IRREVERSIBLE = { ...CLEANING, dialog: { kind: "review", plan: { ...PLAN, operation: "permanent", reversibility: "irreversible" }, alternatives: ["trash", "permanent"], typed: "ye", origin: "finding", findingId: "x" } };
const HELPING = { ...EXPLORING, showHelp: true };

const STATES = { Disks: BASE, Explore: EXPLORING, Clean: CLEANING, History: HISTORY, Review: REVIEWING, Irreversible: IRREVERSIBLE, Help: HELPING };

test("every screen fills the terminal exactly and no row is wider than it, at every size and in both glyph sets", () => {
  for (const [name, state] of Object.entries(STATES)) {
    for (const size of SIZES) {
      for (const theme of [ASCII_THEME, UNICODE]) {
        const frame = render(state, size, theme);
        assert.equal(frame.lines.length, size.rows, `${name} at ${size.columns}x${size.rows} has the wrong number of rows`);
        for (const [row, line] of frame.lines.entries()) {
          const width = cellWidth(lineText(line));
          assert.ok(width <= size.columns, `${name} ${size.columns}x${size.rows} row ${row} is ${width} cells: ${JSON.stringify(lineText(line))}`);
        }
      }
    }
  }
});

test("an ASCII screen contains nothing outside printable ASCII except the names it was given", () => {
  for (const [name, state] of Object.entries(STATES)) {
    for (const line of text(state, MINIMUM_SIZE, ASCII_THEME)) {
      const withoutNames = line.replace(/日本語のファイル名\.txt|emoji-🎉-party/g, "");
      assert.match(withoutNames, /^[\x20-\x7e]*$/, `${name}: ${JSON.stringify(line)}`);
    }
  }
});

test("a hostile name reaches the screen as text, never as a control sequence", () => {
  const hostile = entry("/home/example/projects/x", "file", 1n, { path: { bytesBase64: "eA==", display: "/home/example/projects/\u001b[2J\u009b31mgotcha\u202e", utf8: "x" } });
  const state = { ...EXPLORING, explore: { ...EXPLORING.explore, rows: [{ kind: "entry", entry: hostile }] } };
  for (const line of render(state, MINIMUM_SIZE, UNICODE).lines) {
    for (const span of line.spans) {
      assert.doesNotMatch(span.text, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/);
    }
  }
});

test("wide names keep the column after them aligned", () => {
  const lines = text(EXPLORING, MINIMUM_SIZE, UNICODE);
  const ages = lines.filter((line) => line.endsWith("3d ago"));
  assert.ok(ages.length >= 5, "the modified column is drawn");
  const widths = new Set(ages.map((line) => cellWidth(line)));
  assert.equal(widths.size, 1, `every row ends at the same column: ${[...widths].join(", ")}`);
});

test("the header names the filesystem, its share, and what is free; the tab bar marks the current tab", () => {
  const [header, tabs] = text(BASE);
  assert.match(header, /Disktop/);
  assert.match(header, /\d+%/);
  assert.match(header, /free/);
  for (const tab of ["Disks", "Explore", "Clean", "Dev", "Apps", "History"]) {
    assert.match(tabs, new RegExp(tab));
  }
  const frame = render(BASE);
  const active = frame.lines[1].spans.find((span) => span.style === "tabActive");
  assert.match(active.text, /Disks/, "the current tab is marked by its style, which the renderer draws inverse without colour");
});

test("an alert and an incomplete reading are both stated on screen", () => {
  const alerting = initialState(
    { ...FIXTURE_VIEW, complete: false, warnings: [{ code: "statfs-unreadable", message: "one mount" }], alerts: [{ filesystemId: "fs-259-2", kind: "low-space", usedPercent: 99, thresholdPercent: 90, message: "/ is 99% used." }] },
    "iec",
  );
  const lines = text(alerting);
  assert.ok(lines.some((line) => line.includes("/ is 99% used.")));
  assert.match(lines[0], /1 alert/);
  assert.match(lines[0], /incomplete/);
});

test("Explore shows the breadcrumb, shares, growth, the trend, and the file-type breakdown", () => {
  const lines = text(EXPLORING, { columns: 100, rows: 30 }, UNICODE);
  const joined = lines.join("\n");
  assert.match(joined, /~ › projects/);
  assert.match(joined, /node_modules\//);
  assert.match(joined, /\d+\.\d%/, "each row shows its share of the directory");
  assert.match(joined, /\+3\.0 GiB/, "growth since the previous comparable scan");
  assert.match(joined, /since Sep 1/, "the trend across comparable scans");
  assert.match(joined, /\.js/, "file types");
  assert.match(joined, /dangling/);
});

test("Explore without a scan says how to get one instead of showing an empty list", () => {
  const state = { ...BASE, tab: "Explore" };
  const joined = text(state).join("\n");
  assert.match(joined, /Nothing has been scanned here yet/);
  assert.match(joined, /Press S to scan/);
});

test("a running scan shows what it has read and how to stop it", () => {
  const state = { ...BASE, tab: "Explore", explore: { ...BASE.explore, scan: { root: rawPath("/home/example"), entries: 12_345n, bytes: 1n << 30n, inaccessible: 2n, startedAt: NOW - 4000, current: "/home/example/a" } } };
  const joined = text(state).join("\n");
  assert.match(joined, /Scanning ~/);
  assert.match(joined, /12,345/);
  assert.match(joined, /Unreadable\s+2/);
  assert.match(joined, /Esc stops/);
});

test("Clean totals only what a plan could act on, and keeps the rest for information", () => {
  const joined = text(CLEANING, { columns: 100, rows: 30 }).join("\n");
  assert.match(joined, /in 4 to review/);
  assert.match(joined, /1 for information/);
  assert.match(joined, /~858\.3 MiB/, "a manager's estimate is marked as one");
  assert.match(joined, /unknown/, "an unmeasured size is never shown as zero");
  assert.doesNotMatch(joined, /412 dpkg packages/, "installed applications are listed under Apps, not Clean");
  const apps = text({ ...CLEANING, tab: "Apps" }, { columns: 100, rows: 30 }).join("\n");
  assert.match(apps, /412 dpkg packages/);
});

test("a reversible review offers y; an irreversible one says so and asks for yes typed out", () => {
  const reversible = text(REVIEWING).join("\n");
  assert.match(reversible, /Move to Trash/);
  assert.match(reversible, /from the History tab/);
  assert.match(reversible, /y apply/);
  const irreversible = text(IRREVERSIBLE).join("\n");
  assert.match(irreversible, /cannot be undone/);
  assert.match(irreversible, /Type yes and press Enter/);
  assert.doesNotMatch(irreversible, /\by apply\b/);
  assert.ok(render(IRREVERSIBLE).cursor !== undefined, "the typing position is shown");
});

test("History marks what can be undone and explains an uncertain record", () => {
  const joined = text({ ...HISTORY, history: { ...HISTORY.history, selected: 1 } }).join("\n");
  assert.match(joined, /complete/);
  assert.match(joined, /uncertain/);
  assert.match(joined, /undo is refused until/);
});

test("help lists the keys for the current tab and the promise that nothing changes unconfirmed", () => {
  const joined = text(HELPING).join("\n");
  assert.match(joined, /open directory/);
  assert.match(joined, /quit/);
  assert.match(joined, /reviewed plan/);
});

test("a terminal below the minimum gets a message, not a broken layout", () => {
  const lines = text(BASE, { columns: 30, rows: 8 });
  assert.equal(lines.length, 8);
  assert.ok(lines.some((line) => line.includes("Disktop needs at least")));
});

test("switching units changes the text and not the reading", () => {
  const si = { ...BASE, units: "si" };
  assert.ok(text(BASE).some((line) => line.includes("GiB")));
  assert.ok(text(si).some((line) => line.includes("GB")));
});

test("rows can be clicked: every listed row and every tab has a region", () => {
  const frame = render(EXPLORING);
  assert.equal(frame.hits.filter((hit) => hit.action.kind === "tab").length, 6);
  assert.equal(frame.hits.filter((hit) => hit.action.kind === "row").length, CHILDREN.length);
  for (const hit of frame.hits) {
    assert.ok(hit.row >= 0 && hit.row < 24 && hit.from < hit.to);
  }
});

test("the configured space threshold colours the bars, not a fixed 90", () => {
  const at = (threshold) =>
    renderScreen(BASE, MINIMUM_SIZE, { theme: UNICODE, now: NOW, threshold, home: HOME }).lines[3].spans.map((span) => span.style);
  // The root filesystem is 52% used: past a 50% threshold, comfortably under 90%.
  assert.ok(at(50).includes("barDanger"));
  assert.ok(!at(90).includes("barDanger"));
});
