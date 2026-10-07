import { LineBuilder, type ScreenLine, type Span } from "../frame.js";
import { cellWidth, sliceCells } from "../text.js";
import type { StyleName, Theme } from "../themes.js";

/**
 * Draw content inside a rounded box, centred in the body at its natural height.
 * A short terminal loses spacing before content. The border takes its tone —
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
  const { above, shown } = boxLayout(content, height, footer !== undefined);
  const lines: ScreenLine[] = Array.from({ length: above }, () => ({ spans: [] }));

  const top = new LineBuilder(width).add(" ".repeat(left)).add(`${glyphs.cornerTopLeft}${glyphs.rule}`, tone);
  top.add(` ${title} `, "title");
  top.add(glyphs.rule.repeat(Math.max(0, left + boxWidth - 1 - top.used)), tone).add(glyphs.cornerTopRight, tone);
  lines.push(top.build());

  for (const line of [...shown, ...(footer === undefined ? [] : [footer])]) {
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
  while (lines.length < height) lines.push({ spans: [] });
  return lines;
}

function boxLayout(content: readonly ScreenLine[], height: number, footer: boolean): { above: number; shown: readonly ScreenLine[] } {
  const room = Math.max(0, height - 2 - (footer ? 1 : 0));
  const compact = content.length > room ? content.filter((line) => line.spans.length > 0) : content;
  const shown = compact.slice(0, room);
  return { above: Math.max(0, Math.floor((height - shown.length - 2 - (footer ? 1 : 0)) / 2)), shown };
}

/** The input footer's row in the same geometry used to draw it. */
export function boxFooterRow(content: readonly ScreenLine[], height: number): number {
  const { above, shown } = boxLayout(content, height, true);
  return above + 1 + shown.length;
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
