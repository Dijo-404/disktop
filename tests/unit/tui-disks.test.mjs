import assert from "node:assert/strict";
import { test } from "node:test";
import { MINIMUM_SIZE, renderDisks, windowFor } from "../../dist/tui/views/disks.js";
import { initialState, reduce } from "../../dist/tui/state.js";
import { intentForKey } from "../../dist/tui/keys.js";
import { ASCII_THEME, COLOR_THEME, selectTheme, usageBar } from "../../dist/tui/themes.js";
import { FIXTURE_VIEW } from "../support/cli-context.mjs";

function screen(state, size = MINIMUM_SIZE, theme = ASCII_THEME) {
  return renderDisks(state, size, theme).map((line) => line.text);
}

const BASE = initialState(FIXTURE_VIEW, "iec");

test("the layout fills exactly 80 by 24 and never overflows a column", () => {
  const lines = screen(BASE);
  assert.equal(lines.length, 24);
  for (const line of lines) {
    assert.ok(line.length <= 80, `line exceeds 80 columns: ${JSON.stringify(line)}`);
  }
});

test("the header names the selected filesystem, its used share, and what is left", () => {
  const [header] = screen(BASE);
  assert.match(header, /^Disktop {2}\//);
  assert.match(header, /% used/);
  assert.match(header, /available/);
});

test("every tab is shown and the current one is marked without relying on colour", () => {
  const [, tabs] = screen(BASE);
  for (const tab of ["Disks", "Explore", "Clean", "Dev", "Apps", "History"]) {
    assert.match(tabs, new RegExp(tab));
  }
  assert.match(tabs, /\[Disks\]/);
});

test("a narrow terminal drops decoration before it drops a filesystem", () => {
  const narrow = screen(BASE, { columns: 40, rows: 24 });
  for (const line of narrow) {
    assert.ok(line.length <= 40);
  }
  assert.ok(narrow.some((line) => line.includes("/media/usb")), "the list survives a 40-column terminal");
});

test("nothing drawn on screen can carry a terminal control sequence", () => {
  const hostile = {
    ...FIXTURE_VIEW,
    filesystems: [
      {
        ...FIXTURE_VIEW.filesystems[0],
        mounts: [{ bytesBase64: "eA==", display: "/mnt/␛[2Jgotcha", utf8: "/mnt/x" }],
      },
    ],
  };
  for (const line of screen(initialState(hostile, "iec"))) {
    assert.doesNotMatch(line, /\u001b|\u009b/, "a filename reaches the screen as text, never as control bytes");
  }
});

test("an incomplete reading is stated on screen rather than passing for a full one", () => {
  const partial = { ...FIXTURE_VIEW, complete: false, warnings: [{ code: "statfs-unreadable", message: "one mount" }] };
  assert.ok(screen(initialState(partial, "iec")).some((line) => line.includes("Incomplete:")));
});

test("an alert is named on screen when one filesystem is over its threshold", () => {
  const alerting = {
    ...FIXTURE_VIEW,
    alerts: [{ filesystemId: "fs-259-2", kind: "low-space", usedPercent: 99, thresholdPercent: 90, message: "/ is 99% used." }],
  };
  const lines = screen(initialState(alerting, "iec"));
  assert.ok(lines.some((line) => line.includes("/ is 99% used.")));
  assert.match(lines[0], /\[warning\]/);
});

test("help replaces the list and says Disktop changes nothing yet", () => {
  const helping = reduce(BASE, { kind: "toggle-help" });
  const lines = screen(helping);
  assert.ok(lines.some((line) => line.includes("q or Ctrl+C")));
  assert.ok(lines.some((line) => line.includes("Disktop changes nothing on disk")));
  assert.equal(lines.length, 24);
});

test("vim keys and arrows reach the same intents, and no key deletes", () => {
  assert.deepEqual(intentForKey("j"), intentForKey("DOWN"));
  assert.deepEqual(intentForKey("k"), intentForKey("UP"));
  assert.deepEqual(intentForKey("q"), { kind: "quit" });
  assert.deepEqual(intentForKey("CTRL_C"), { kind: "quit" });
  for (const key of ["d", "D", "x", "DELETE", "BACKSPACE", "ENTER"]) {
    assert.deepEqual(intentForKey(key), { kind: "none" }, `${key} must do nothing`);
  }
});

test("the selection cannot move past either end of the list", () => {
  let state = BASE;
  for (let press = 0; press < 10; press += 1) {
    state = reduce(state, { kind: "move", delta: 1 });
  }
  assert.equal(state.selected, FIXTURE_VIEW.filesystems.length - 1);
  for (let press = 0; press < 10; press += 1) {
    state = reduce(state, { kind: "move", delta: -1 });
  }
  assert.equal(state.selected, 0);
});

test("an unbuilt tab says so instead of showing an empty screen", () => {
  const state = reduce(BASE, { kind: "tab", delta: 1 });
  assert.equal(state.tab, "Explore");
  assert.match(state.notice, /arrives in a later phase/);
});

test("switching units changes the text and not the underlying reading", () => {
  const si = reduce(BASE, { kind: "toggle-units" });
  assert.equal(si.units, "si");
  assert.ok(screen(BASE).some((line) => line.includes("GiB")));
  assert.ok(screen(si).some((line) => line.includes("GB")));
  assert.equal(si.view.filesystems[0].totalBytes, BASE.view.filesystems[0].totalBytes);
});

test("the scroll window keeps the selection visible without running past the list", () => {
  assert.deepEqual(windowFor(0, 3, 10), { start: 0, end: 3 });
  assert.deepEqual(windowFor(0, 100, 10), { start: 0, end: 10 });
  assert.deepEqual(windowFor(99, 100, 10), { start: 90, end: 100 });
  assert.deepEqual(windowFor(50, 100, 10), { start: 45, end: 55 });
});

test("NO_COLOR and a dumb terminal both drop to plain ASCII", () => {
  assert.equal(selectTheme({ TERM: "xterm-256color" }, true), COLOR_THEME);
  assert.equal(selectTheme({ TERM: "xterm-256color", NO_COLOR: "" }, true), ASCII_THEME);
  assert.equal(selectTheme({ TERM: "dumb" }, true), ASCII_THEME);
  assert.equal(selectTheme({}, true), ASCII_THEME);
  assert.equal(selectTheme({ TERM: "xterm" }, false), ASCII_THEME);
});

test("the usage bar is proportional and drawn from characters, not colour alone", () => {
  assert.equal(usageBar(0, 10, ASCII_THEME), "..........");
  assert.equal(usageBar(100, 10, ASCII_THEME), "##########");
  assert.equal(usageBar(50, 10, ASCII_THEME), "#####.....");
  assert.equal(usageBar(150, 10, ASCII_THEME), "##########");
});

test("a screen with no filesystems says so rather than rendering an empty list", () => {
  const empty = initialState({ ...FIXTURE_VIEW, filesystems: [], alerts: [] }, "iec");
  assert.ok(screen(empty).some((line) => line.includes("No filesystem could be inspected.")));
});
