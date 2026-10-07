/**
 * What the terminal can draw, decided once at startup.
 *
 * Colour depth and glyph set are separate questions. `NO_COLOR` removes colour
 * and nothing else, so selection and emphasis still show through bold and
 * inverse video; a terminal whose locale is not UTF-8 gets ASCII glyphs whether
 * or not it has colour. Every visual distinction a view makes is carried by a
 * glyph or a position as well as a colour, so nothing is lost in either case.
 */

/** The named styles a view may ask for. The renderer alone turns them into escapes. */
export type StyleName =
  | "normal"
  | "dim"
  | "muted"
  | "strong"
  | "accent"
  | "title"
  | "brand"
  | "tab"
  | "tabActive"
  | "heading"
  | "directory"
  | "symlink"
  | "ok"
  | "warn"
  | "danger"
  | "info"
  | "barUsed"
  | "barWarn"
  | "barDanger"
  | "barReserved"
  | "barEmpty"
  | "series1"
  | "series2"
  | "series3"
  | "series4"
  | "series5"
  | "series6"
  | "key"
  | "border"
  | "band"
  | "input"
  | "badgeOk"
  | "badgeWarn"
  | "badgeDanger"
  | "badgeInfo";

export type ColorDepth = "none" | "16" | "256" | "truecolor";

export interface Glyphs {
  /** Eighth-block steps for a fine bar, from one eighth to a full cell. */
  readonly barSteps: readonly string[];
  readonly barFull: string;
  readonly barEmpty: string;
  /** A second fill for the middle segment of a stacked bar. */
  readonly barShade: string;
  readonly spark: readonly string[];
  readonly spinner: readonly string[];
  readonly ellipsis: string;
  readonly crumb: string;
  readonly home: string;
  readonly directory: string;
  readonly link: string;
  readonly brokenLink: string;
  readonly ok: string;
  readonly fail: string;
  readonly warn: string;
  readonly info: string;
  readonly bullet: string;
  readonly pointer: string;
  readonly separator: string;
  readonly rule: string;
  readonly vertical: string;
  readonly cornerTopLeft: string;
  readonly cornerTopRight: string;
  readonly cornerBottomLeft: string;
  readonly cornerBottomRight: string;
  readonly up: string;
  readonly down: string;
  readonly enter: string;
  readonly brand: string;
  readonly legend: string;
  readonly cursor: string;
}

export interface Theme {
  readonly color: ColorDepth;
  /** True when box-drawing and block characters can be trusted. */
  readonly unicode: boolean;
  readonly glyphs: Glyphs;
}

const UNICODE_GLYPHS: Glyphs = {
  barSteps: ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"],
  barFull: "█",
  barEmpty: "░",
  barShade: "▒",
  spark: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  ellipsis: "…",
  crumb: " › ",
  home: "~",
  directory: "/",
  link: " → ",
  brokenLink: " ⇢ ",
  ok: "✓",
  fail: "✗",
  warn: "▲",
  info: "●",
  bullet: "•",
  pointer: "▌",
  separator: " · ",
  rule: "─",
  vertical: "│",
  cornerTopLeft: "╭",
  cornerTopRight: "╮",
  cornerBottomLeft: "╰",
  cornerBottomRight: "╯",
  up: "↑",
  down: "↓",
  enter: "⏎",
  brand: "◆",
  legend: "■",
  cursor: "█",
};

const ASCII_GLYPHS: Glyphs = {
  barSteps: ["#"],
  barFull: "#",
  barEmpty: ".",
  barShade: "=",
  spark: ["_", ".", "-", "~", "=", "+", "*", "#"],
  spinner: ["|", "/", "-", "\\"],
  ellipsis: "~",
  crumb: " > ",
  home: "~",
  directory: "/",
  link: " -> ",
  brokenLink: " -x ",
  ok: "+",
  fail: "x",
  warn: "!",
  info: "*",
  bullet: "*",
  pointer: ">",
  separator: " | ",
  rule: "-",
  vertical: "|",
  cornerTopLeft: "+",
  cornerTopRight: "+",
  cornerBottomLeft: "+",
  cornerBottomRight: "+",
  up: "^",
  down: "v",
  enter: "Enter",
  brand: "*",
  legend: "#",
  cursor: "_",
};

export function buildTheme(color: ColorDepth, unicode: boolean): Theme {
  return { color, unicode, glyphs: unicode ? UNICODE_GLYPHS : ASCII_GLYPHS };
}

/** Plain text, plain glyphs: what a terminal that promised nothing can still show. */
export const ASCII_THEME: Theme = buildTheme("none", false);
export const COLOR_THEME: Theme = buildTheme("256", true);

export interface TerminalEnvironment {
  readonly NO_COLOR?: string | undefined;
  readonly FORCE_COLOR?: string | undefined;
  readonly TERM?: string | undefined;
  readonly COLORTERM?: string | undefined;
  readonly LANG?: string | undefined;
  readonly LC_ALL?: string | undefined;
  readonly LC_CTYPE?: string | undefined;
  readonly DISKTOP_ASCII?: string | undefined;
}

/**
 * Whether this terminal can be driven as a full-screen application at all.
 *
 * A `dumb` or absent `TERM` cannot address the cursor, so the dashboard is
 * printed as text instead of being drawn over a screen that will not hold it.
 */
export function supportsFullScreen(environment: TerminalEnvironment): boolean {
  const term = environment.TERM;
  return term !== undefined && term !== "" && term !== "dumb";
}

/**
 * Pick the theme for this terminal.
 *
 * `NO_COLOR` follows no-color.org: present and not empty removes colour, and
 * only colour. The glyph set follows the locale, because a terminal decodes
 * what it is sent with the character set the locale names; `TERM=linux` is the
 * kernel console, whose font has no braille or eighth blocks, and
 * `DISKTOP_ASCII=1` forces plain glyphs for anything else that cannot draw them.
 */
export function selectTheme(environment: TerminalEnvironment, isTty: boolean): Theme {
  if (!isTty || !supportsFullScreen(environment)) {
    return ASCII_THEME;
  }
  const term = environment.TERM ?? "";
  const noColor = environment.NO_COLOR !== undefined && environment.NO_COLOR !== "";
  const color: ColorDepth = noColor
    ? "none"
    : /truecolor|direct/i.test(term) || /^(truecolor|24bit)$/i.test(environment.COLORTERM ?? "")
      ? "truecolor"
      : /256/i.test(term)
        ? "256"
        : "16";
  const forcedAscii = environment.DISKTOP_ASCII !== undefined && environment.DISKTOP_ASCII !== "" && environment.DISKTOP_ASCII !== "0";
  const unicode = !forcedAscii && term !== "linux" && localeIsUtf8(environment);
  return buildTheme(color, unicode);
}

/** The effective character set, read the way the C library reads it: LC_ALL, LC_CTYPE, LANG. */
export function localeIsUtf8(environment: TerminalEnvironment): boolean {
  const locale = [environment.LC_ALL, environment.LC_CTYPE, environment.LANG].find(
    (value) => value !== undefined && value !== "",
  );
  return locale !== undefined && /utf-?8/i.test(locale);
}

/**
 * A proportional bar, filled with eighth blocks where the glyph set has them.
 * It is drawn from characters and never from colour alone.
 */
export function usageBar(percent: number, width: number, theme: Theme): { filled: string; empty: string } {
  if (width <= 0) {
    return { filled: "", empty: "" };
  }
  const clamped = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  const steps = theme.glyphs.barSteps.length;
  const eighths = Math.round((clamped / 100) * width * steps);
  const whole = Math.floor(eighths / steps);
  const part = eighths % steps;
  let filled = theme.glyphs.barFull.repeat(whole);
  if (part > 0 && whole < width) {
    filled += theme.glyphs.barSteps[part - 1] as string;
  }
  const used = whole + (part > 0 && whole < width ? 1 : 0);
  return { filled, empty: theme.glyphs.barEmpty.repeat(Math.max(0, width - used)) };
}

/** A sparkline: one cell per value, scaled between the smallest and largest. */
export function sparkline(values: readonly number[], theme: Theme): string {
  if (values.length === 0) {
    return "";
  }
  const levels = theme.glyphs.spark;
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (high === low) {
    return (levels[Math.floor(levels.length / 2)] as string).repeat(values.length);
  }
  return values
    .map((value) => levels[Math.min(levels.length - 1, Math.floor(((value - low) / (high - low)) * (levels.length - 1) + 0.5))] as string)
    .join("");
}
