import type { StyleName } from "./themes.js";
import { cellWidth, stripControls, truncate } from "./text.js";

/**
 * What a row ends in when text had to be cut at the edge. The screen sets it
 * from the theme before each frame, so an ASCII terminal gets "~".
 */
let clipMark = "…";

export function setClipMark(mark: string): void {
  clipMark = mark;
}

/** A run of text drawn in one style. */
export interface Span {
  readonly text: string;
  readonly style: StyleName;
}

/**
 * One terminal row. `selected` draws the whole row as the current selection;
 * `fill` pads the rest of the row in a style, which is how a header band
 * reaches the right edge.
 */
export interface ScreenLine {
  readonly spans: readonly Span[];
  readonly selected?: boolean;
  readonly fill?: StyleName;
}

export interface ScreenSize {
  readonly columns: number;
  readonly rows: number;
}

/** Something a mouse click on a row can mean. */
export type HitAction =
  | { readonly kind: "tab"; readonly index: number }
  | { readonly kind: "row"; readonly index: number };

export interface HitRegion {
  readonly row: number;
  readonly from: number;
  readonly to: number;
  readonly action: HitAction;
}

/** A whole screen: exactly `rows` lines, none wider than `columns` cells. */
export interface Frame {
  readonly lines: readonly ScreenLine[];
  readonly hits: readonly HitRegion[];
  /** Where the text cursor belongs while somebody is typing, if anywhere. */
  readonly cursor?: { readonly row: number; readonly column: number };
}

/** The smallest terminal the layout is required to stay readable in. */
export const MINIMUM_SIZE: ScreenSize = { columns: 80, rows: 24 };

/** Plain text of a line, for tests and for anything that only needs the words. */
export function lineText(line: ScreenLine): string {
  return line.spans.map((span) => span.text).join("");
}

export function lineWidth(line: ScreenLine): number {
  return line.spans.reduce((total, span) => total + cellWidth(span.text), 0);
}

/**
 * Build a row left to right without ever passing its width.
 *
 * Every `add` is clipped at the edge, so a view can append freely and the row
 * still fits; text is cleaned of control characters on the way in.
 */
export class LineBuilder {
  readonly #spans: Span[] = [];
  readonly #width: number;
  #used = 0;

  constructor(width: number) {
    this.#width = Math.max(0, width);
  }

  get used(): number {
    return this.#used;
  }

  get remaining(): number {
    return this.#width - this.#used;
  }

  add(text: string, style: StyleName = "normal"): this {
    if (text === "" || this.#used >= this.#width) {
      return this;
    }
    const clean = stripControls(text);
    const room = this.#width - this.#used;
    // Text cut at the edge says so, so a reader never takes a clipped
    // message or name for the whole of it.
    const fitted = cellWidth(clean) <= room ? clean : truncate(clean, room, clipMark);
    const width = cellWidth(fitted);
    if (width === 0) {
      return this;
    }
    this.#used += width;
    const last = this.#spans[this.#spans.length - 1];
    if (last !== undefined && last.style === style) {
      this.#spans[this.#spans.length - 1] = { text: last.text + fitted, style };
    } else {
      this.#spans.push({ text: fitted, style });
    }
    return this;
  }

  /** Spaces up to an absolute column, so the next span starts there. */
  padTo(column: number, style: StyleName = "normal"): this {
    if (column > this.#used) {
      this.add(" ".repeat(Math.min(column, this.#width) - this.#used), style);
    }
    return this;
  }

  /** Put `text` flush against the right edge, if it fits after what is already there. */
  addRight(text: string, style: StyleName = "normal", margin = 0): this {
    const width = cellWidth(text);
    const start = this.#width - margin - width;
    if (start < this.#used) {
      return this;
    }
    this.padTo(start);
    return this.add(text, style);
  }

  build(options: { selected?: boolean; fill?: StyleName } = {}): ScreenLine {
    return {
      spans: [...this.#spans],
      ...(options.selected === true ? { selected: true } : {}),
      ...(options.fill === undefined ? {} : { fill: options.fill }),
    };
  }
}

export function plainLine(text: string, style: StyleName, width: number): ScreenLine {
  return new LineBuilder(width).add(text, style).build();
}

export const BLANK_LINE: ScreenLine = { spans: [] };
