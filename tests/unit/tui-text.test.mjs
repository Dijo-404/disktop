import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cellWidth,
  center,
  groupDigits,
  padEnd,
  padStart,
  relativeAge,
  sliceCells,
  stripControls,
  truncate,
  truncateMiddle,
  truncateStart,
  wrap,
} from "../../dist/tui/text.js";
import { parseSearch, searchFilter } from "../../dist/tui/search.js";

test("a cell is a terminal column: wide characters count two and combining marks none", () => {
  assert.equal(cellWidth("hello"), 5);
  assert.equal(cellWidth("日本語"), 6);
  assert.equal(cellWidth("🎉"), 2);
  assert.equal(cellWidth("é"), 1, "e with a combining acute accent is one cell");
  assert.equal(cellWidth("👩\u200d💻"), 2, "a ZWJ emoji sequence is one wide glyph");
  assert.equal(cellWidth(""), 0);
});

test("cutting never splits a wide character or passes the width", () => {
  for (const text of ["日本語のファイル名.txt", "emoji-🎉-party-🎉🎉", "plain-ascii-name", "mixed 日本 and 🎉 text"]) {
    for (let width = 0; width <= cellWidth(text) + 2; width += 1) {
      assert.ok(cellWidth(sliceCells(text, width)) <= width, `slice of ${text} at ${width}`);
      assert.ok(cellWidth(truncate(text, width)) <= width, `truncate of ${text} at ${width}`);
      assert.ok(cellWidth(truncateMiddle(text, width)) <= width, `middle of ${text} at ${width}`);
      assert.ok(cellWidth(truncateStart(text, width)) <= width, `start of ${text} at ${width}`);
      assert.equal(cellWidth(padEnd(text, width)), width, `padEnd of ${text} at ${width}`);
      assert.equal(cellWidth(padStart(text, width)), width, `padStart of ${text} at ${width}`);
      assert.equal(cellWidth(center(text, width)), width, `center of ${text} at ${width}`);
    }
  }
});

test("a trimmed name says it was trimmed, and a path keeps both ends", () => {
  assert.equal(truncate("node_modules", 8), "node_mo…");
  assert.equal(truncate("node_modules", 8, "~"), "node_mo~");
  assert.equal(truncateMiddle("/home/example/projects/disktop/node_modules", 20), "/home/exam…e_modules");
  assert.equal(truncateStart("/home/example/projects", 10), "…/projects");
  assert.equal(truncate("short", 10), "short");
});

test("controls and direction overrides never survive to the screen", () => {
  const hostile = "a\u001b[2Jb\u009b31mc\u202ed\u2066e\u0007f";
  const clean = stripControls(hostile);
  assert.doesNotMatch(clean, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  assert.match(clean, /a.*b.*c.*d.*e.*f/);
});

test("prose wraps at spaces and never overflows, even a word longer than the line", () => {
  const lines = wrap("Each item is moved out of Trash to its original path. Supercalifragilisticexpialidocious.", 12);
  for (const line of lines) {
    assert.ok(cellWidth(line) <= 12, JSON.stringify(line));
  }
  assert.ok(lines.join(" ").includes("original"));
});

test("counts and ages read the way a person reads them", () => {
  assert.equal(groupDigits(1234567n), "1,234,567");
  assert.equal(groupDigits(12), "12");
  const now = Date.parse("2026-10-03T10:00:00Z");
  assert.equal(relativeAge(now - 5_000, now), "just now");
  assert.equal(relativeAge(now - 3 * 60_000, now), "3m ago");
  assert.equal(relativeAge(now - 5 * 3_600_000, now), "5h ago");
  assert.equal(relativeAge(now - 10 * 86_400_000, now), "10d ago");
  assert.equal(relativeAge(now + 60_000, now), "just now", "a clock that moved backwards is not a negative age");
});

test("the filter syntax maps onto the same filter the CLI builds", () => {
  const parsed = parseSearch("report ext:log >1GiB <2GiB age>30 type:file");
  assert.ok(parsed.ok);
  assert.equal(parsed.query.nameContains, "report");
  assert.equal(parsed.query.extension, "log");
  assert.equal(parsed.query.minBytes, 1024n ** 3n);
  assert.equal(parsed.query.maxBytes, 2n * 1024n ** 3n);
  assert.equal(parsed.query.olderThanDays, 30);
  const filter = searchFilter(parsed.query, new Date("2026-10-03T00:00:00Z"));
  assert.equal(filter.minAllocatedBytes, 1024n ** 3n);
  assert.equal(filter.extension, "log");
  assert.ok(filter.modifiedBeforeNanoseconds < BigInt(Date.parse("2026-10-03T00:00:00Z")) * 1_000_000n);
  assert.deepEqual(parseSearch(".tar").ok && parseSearch(".tar").query.extension, "tar");
});

test("a filter that cannot mean anything is refused with the reason", () => {
  for (const bad of [">lots", "type:socket", "ext:", "age>soon"]) {
    const parsed = parseSearch(bad);
    assert.equal(parsed.ok, false, bad);
    assert.match(parsed.message, /\S/);
  }
});

test("flags and keycaps are two cells, as terminals draw them", () => {
  assert.equal(cellWidth("🇯🇵"), 2);
  assert.equal(cellWidth("1️⃣"), 2);
  assert.equal(cellWidth("#️⃣"), 2);
  assert.equal(cellWidth("flag-🇯🇵-japan.txt"), 17);
  assert.equal(cellWidth("©"), 1, "a text-presentation symbol stays one cell");
});

test("a timestamp of exactly the epoch is unknown, not fifty-six years old", async () => {
  // FAT keeps no time on its root directory and the helper clamps anything
  // before 1970 to zero, so zero means "no time was recorded".
  const { relativeAge, localDateTime } = await import("../../dist/tui/text.js");
  assert.equal(relativeAge(0, Date.parse("2026-10-04T12:00:00Z")), "-");
  assert.equal(localDateTime(0), "unknown");
  assert.equal(relativeAge(Date.parse("2026-10-04T11:00:00Z"), Date.parse("2026-10-04T12:00:00Z")), "1h ago");
});
