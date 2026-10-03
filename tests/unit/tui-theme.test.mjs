import assert from "node:assert/strict";
import { test } from "node:test";
import { ASCII_THEME, buildTheme, localeIsUtf8, selectTheme, sparkline, supportsFullScreen, usageBar } from "../../dist/tui/themes.js";
import { serializeLine } from "../../dist/tui/render.js";
import { allocateCells, stackedBarSpans } from "../../dist/tui/widgets/bars.js";

const UTF8 = { LANG: "en_US.UTF-8" };

test("colour depth follows TERM and COLORTERM, and NO_COLOR removes only colour", () => {
  assert.equal(selectTheme({ ...UTF8, TERM: "xterm-256color" }, true).color, "256");
  assert.equal(selectTheme({ ...UTF8, TERM: "xterm", COLORTERM: "truecolor" }, true).color, "256");
  assert.equal(selectTheme({ ...UTF8, TERM: "xterm" }, true).color, "16");
  const noColor = selectTheme({ ...UTF8, TERM: "xterm-256color", NO_COLOR: "1" }, true);
  assert.equal(noColor.color, "none");
  assert.equal(noColor.unicode, true, "NO_COLOR is about colour, not glyphs");
  // no-color.org: an empty value does not count.
  assert.equal(selectTheme({ ...UTF8, TERM: "xterm-256color", NO_COLOR: "" }, true).color, "256");
});

test("glyphs follow the locale, the kernel console, and DISKTOP_ASCII", () => {
  assert.equal(selectTheme({ TERM: "xterm-256color", LANG: "C" }, true).unicode, false);
  assert.equal(selectTheme({ TERM: "xterm-256color", LANG: "C", LC_ALL: "C.UTF-8" }, true).unicode, true);
  assert.equal(selectTheme({ TERM: "linux", ...UTF8 }, true).unicode, false);
  assert.equal(selectTheme({ TERM: "xterm-256color", ...UTF8, DISKTOP_ASCII: "1" }, true).unicode, false);
  assert.equal(localeIsUtf8({ LC_CTYPE: "en_GB.utf8" }), true);
  assert.equal(localeIsUtf8({}), false);
});

test("a dumb or missing TERM, or no terminal at all, is not driven full-screen", () => {
  assert.equal(supportsFullScreen({ TERM: "dumb" }), false);
  assert.equal(supportsFullScreen({}), false);
  assert.equal(supportsFullScreen({ TERM: "xterm" }), true);
  assert.equal(selectTheme({ TERM: "xterm-256color", ...UTF8 }, false), ASCII_THEME);
});

test("a usage bar is proportional, never longer than asked, and drawn from characters", () => {
  const unicode = buildTheme("256", true);
  for (const theme of [ASCII_THEME, unicode]) {
    for (const percent of [0, 1, 12.5, 50, 99, 100, 150, -5, Number.NaN]) {
      const { filled, empty } = usageBar(percent, 10, theme);
      assert.equal([...filled].length + [...empty].length, 10, `${percent}%`);
    }
  }
  assert.deepEqual(usageBar(50, 10, ASCII_THEME), { filled: "#####", empty: "....." });
  assert.equal(usageBar(100, 4, ASCII_THEME).filled, "####");
  assert.equal(usageBar(56.25, 2, unicode).filled, "█▏", "eighth blocks give sub-cell resolution");
});

test("a stacked bar's cells add up exactly and a sliver gets no misleading cell", () => {
  assert.deepEqual(allocateCells([50n, 30n, 20n], 100n, 10), [5, 3, 2]);
  assert.deepEqual(allocateCells([1n, 999n], 1000n, 10), [0, 10]);
  const cells = allocateCells([333n, 333n, 334n], 1000n, 10);
  assert.equal(cells.reduce((a, b) => a + b, 0), 10);
  const spans = stackedBarSpans([{ value: 70n, style: "series1" }, { value: 10n, style: "series2" }], 100n, 20, ASCII_THEME);
  assert.equal(spans.reduce((total, span) => total + span.text.length, 0), 20);
});

test("a sparkline has one cell per value and a flat series stays flat", () => {
  const theme = buildTheme("256", true);
  assert.equal(sparkline([1, 2, 3, 4], theme).length, 4);
  assert.equal(new Set(sparkline([5, 5, 5], theme)).size, 1);
  assert.equal(sparkline([], theme), "");
});

test("the renderer writes only SGR and text, pads to the width, and keeps % and ^ literal", () => {
  const theme = buildTheme("256", true);
  const line = { spans: [{ text: "weird %s ^r name", style: "strong" }, { text: "\u001b[2Jx", style: "normal" }] };
  const out = serializeLine(line, 30, theme);
  assert.doesNotMatch(out.replace(/\u001b\[[0-9;]*m/g, ""), /\u001b/, "no escape other than SGR");
  const text = out.replace(/\u001b\[[0-9;]*m/g, "");
  assert.equal(text.length, 30);
  assert.match(text, /weird %s \^r name/);
});

test("under NO_COLOR the renderer emits attributes but never a colour", () => {
  const theme = buildTheme("none", true);
  const line = { spans: [{ text: "a", style: "danger" }, { text: "b", style: "barUsed" }, { text: "c", style: "tabActive" }], selected: true };
  const out = serializeLine(line, 10, theme);
  for (const [, parameters] of out.matchAll(/\u001b\[([0-9;]*)m/g)) {
    for (const parameter of parameters.split(";").filter((part) => part !== "")) {
      const code = Number(parameter);
      assert.ok(!((code >= 30 && code <= 49) || (code >= 90 && code <= 107)), `colour code ${code} written under NO_COLOR`);
    }
  }
});
