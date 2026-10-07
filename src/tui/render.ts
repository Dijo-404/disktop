import type { Terminal } from "terminal-kit";
import type { Frame, ScreenLine, ScreenSize } from "./frame.js";
import { cellWidth, sliceCells, stripControls } from "./text.js";
import type { StyleName, Theme } from "./themes.js";

export interface MouseEvent {
  readonly kind: "click" | "wheel-up" | "wheel-down";
  /** Zero-based cell coordinates. */
  readonly column: number;
  readonly row: number;
}

/**
 * The only thing a view may ask a terminal to do.
 *
 * Views build frames of styled text; nothing above this interface writes an
 * escape sequence, which is what makes the sanitized display strings from
 * `domain/paths.ts` meaningful. ADR 0001 keeps the library behind this boundary.
 */
export interface Renderer {
  size(): ScreenSize;
  start(): Promise<void>;
  draw(frame: Frame): void;
  onKey(handler: (key: string) => void): void;
  onMouse(handler: (event: MouseEvent) => void): void;
  onResize(handler: () => void): void;
  /**
   * Hand the terminal back for a moment — to let `sudo` ask for a password —
   * and take it again afterwards. Both are idempotent.
   */
  suspend(message?: string): void;
  resume(): void;
  /** Idempotent, and safe to call from a signal handler or an exception path. */
  stop(): void;
}

export interface RendererOptions {
  readonly theme: Theme;
  readonly mouse: boolean;
}

/**
 * Build the terminal-kit renderer. The library is loaded here and only here, so
 * a `--json` run never pays for it and never touches the terminal.
 */
export async function createTerminalRenderer(options: RendererOptions): Promise<Renderer> {
  const { default: terminalKit } = await import("terminal-kit");
  return new TerminalKitRenderer(terminalKit.terminal, options);
}

const ESC = "\u001b[";

/**
 * Catppuccin Mocha: https://catppuccin.com/palette/#mocha.
 * Truecolor uses the original RGB values; 256-colour terminals get the nearest
 * xterm cube/greyscale entry. Owning both foreground and background keeps the
 * dark palette readable even when the terminal normally has a light theme.
 */
const MOCHA = {
  base: ["30;30;46", 235],
  mantle: ["24;24;37", 234],
  surface0: ["49;50;68", 237],
  surface1: ["69;71;90", 239],
  text: ["205;214;244", 189],
  subtext1: ["186;194;222", 146],
  subtext0: ["166;173;200", 146],
  overlay0: ["108;112;134", 243],
  mauve: ["203;166;247", 183],
  red: ["243;139;168", 211],
  peach: ["250;179;135", 216],
  yellow: ["249;226;175", 223],
  green: ["166;227;161", 151],
  teal: ["148;226;213", 116],
  blue: ["137;180;250", 111],
  lavender: ["180;190;254", 147],
} as const;

type MochaColor = keyof typeof MOCHA;
type PaletteDepth = "256" | "truecolor";

function mochaSgr(color: MochaColor, depth: PaletteDepth, background = false): string {
  const [rgb, indexed] = MOCHA[color];
  return `${background ? 48 : 38};${depth === "truecolor" ? `2;${rgb}` : `5;${indexed}`}`;
}

function mochaPalette(depth: PaletteDepth): Readonly<Record<StyleName, string>> {
  const fg = (color: MochaColor, attributes = ""): string => `${attributes}${mochaSgr(color, depth)}`;
  const badge = (color: MochaColor): string => `1;${fg("base")};${mochaSgr(color, depth, true)}`;
  return {
    normal: fg("text"),
    dim: fg("subtext0"),
    muted: fg("subtext1"),
    strong: fg("text", "1;"),
    accent: fg("mauve"),
    title: fg("text", "1;"),
    brand: fg("mauve", "1;"),
    tab: fg("subtext0"),
    tabActive: badge("mauve"),
    heading: fg("lavender", "1;"),
    directory: fg("blue", "1;"),
    symlink: fg("lavender"),
    ok: fg("green"),
    warn: fg("yellow"),
    danger: fg("red", "1;"),
    info: fg("blue"),
    barUsed: fg("teal"),
    barWarn: fg("yellow"),
    barDanger: fg("red"),
    barReserved: fg("subtext0"),
    barEmpty: fg("overlay0"),
    series1: fg("teal"),
    series2: fg("mauve"),
    series3: fg("blue"),
    series4: fg("peach"),
    series5: fg("green"),
    series6: fg("subtext0"),
    key: fg("mauve", "1;"),
    border: fg("overlay0"),
    band: fg("text"),
    input: `${fg("text", "1;4;")};${mochaSgr("surface1", depth, true)}`,
    badgeOk: badge("green"),
    badgeWarn: badge("yellow"),
    badgeDanger: badge("red"),
    badgeInfo: badge("blue"),
  };
}

const PALETTE_TRUECOLOR = mochaPalette("truecolor");
const PALETTE_256 = mochaPalette("256");

/** ANSI approximations retain Mocha's semantic colours and a dark surface. */
const PALETTE_16: Readonly<Record<StyleName, string>> = {
  normal: "97",
  dim: "37",
  muted: "37",
  strong: "1;97",
  accent: "95",
  title: "1;97",
  brand: "1;95",
  tab: "37",
  tabActive: "1;30;105",
  heading: "1;94",
  directory: "1;94",
  symlink: "95",
  ok: "92",
  warn: "93",
  danger: "1;91",
  info: "94",
  barUsed: "96",
  barWarn: "93",
  barDanger: "91",
  barReserved: "90",
  barEmpty: "90",
  series1: "96",
  series2: "95",
  series3: "94",
  series4: "93",
  series5: "92",
  series6: "37",
  key: "1;95",
  border: "90",
  band: "97",
  input: "1;4;97",
  badgeOk: "1;30;102",
  badgeWarn: "1;30;103",
  badgeDanger: "1;30;101",
  badgeInfo: "1;30;104",
};

const NO_COLOR_ATTRIBUTES: Partial<Record<StyleName, string>> = {
  title: "1",
  strong: "1",
  heading: "1",
  brand: "1",
  key: "1",
  danger: "1",
  directory: "1",
  badgeDanger: "1;7",
  tabActive: "7",
  badgeInfo: "7",
  badgeWarn: "7",
  badgeOk: "7",
  input: "4",
};

function sgrFor(style: StyleName, theme: Theme): string {
  switch (theme.color) {
    case "none":
      return NO_COLOR_ATTRIBUTES[style] ?? "";
    case "16":
      return PALETTE_16[style];
    case "256":
      return PALETTE_256[style];
    case "truecolor":
      return PALETTE_TRUECOLOR[style];
  }
}

/** The background laid under every span of a selected row. */
function selectionSgr(theme: Theme): string {
  switch (theme.color) {
    case "none":
      return "7";
    case "16":
      return "100";
    case "256":
      return mochaSgr("surface0", "256", true);
    case "truecolor":
      return mochaSgr("surface0", "truecolor", true);
  }
}

/** The background laid under every span of the header band. */
function bandSgr(theme: Theme): string {
  return theme.color === "none" ? "" : theme.color === "16" ? "40" : mochaSgr("mantle", theme.color, true);
}

/** The base surface fills ordinary rows, including their trailing cells. */
function baseSgr(theme: Theme): string {
  return theme.color === "none" ? "" : theme.color === "16" ? "40" : mochaSgr("base", theme.color, true);
}

/**
 * Serialize one row to the characters and escapes that draw it, padded or cut
 * to exactly `columns` cells. Every span is cleaned of control characters here
 * as the last line of defence; this is the only function that emits SGR.
 */
export function serializeLine(line: ScreenLine, columns: number, theme: Theme): string {
  const under = line.selected === true ? selectionSgr(theme) : line.fill === "band" ? bandSgr(theme) : baseSgr(theme);
  let out = "";
  let used = 0;
  for (const span of line.spans) {
    if (used >= columns) {
      break;
    }
    const clean = stripControls(span.text);
    const text = cellWidth(clean) <= columns - used ? clean : sliceCells(clean, columns - used);
    if (text === "") {
      continue;
    }
    const sgr = [under, sgrFor(span.style, theme)].filter((part) => part !== "").join(";");
    out += sgr === "" ? `${ESC}0m${text}` : `${ESC}0;${sgr}m${text}`;
    used += cellWidth(text);
  }
  if (used < columns) {
    const fill = line.fill !== undefined && line.fill !== "band" ? sgrFor(line.fill, theme) : "";
    const sgr = [under, fill].filter((part) => part !== "").join(";");
    out += `${sgr === "" ? `${ESC}0m` : `${ESC}0;${sgr}m`}${" ".repeat(columns - used)}`;
  }
  return `${out}${ESC}0m`;
}

class TerminalKitRenderer implements Renderer {
  readonly #terminal: Terminal;
  readonly #options: RendererOptions;
  #started = false;
  #stopped = false;
  #suspended = false;
  /** What each row last showed, so only rows that changed are written. */
  #previous: string[] = [];
  #previousSize = "";
  #keyHandlers: ((key: string) => void)[] = [];
  #mouseHandlers: ((event: MouseEvent) => void)[] = [];
  #resizeHandlers: (() => void)[] = [];
  readonly #onKey = (name: string): void => {
    for (const handler of this.#keyHandlers) handler(name);
  };
  readonly #onMouse = (name: string, data: { x: number; y: number }): void => {
    const kind = name === "MOUSE_LEFT_BUTTON_PRESSED" ? "click" : name === "MOUSE_WHEEL_UP" ? "wheel-up" : name === "MOUSE_WHEEL_DOWN" ? "wheel-down" : undefined;
    if (kind === undefined) {
      return;
    }
    for (const handler of this.#mouseHandlers) handler({ kind, column: data.x - 1, row: data.y - 1 });
  };
  readonly #onResize = (): void => {
    this.#previous = [];
    for (const handler of this.#resizeHandlers) handler();
  };

  constructor(terminal: Terminal, options: RendererOptions) {
    this.#terminal = terminal;
    this.#options = options;
  }

  size(): ScreenSize {
    return { columns: this.#terminal.width, rows: this.#terminal.height };
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#terminal.on("key", this.#onKey);
    this.#terminal.on("mouse", this.#onMouse);
    this.#terminal.on("resize", this.#onResize);
    this.#take();
  }

  #take(): void {
    this.#terminal.fullscreen(true);
    this.#terminal.hideCursor(true);
    this.#terminal.grabInput(this.#options.mouse ? { mouse: "button" } : {});
    this.#previous = [];
  }

  #release(): void {
    this.#terminal.grabInput(false);
    this.#terminal.hideCursor(false);
    this.#terminal.styleReset();
    this.#terminal.fullscreen(false);
  }

  /**
   * Write only the rows that changed, in one write, so a refresh never flashes
   * the whole screen. The last cell of the last row is left alone: writing it
   * makes some terminals scroll.
   */
  draw(frame: Frame): void {
    if (this.#stopped || this.#suspended || !this.#started) {
      return;
    }
    const { columns, rows } = this.size();
    const sizeKey = `${columns}x${rows}`;
    let out = "";
    if (sizeKey !== this.#previousSize) {
      this.#previous = [];
      this.#previousSize = sizeKey;
      out += `${ESC}0m${ESC}2J`;
    }
    for (let row = 0; row < rows; row += 1) {
      const line = frame.lines[row] ?? { spans: [] };
      const width = row === rows - 1 ? Math.max(0, columns - 1) : columns;
      const serialized = serializeLine(line, width, this.#options.theme);
      if (this.#previous[row] !== serialized) {
        out += `${ESC}${row + 1};1H${serialized}`;
        this.#previous[row] = serialized;
      }
    }
    if (frame.cursor !== undefined) {
      out += `${ESC}${frame.cursor.row + 1};${frame.cursor.column + 1}H${ESC}?25h`;
    } else {
      out += `${ESC}?25l`;
    }
    if (out !== "") {
      // noFormat: terminal-kit would otherwise read `%` and `^` in a filename
      // as its own format and markup syntax.
      this.#terminal.noFormat(out);
    }
  }

  onKey(handler: (key: string) => void): void {
    this.#keyHandlers.push(handler);
  }

  onMouse(handler: (event: MouseEvent) => void): void {
    this.#mouseHandlers.push(handler);
  }

  onResize(handler: () => void): void {
    this.#resizeHandlers.push(handler);
  }

  suspend(message?: string): void {
    if (!this.#started || this.#stopped || this.#suspended) {
      return;
    }
    this.#suspended = true;
    this.#release();
    if (message !== undefined) {
      this.#terminal.noFormat(stripControls(message.replace(/\n/g, " ")) + "\n");
    }
  }

  resume(): void {
    if (!this.#suspended || this.#stopped) {
      return;
    }
    this.#suspended = false;
    this.#take();
    this.#previousSize = "";
  }

  /**
   * Put the terminal back exactly as it was found. This runs on a normal exit,
   * on a signal, and after an uncaught exception, so a crash never leaves a
   * user with a hidden cursor and a grabbed keyboard.
   */
  stop(): void {
    if (this.#stopped || !this.#started) {
      this.#stopped = true;
      return;
    }
    this.#stopped = true;
    this.#terminal.off("key", this.#onKey);
    this.#terminal.off("mouse", this.#onMouse);
    this.#terminal.off("resize", this.#onResize);
    this.#keyHandlers = [];
    this.#mouseHandlers = [];
    this.#resizeHandlers = [];
    if (!this.#suspended) {
      this.#release();
    } else {
      this.#terminal.styleReset();
    }
  }
}
