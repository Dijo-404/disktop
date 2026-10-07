import { LineBuilder, setClipMark, type Frame, type HitRegion, type ScreenLine, type ScreenSize } from "./frame.js";
import type { AppState } from "./state.js";
import { cellWidth, center, stripControls, truncateStart } from "./text.js";
import type { Theme } from "./themes.js";
import { headerLine, hintLine, statusLine, tabLine } from "./widgets/chrome.js";
import { fit, type ViewContext, type ViewOutput } from "./views/common.js";
import { renderDialog } from "./views/dialogs.js";
import { renderDisks } from "./views/disks.js";
import { renderExplore } from "./views/explore.js";
import { renderFindings } from "./views/findings.js";
import { renderHelp } from "./views/help.js";
import { renderHistory } from "./views/history.js";

/** Below this the layout cannot say anything useful, and says so instead. */
export const SMALLEST_SIZE: ScreenSize = { columns: 40, rows: 10 };

export interface ScreenOptions {
  readonly theme: Theme;
  readonly now: number;
  readonly threshold: number;
  /** The home directory's display form, for `~` abbreviation. */
  readonly home?: string;
}

/**
 * The whole screen as a frame: a header band, the tab bar, the current view
 * (or a dialog in front of it), a status row, and the keys that apply.
 *
 * Every row is built to the terminal's width and the frame always has exactly
 * as many rows as the terminal, so the renderer never has to guess.
 */
export function renderScreen(state: AppState, size: ScreenSize, options: ScreenOptions): Frame {
  const columns = Math.max(1, size.columns);
  const rows = Math.max(1, size.rows);
  const { theme } = options;
  setClipMark(theme.glyphs.ellipsis);

  if (columns < SMALLEST_SIZE.columns || rows < SMALLEST_SIZE.rows) {
    const times = theme.unicode ? "×" : "x";
    const lines: ScreenLine[] = [];
    const middle = Math.floor(rows / 2) - 1;
    for (let index = 0; index < rows; index += 1) {
      if (index === middle) {
        lines.push(new LineBuilder(columns).add(center("Disktop needs at least", columns), "strong").build());
      } else if (index === middle + 1) {
        lines.push(new LineBuilder(columns).add(center(`${SMALLEST_SIZE.columns}${times}${SMALLEST_SIZE.rows}; this is ${columns}${times}${rows}`, columns), "dim").build());
      } else if (index === middle + 2) {
        lines.push(new LineBuilder(columns).add(center("q quits", columns), "muted").build());
      } else {
        lines.push({ spans: [] });
      }
    }
    return { lines, hits: [] };
  }

  const bodyTop = 2;
  const bodyHeight = rows - 4;
  const context: ViewContext = {
    state,
    theme,
    width: columns,
    height: bodyHeight,
    top: bodyTop,
    now: options.now,
    threshold: options.threshold,
  };
  const tabs = tabLine(state, columns, 1);
  const view = viewFor(context, options.home);

  let body: readonly ScreenLine[] = view.lines;
  let hints = view.hints;
  let hits: readonly HitRegion[] = [...tabs.hits, ...view.hits];
  let cursor: Frame["cursor"];

  if (state.showHelp) {
    body = renderHelp(context);
    hints = [["?", "close help"], ["esc", "close"], ["q", "quit"]];
    hits = tabs.hits;
  } else if (state.dialog !== undefined) {
    const dialog = renderDialog(state.dialog, context, options.home);
    body = dialog.lines;
    hints = dialog.hints;
    hits = tabs.hits;
    cursor = dialog.cursor;
  }

  let status: ScreenLine = statusLine(state, theme, columns, options.now, view.status);
  if (state.prompt !== undefined && !state.showHelp && state.dialog === undefined) {
    const line = new LineBuilder(columns).add(" Filter ", "badgeInfo").add(" ");
    const column = line.used;
    const shown = truncateStart(stripControls(state.prompt.text), Math.max(0, line.remaining - 1), theme.glyphs.ellipsis);
    line.add(shown, "input");
    if (state.prompt.error !== undefined) {
      line.add("  ").add(`${theme.glyphs.warn} ${state.prompt.error}`, "warn");
    }
    status = line.build();
    hints = [["enter", "apply"], ["esc", "cancel"], ["^U", "clear"], ["", "words ext:log >1GiB age>30 type:dir"]];
    cursor = { row: rows - 2, column: Math.min(columns - 1, column + cellWidth(shown)) };
  }

  const lines: ScreenLine[] = [
    headerLine(state, theme, columns, context.threshold),
    tabs.line,
    ...fit(body, bodyHeight),
    status,
    hintLine(hints, columns),
  ];
  return { lines, hits, ...(cursor === undefined ? {} : { cursor }) };
}

function viewFor(context: ViewContext, home: string | undefined): ViewOutput {
  switch (context.state.tab) {
    case "Disks":
      return renderDisks(context);
    case "Explore":
      return renderExplore(context, home);
    case "Clean":
    case "Dev":
    case "Apps":
      return renderFindings(context, context.state.tab, home);
    case "History":
      return renderHistory(context, home);
  }
}
