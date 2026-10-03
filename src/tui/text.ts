/**
 * Terminal cell arithmetic.
 *
 * A column is a terminal cell, not a UTF-16 code unit. A CJK name or an emoji
 * takes two cells and a combining accent takes none, so measuring with
 * `string.length` misaligns every column after the first wide filename and can
 * push the right edge of a row off the screen. Everything that lays out text in
 * the TUI measures with `cellWidth` and cuts with the functions here.
 */

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Characters a terminal draws in two cells: East Asian wide and fullwidth forms. */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x231a && code <= 0x231b) ||
    (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x23e9 && code <= 0x23ec) ||
    code === 0x23f0 ||
    code === 0x23f3 ||
    (code >= 0x25fd && code <= 0x25fe) ||
    (code >= 0x2614 && code <= 0x2615) ||
    (code >= 0x2648 && code <= 0x2653) ||
    code === 0x267f ||
    code === 0x2693 ||
    code === 0x26a1 ||
    (code >= 0x26aa && code <= 0x26ab) ||
    (code >= 0x26bd && code <= 0x26be) ||
    (code >= 0x26c4 && code <= 0x26c5) ||
    code === 0x26ce ||
    code === 0x26d4 ||
    code === 0x26ea ||
    (code >= 0x26f2 && code <= 0x26f3) ||
    code === 0x26f5 ||
    code === 0x26fa ||
    code === 0x26fd ||
    code === 0x2705 ||
    (code >= 0x270a && code <= 0x270b) ||
    code === 0x2728 ||
    code === 0x274c ||
    code === 0x274e ||
    (code >= 0x2753 && code <= 0x2755) ||
    code === 0x2757 ||
    (code >= 0x2795 && code <= 0x2797) ||
    code === 0x27b0 ||
    code === 0x27bf ||
    (code >= 0x2b1b && code <= 0x2b1c) ||
    code === 0x2b50 ||
    code === 0x2b55 ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x16fe0 && code <= 0x16fe4) ||
    (code >= 0x17000 && code <= 0x18cff) ||
    (code >= 0x1b000 && code <= 0x1b2ff) ||
    (code >= 0x1f004 && code <= 0x1f004) ||
    code === 0x1f0cf ||
    code === 0x1f18e ||
    (code >= 0x1f191 && code <= 0x1f19a) ||
    (code >= 0x1f200 && code <= 0x1f251) ||
    (code >= 0x1f260 && code <= 0x1f265) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f680 && code <= 0x1f6ff) ||
    (code >= 0x1f7e0 && code <= 0x1f7eb) ||
    (code >= 0x1f90c && code <= 0x1f9ff) ||
    (code >= 0x1fa70 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** Marks and joiners that attach to the character before them and take no cell. */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\u200b-\u200d\u2060\ufe00-\ufe0f\u{e0100}-\u{e01ef}]$/u;

function graphemeWidth(grapheme: string): number {
  const first = grapheme.codePointAt(0) ?? 0;
  if (first < 0x20 || (first >= 0x7f && first < 0xa0)) {
    // A control character never reaches here from a sanitized display string;
    // if one did, the renderer replaces it, and it is counted as one cell.
    return 1;
  }
  if (ZERO_WIDTH.test(String.fromCodePoint(first))) {
    return 0;
  }
  if (isWide(first)) {
    return 2;
  }
  // A text-presentation symbol followed by VS16 is drawn as emoji.
  if (grapheme.includes("\ufe0f") && first >= 0x2000) {
    return 2;
  }
  return 1;
}

/** Whether every character is printable ASCII, which needs no segmentation. */
function isPlainAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

/** How many terminal cells `text` occupies. */
export function cellWidth(text: string): number {
  if (isPlainAscii(text)) {
    return text.length;
  }
  let width = 0;
  for (const { segment } of segmenter.segment(text)) {
    width += graphemeWidth(segment);
  }
  return width;
}

/**
 * The longest prefix of `text` that fits in `width` cells. A wide character
 * that would straddle the edge is dropped whole rather than split in half.
 */
export function sliceCells(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (isPlainAscii(text)) {
    return text.slice(0, width);
  }
  let used = 0;
  let result = "";
  for (const { segment } of segmenter.segment(text)) {
    const next = graphemeWidth(segment);
    if (used + next > width) {
      break;
    }
    used += next;
    result += segment;
  }
  return result;
}

/** The longest suffix of `text` that fits in `width` cells. */
function sliceCellsFromEnd(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (isPlainAscii(text)) {
    return text.slice(Math.max(0, text.length - width));
  }
  const graphemes = Array.from(segmenter.segment(text), ({ segment }) => segment);
  let used = 0;
  let start = graphemes.length;
  while (start > 0) {
    const next = graphemeWidth(graphemes[start - 1] as string);
    if (used + next > width) {
      break;
    }
    used += next;
    start -= 1;
  }
  return graphemes.slice(start).join("");
}

/**
 * Fit `text` in `width` cells, ending in an ellipsis when something was cut so
 * a reader can tell a trimmed name from a short one.
 */
export function truncate(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) {
    return "";
  }
  if (cellWidth(text) <= width) {
    return text;
  }
  const mark = cellWidth(ellipsis);
  if (width <= mark) {
    return sliceCells(text, width);
  }
  return `${sliceCells(text, width - mark)}${ellipsis}`;
}

/**
 * Fit a path in `width` cells by cutting its middle, so both where it starts
 * and the name it ends in stay readable.
 */
export function truncateMiddle(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) {
    return "";
  }
  if (cellWidth(text) <= width) {
    return text;
  }
  const mark = cellWidth(ellipsis);
  if (width <= mark + 2) {
    return truncate(text, width, ellipsis);
  }
  const room = width - mark;
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return `${sliceCells(text, head)}${ellipsis}${sliceCellsFromEnd(text, tail)}`;
}

/** Fit a path by keeping its end, which is the part that names the thing. */
export function truncateStart(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) {
    return "";
  }
  if (cellWidth(text) <= width) {
    return text;
  }
  const mark = cellWidth(ellipsis);
  if (width <= mark) {
    return sliceCellsFromEnd(text, width);
  }
  return `${ellipsis}${sliceCellsFromEnd(text, width - mark)}`;
}

/** Pad or cut `text` to exactly `width` cells, left-aligned. */
export function padEnd(text: string, width: number, ellipsis = "…"): string {
  const fitted = truncate(text, width, ellipsis);
  return fitted + " ".repeat(Math.max(0, width - cellWidth(fitted)));
}

/** Pad or cut `text` to exactly `width` cells, right-aligned. */
export function padStart(text: string, width: number, ellipsis = "…"): string {
  const fitted = truncate(text, width, ellipsis);
  return " ".repeat(Math.max(0, width - cellWidth(fitted))) + fitted;
}

/** Centre `text` in `width` cells. */
export function center(text: string, width: number, ellipsis = "…"): string {
  const fitted = truncate(text, width, ellipsis);
  const spare = Math.max(0, width - cellWidth(fitted));
  const left = Math.floor(spare / 2);
  return " ".repeat(left) + fitted + " ".repeat(spare - left);
}

/**
 * Replace anything a terminal would act on rather than draw.
 *
 * Paths reach the TUI already sanitized by `domain/paths.ts`. Messages from
 * detectors, managers, and errors may quote a tool's output, so every span is
 * cleaned once more at the last moment: C0 and C1 controls, DEL, and the
 * bidirectional overrides that let one string render as another.
 */
export function stripControls(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, "\ufffd");
}

/** Wrap prose into lines of at most `width` cells, breaking at spaces where it can. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) {
    return [];
  }
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter((part) => part.length > 0)) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (cellWidth(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line !== "") {
        lines.push(line);
      }
      // A word longer than the line is cut rather than allowed to overflow.
      let rest = word;
      while (cellWidth(rest) > width) {
        const head = sliceCells(rest, width);
        lines.push(head);
        rest = rest.slice(head.length);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

/** `1,234,567` — a count a person can read at a glance. */
export function groupDigits(value: bigint | number): string {
  const digits = (typeof value === "bigint" ? value : BigInt(Math.trunc(value))).toString(10);
  const negative = digits.startsWith("-");
  const body = negative ? digits.slice(1) : digits;
  const grouped = body.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${grouped}` : grouped;
}

/** A short "how long ago" for a nanosecond or millisecond timestamp. */
export function relativeAge(thenMilliseconds: number, nowMilliseconds: number): string {
  const seconds = Math.max(0, Math.floor((nowMilliseconds - thenMilliseconds) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 60) {
    return `${days}d ago`;
  }
  const months = Math.floor(days / 30);
  if (months < 24) {
    return `${months}mo ago`;
  }
  return `${Math.floor(days / 365)}y ago`;
}

/** Nanoseconds since the epoch, as a millisecond number fit for date arithmetic. */
export function nanosecondsToMilliseconds(value: bigint): number {
  return Number(value / 1_000_000n);
}
