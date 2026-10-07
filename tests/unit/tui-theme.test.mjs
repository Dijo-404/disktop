import assert from "node:assert/strict";
import { test } from "node:test";
import { ASCII_THEME, buildTheme, localeIsUtf8, selectTheme, sparkline, supportsFullScreen, usageBar } from "../../dist/tui/themes.js";
import { serializeLine } from "../../dist/tui/render.js";
import { activityBarSpans, allocateCells, stackedBarSpans } from "../../dist/tui/widgets/bars.js";

const UTF8 = { LANG: "en_US.UTF-8" };

test("colour depth follows TERM and COLORTERM, and NO_COLOR removes only colour", () => {
  assert.equal(selectTheme({ ...UTF8, TERM: "xterm-256color" }, true).color, "256");
  assert.equal(selectTheme({ ...UTF8, TERM: "xterm", COLORTERM: "truecolor" }, true).color, "truecolor");
  assert.equal(selectTheme({ ...UTF8, TERM: "xterm-256color", COLORTERM: "24bit" }, true).color, "truecolor");
  assert.equal(selectTheme({ ...UTF8, TERM: "xterm-direct" }, true).color, "truecolor");
  assert.equal(selectTheme({ ...UTF8, TERM: "xterm" }, true).color, "16");
  const noColor = selectTheme({ ...UTF8, TERM: "xterm-256color", NO_COLOR: "1" }, true);
  assert.equal(noColor.color, "none");
  assert.equal(noColor.unicode, true, "NO_COLOR is about colour, not glyphs");
  // no-color.org: an empty value does not count.
  assert.equal(selectTheme({ ...UTF8, TERM: "xterm-256color", NO_COLOR: "" }, true).color, "256");
  assert.equal(selectTheme({ ...UTF8, TERM: "xterm", COLORTERM: "truecolor", NO_COLOR: "1" }, true).color, "none");
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

test("an activity bar is bounded, moves in both glyph sets, and never claims a percent complete", () => {
  for (const theme of [ASCII_THEME, buildTheme("256", true)]) {
    const frames = new Set();
    for (let tick = 0; tick < 60; tick += 1) {
      const spans = activityBarSpans(20, tick, theme);
      const text = spans.map((span) => span.text).join("");
      assert.equal(text.length, 20);
      assert.doesNotMatch(text, /%/);
      frames.add(text);
    }
    assert.ok(frames.size > 5);
  }
  assert.deepEqual(activityBarSpans(0, 1, ASCII_THEME), []);
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

test("Catppuccin Mocha uses its original colours in truecolor and paired dark surfaces", () => {
  const theme = buildTheme("truecolor", true);
  const styles = {
    normal: "205;214;244", brand: "203;166;247", warn: "249;226;175",
    danger: "243;139;168", directory: "137;180;250", barUsed: "148;226;213",
  };
  for (const [style, rgb] of Object.entries(styles)) {
    const out = serializeLine({ spans: [{ text: "x", style }] }, 4, theme);
    assert.ok(out.includes(`38;2;${rgb}`), `${style} uses the official Mocha foreground`);
    assert.ok(out.includes("48;2;30;30;46"), "base fills ordinary rows and trailing space");
    assert.equal(out.replace(/\u001b\[[0-9;]*m/g, ""), "x   ");
  }
  const selected = serializeLine({ spans: [{ text: "selection", style: "normal" }], selected: true }, 10, theme);
  assert.ok(selected.includes("48;2;49;50;68"), "selection uses surface0");
  assert.ok(selected.includes("38;2;205;214;244"), "selection keeps the contrasting text foreground");
  const band = serializeLine({ spans: [{ text: "header", style: "brand" }], fill: "band" }, 10, theme);
  assert.ok(band.includes("48;2;24;24;37"), "header uses mantle");
  const badge = serializeLine({ spans: [{ text: "warning", style: "badgeWarn" }] }, 10, theme);
  assert.ok(badge.includes("38;2;30;30;46;48;2;249;226;175"), "yellow badges use dark text");
});

test("256 and ANSI terminals approximate the Mocha theme without truecolor escapes", () => {
  for (const [depth, expected] of [["256", "38;5;183"], ["16", "1;95"]]) {
    const out = serializeLine({ spans: [{ text: "Disktop", style: "brand" }], selected: true }, 10, buildTheme(depth, true));
    assert.ok(out.includes(expected));
    assert.doesNotMatch(out, /(?:38|48);2;/);
  }
});

test("semantic text keeps at least 4.5:1 contrast on Mocha selection surfaces", () => {
  const luminance = (rgb) => rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
  for (const style of ["normal", "dim", "muted", "accent", "directory", "symlink", "warn", "danger", "info", "ok"]) {
    const out = serializeLine({ spans: [{ text: "selected item", style }], selected: true }, 20, buildTheme("truecolor", true));
    const fg = out.match(/38;2;(\d+);(\d+);(\d+)/).slice(1).map(Number);
    const bg = out.match(/48;2;(\d+);(\d+);(\d+)/).slice(1).map(Number);
    const ratio = (luminance(fg) + 0.05) / (luminance(bg) + 0.05);
    assert.ok(ratio >= 4.5, `${style} contrast is ${ratio.toFixed(2)}:1`);
  }
});
