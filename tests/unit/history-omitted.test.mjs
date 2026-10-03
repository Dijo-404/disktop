import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeJournalRecord } from "../../dist/cli/output.js";
import { historyLines } from "../../dist/cli/text.js";
import { lineText, MINIMUM_SIZE } from "../../dist/tui/frame.js";
import { renderScreen } from "../../dist/tui/screen.js";
import { initialState } from "../../dist/tui/state.js";
import { ASCII_THEME } from "../../dist/tui/themes.js";
import { canUndo } from "../../dist/tui/views/history.js";
import { FIXTURE_VIEW } from "../support/cli-context.mjs";
import { HOME, NOW, RECORDS } from "../support/tui-fixtures.mjs";

// A half-million-item Trash action whose first page of items all failed: the
// ones that went to Trash are among those the page left out.
const SHORTENED = {
  ...RECORDS[0],
  state: "partial",
  completed: 499_000n,
  failed: 1_000n,
  items: RECORDS[0].items.map((item) => ({ ...item, outcome: "failed", destination: undefined })),
  itemsOmitted: 499_999n,
};

test("a record whose page left items out says how many, in JSON", () => {
  assert.equal(encodeJournalRecord(SHORTENED).itemsOmitted, "499999");
  assert.equal("itemsOmitted" in encodeJournalRecord(RECORDS[0]), false, "and says nothing when none were");
});

test("left-out items are not read as proof that nothing went to Trash", () => {
  assert.match(historyLines([SHORTENED], "iec")[0], /undo available/);
  assert.equal(canUndo(SHORTENED), true);
});

test("the TUI says how many items it is not listing", () => {
  const state = { ...initialState(FIXTURE_VIEW, "iec"), tab: "History", history: { records: [SHORTENED], reconciled: 0n, selected: 0, loaded: true } };
  const lines = renderScreen(state, MINIMUM_SIZE, { theme: ASCII_THEME, now: NOW, threshold: 90, home: HOME }).lines.map(lineText);
  assert.ok(lines.some((line) => line.includes("499,999 more item(s) not listed")), lines.join("\n"));
});
