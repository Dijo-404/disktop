import { LineBuilder, type ScreenLine, type Span } from "../frame.js";
import { cellWidth, sliceCells } from "../text.js";
import type { StyleName, Theme } from "../themes.js";

/**
 * Draw content inside a rounded box that fills the body, centred when the body
 * is wider than the box needs. The border takes the tone of what is inside —
 * a red border means the content is an irreversible decision.
 */
export function boxed(
  title: string,
  content: readonly ScreenLine[],
  width: number,
  height: number,
  theme: Theme,
  tone: StyleName = "border",
  footer?: ScreenLine,
): ScreenLine[] {
  const boxWidth = Math.max(20, Math.min(width - 2, 96));
  const left = Math.max(0, Math.floor((width - boxWidth) / 2));
  const inner = boxWidth - 4;
  const { glyphs } = theme;
  const lines: ScreenLine[] = [];

  const top = new LineBuilder(width).add(" ".repeat(left)).add(`${glyphs.cornerTopLeft}${glyphs.rule}`, tone);
  top.add(` ${title} `, "title");
  top.add(glyphs.rule.repeat(Math.max(0, left + boxWidth - 1 - top.used)), tone).add(glyphs.cornerTopRight, tone);
  lines.push(top.build());

  const room = Math.max(0, height - 2 - (footer === undefined ? 0 : 1));
  // A short terminal loses spacing before it loses content.
  const compact = content.length > room ? content.filter((line) => line.spans.length > 0) : content;
  const shown = compact.slice(0, room);
  const body = [...shown];
  while (body.length < room) {
    body.push({ spans: [] });
  }
  for (const line of [...body, ...(footer === undefined ? [] : [footer])]) {
    const row = new LineBuilder(width).add(" ".repeat(left)).add(`${glyphs.vertical} `, tone);
    let used = 0;
    for (const span of line.spans) {
      if (used >= inner) {
        break;
      }
      const text = span.text;
      const fitted = cellWidth(text) <= inner - used ? text : sliceCells(text, inner - used);
      row.add(fitted, line.selected === true && span.style === "normal" ? "strong" : span.style);
      used += cellWidth(fitted);
    }
    row.padTo(left + boxWidth - 1).add(glyphs.vertical, tone);
    lines.push(row.build());
  }

  const bottom = new LineBuilder(width).add(" ".repeat(left)).add(glyphs.cornerBottomLeft, tone);
  bottom.add(glyphs.rule.repeat(Math.max(0, boxWidth - 2)), tone).add(glyphs.cornerBottomRight, tone);
  lines.push(bottom.build());
  return lines;
}

/** The width available for content inside a box drawn at `width`. */
export function boxInner(width: number): number {
  return Math.max(20, Math.min(width - 2, 96)) - 4;
}

/** A label and a value on one line, the label in a fixed column. */
export function field(label: string, value: readonly Span[] | string, width: number, labelWidth = 14): ScreenLine {
  const line = new LineBuilder(width).add(label.padEnd(labelWidth), "muted");
  if (typeof value === "string") {
    line.add(value);
  } else {
    for (const span of value) {
      line.add(span.text, span.style);
    }
  }
  return line.build();
}
