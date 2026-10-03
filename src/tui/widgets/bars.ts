import type { Span } from "../frame.js";
import { usageBar, type StyleName, type Theme } from "../themes.js";

/** The bar style for a used share: calm, then a warning near the threshold, then danger past it. */
export function usageStyle(percent: number, threshold: number): StyleName {
  if (percent >= threshold) {
    return "barDanger";
  }
  if (percent >= Math.max(0, threshold - 10)) {
    return "barWarn";
  }
  return "barUsed";
}

/** A single proportional bar as spans: the filled part in `style`, the rest dim. */
export function barSpans(percent: number, width: number, theme: Theme, style: StyleName = "barUsed"): Span[] {
  const { filled, empty } = usageBar(percent, width, theme);
  const spans: Span[] = [];
  if (filled !== "") {
    spans.push({ text: filled, style });
  }
  if (empty !== "") {
    spans.push({ text: empty, style: "barEmpty" });
  }
  return spans;
}

/** A share of a whole as a percentage with one decimal where it matters. */
export function sharePercent(part: bigint, whole: bigint): number {
  if (whole <= 0n || part <= 0n) {
    return 0;
  }
  // Basis points keep the arithmetic in bigint until the very end.
  return Number((part * 10_000n) / whole) / 100;
}

export interface Segment {
  readonly value: bigint;
  readonly style: StyleName;
  /** The glyph to fill with, so segments stay distinguishable without colour. */
  readonly glyph?: string;
}

/**
 * Split `width` cells between segments in proportion to their values.
 *
 * Largest-remainder rounding makes the cells add up to exactly `width` when the
 * segments cover the whole, so a stacked bar never ends a cell short or long.
 * A segment too small for half a cell gets none rather than a misleading one.
 */
export function allocateCells(values: readonly bigint[], total: bigint, width: number): number[] {
  if (width <= 0 || total <= 0n) {
    return values.map(() => 0);
  }
  const scaled = values.map((value) => (value <= 0n ? 0n : (value * BigInt(width) * 1000n) / total));
  const cells = scaled.map((value) => Number(value / 1000n));
  const covered = values.reduce((sum, value) => sum + (value > 0n ? value : 0n), 0n);
  const target = Math.min(width, Number((covered * BigInt(width) * 2n + total) / (total * 2n)));
  let assigned = cells.reduce((sum, value) => sum + value, 0);
  const order = scaled
    .map((value, index) => ({ index, remainder: Number(value % 1000n) }))
    .sort((left, right) => right.remainder - left.remainder);
  for (const { index, remainder } of order) {
    if (assigned >= target) {
      break;
    }
    if (remainder >= 500 || (cells[index] as number) > 0) {
      cells[index] = (cells[index] as number) + 1;
      assigned += 1;
    }
  }
  return cells;
}

/** A stacked bar: one run of cells per segment, and the rest drawn empty. */
export function stackedBarSpans(segments: readonly Segment[], total: bigint, width: number, theme: Theme): Span[] {
  const cells = allocateCells(
    segments.map((segment) => segment.value),
    total,
    width,
  );
  const spans: Span[] = [];
  let used = 0;
  for (const [index, segment] of segments.entries()) {
    const count = cells[index] as number;
    if (count > 0) {
      spans.push({ text: (segment.glyph ?? theme.glyphs.barFull).repeat(count), style: segment.style });
      used += count;
    }
  }
  if (used < width) {
    spans.push({ text: theme.glyphs.barEmpty.repeat(width - used), style: "barEmpty" });
  }
  return spans;
}

/** Styles for the series of a distribution, in order of size. */
export const SERIES: readonly StyleName[] = ["series1", "series2", "series3", "series4", "series5", "series6"];

/** Fill glyphs that keep series apart when colour is not available. */
export function seriesGlyph(index: number, theme: Theme): string {
  if (theme.color !== "none") {
    return theme.glyphs.barFull;
  }
  // The empty part of a bar is drawn with the theme's empty glyph, so none of
  // these may be it.
  const glyphs = theme.unicode ? ["█", "▓", "▒", "▚"] : ["#", "=", "+", ":"];
  return glyphs[index % glyphs.length] as string;
}
