import { LineBuilder, type HitRegion, type ScreenLine } from "../frame.js";
import type { AppState } from "../state.js";
import { center, wrap } from "../text.js";
import type { StyleName, Theme } from "../themes.js";
import type { Hint } from "../widgets/chrome.js";

/** What every view is drawn from. `top` is the screen row the view's first line lands on. */
export interface ViewContext {
  readonly state: AppState;
  readonly theme: Theme;
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly now: number;
  readonly threshold: number;
}

/** A view's body, where its rows can be clicked, and the keys worth showing. */
export interface ViewOutput {
  readonly lines: readonly ScreenLine[];
  readonly hits: readonly HitRegion[];
  readonly hints: readonly Hint[];
  /** What the status row shows when nothing is running and nothing was announced. */
  readonly status?: ScreenLine | undefined;
}

/** Keep the selected row on screen without ever scrolling past the list. */
export function listWindow(selected: number, count: number, rows: number): { start: number; end: number } {
  if (count <= rows) {
    return { start: 0, end: count };
  }
  const start = Math.max(0, Math.min(count - rows, selected - Math.floor(rows / 2)));
  return { start, end: start + rows };
}

/**
 * A centred message for a view with nothing to list. The first line reads as
 * the headline; the rest explain why and what to do next.
 */
export function emptyState(
  messages: readonly string[],
  width: number,
  height: number,
  theme: Theme,
  icon?: string,
  tone: StyleName = "strong",
): ScreenLine[] {
  const body: ScreenLine[] = [];
  const textWidth = Math.max(10, Math.min(width - 4, 72));
  for (const [index, message] of messages.entries()) {
    if (index === 1) {
      body.push({ spans: [] });
    }
    const text = index === 0 && icon !== undefined ? `${icon}  ${message}` : message;
    for (const piece of wrap(text, textWidth)) {
      body.push(new LineBuilder(width).add(center(piece, width, theme.glyphs.ellipsis), index === 0 ? tone : "dim").build());
    }
  }
  const above = Math.max(0, Math.floor((height - body.length) / 2) - 1);
  const lines: ScreenLine[] = [];
  for (let index = 0; index < above; index += 1) {
    lines.push({ spans: [] });
  }
  return [...lines, ...body].slice(0, height);
}

/** Pad a list of lines to exactly `height`, dropping what does not fit. */
export function fit(lines: readonly ScreenLine[], height: number): ScreenLine[] {
  const fitted = lines.slice(0, Math.max(0, height));
  while (fitted.length < height) {
    fitted.push({ spans: [] });
  }
  return fitted;
}
