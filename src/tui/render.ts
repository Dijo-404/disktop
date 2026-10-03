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
 * SGR parameters for each style at each colour depth. Empty means "no
 * attributes".
 *
 * The terminal's own background may be dark or light, and Disktop cannot ask
 * which. So plain text keeps the terminal's default foreground, emphasis is
 * bold rather than a brighter grey, and colours are mid-tones that read on
 * either. Where Disktop sets a background itself — the header band, the
 * selected row — it sets the foreground too, from the `onDark` table, so the
 * pair is legible whatever the terminal's own colours are.
 */
const PALETTE_16: Readonly<Record<StyleName, string>> = {
  normal: "",
  dim: "2",
  muted: "90",
  strong: "1",
  accent: "36",
  title: "1",
  brand: "1;36",
  tab: "",
  tabActive: "1;30;46",
  heading: "1",
  directory: "1;36",
  symlink: "35",
  ok: "32",
  warn: "33",
  danger: "1;31",
  info: "36",
  barUsed: "36",
  barWarn: "33",
  barDanger: "31",
  barReserved: "90",
  barEmpty: "90",
  series1: "36",
  series2: "35",
  series3: "34",
  series4: "33",
  series5: "32",
  series6: "90",
  key: "1;36",
  border: "90",
  band: "",
  input: "1;4",
  badgeOk: "1;30;42",
  badgeWarn: "1;30;43",
  badgeDanger: "1;97;41",
  badgeInfo: "1;30;46",
};

const PALETTE_256: Readonly<Record<StyleName, string>> = {
  normal: "",
  dim: "38;5;245",
  muted: "38;5;243",
  strong: "1",
  accent: "38;5;33",
  title: "1",
  brand: "1;38;5;33",
  tab: "38;5;244",
  tabActive: "1;38;5;16;48;5;75",
  heading: "1;38;5;244",
  directory: "1;38;5;33",
  symlink: "38;5;133",
  ok: "38;5;35",
  warn: "38;5;172",
  danger: "1;38;5;160",
  info: "38;5;32",
  barUsed: "38;5;33",
  barWarn: "38;5;172",
  barDanger: "38;5;160",
  barReserved: "38;5;244",
  barEmpty: "38;5;246",
  series1: "38;5;33",
  series2: "38;5;133",
  series3: "38;5;35",
  series4: "38;5;172",
  series5: "38;5;166",
  series6: "38;5;244",
  key: "1;38;5;33",
  border: "38;5;246",
  band: "",
  input: "1;4",
  badgeOk: "1;38;5;16;48;5;78",
  badgeWarn: "1;38;5;16;48;5;214",
  badgeDanger: "1;38;5;231;48;5;160",
  badgeInfo: "1;38;5;16;48;5;110",
};

/** Foregrounds for text on a background Disktop set: always light on dark. */
const ON_DARK_16: Partial<Record<StyleName, string>> = {
  normal: "97",
  dim: "37",
  muted: "37",
  strong: "1;97",
  title: "1;97",
  heading: "1;97",
  tab: "97",
  accent: "96",
  brand: "1;96",
  directory: "1;96",
  key: "1;96",
  barEmpty: "37",
  border: "37",
};

const ON_DARK_256: Partial<Record<StyleName, string>> = {
  normal: "38;5;255",
  dim: "38;5;250",
  muted: "38;5;247",
  strong: "1;38;5;231",
  title: "1;38;5;231",
  heading: "1;38;5;250",
  tab: "38;5;250",
  accent: "38;5;75",
  brand: "1;38;5;75",
  directory: "1;38;5;117",
  key: "1;38;5;75",
  ok: "38;5;114",
  warn: "38;5;214",
  danger: "1;38;5;203",
  info: "38;5;111",
  barUsed: "38;5;75",
  barWarn: "38;5;214",
  barDanger: "38;5;203",
  barEmpty: "38;5;242",
  barReserved: "38;5;245",
  series1: "38;5;75",
  series2: "38;5;176",
  series3: "38;5;114",
  series4: "38;5;221",
  series5: "38;5;209",
  series6: "38;5;250",
  symlink: "38;5;176",
  border: "38;5;242",
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

function sgrFor(style: StyleName, theme: Theme, onDark: boolean): string {
  switch (theme.color) {
    case "none":
      return NO_COLOR_ATTRIBUTES[style] ?? "";
    case "16":
      return (onDark ? ON_DARK_16[style] : undefined) ?? PALETTE_16[style];
    case "256":
      return (onDark ? ON_DARK_256[style] : undefined) ?? PALETTE_256[style];
  }
}

/** The background laid under every span of a selected row. */
function selectionSgr(theme: Theme): string {
  switch (theme.color) {
    case "none":
      return "7";
    case "16":
      return "44";
    case "256":
      return "48;5;24";
  }
}

/** The background laid under every span of the header band. */
function bandSgr(theme: Theme): string {
  return theme.color === "256" ? "48;5;236" : theme.color === "16" ? "40" : "";
}

/**
 * Serialize one row to the characters and escapes that draw it, padded or cut
 * to exactly `columns` cells. Every span is cleaned of control characters here
 * as the last line of defence; this is the only function that emits SGR.
 */
export function serializeLine(line: ScreenLine, columns: number, theme: Theme): string {
  const under = line.selected === true ? selectionSgr(theme) : line.fill === "band" ? bandSgr(theme) : "";
  const onDark = under !== "" && theme.color !== "none";
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
    const sgr = [under, sgrFor(span.style, theme, onDark)].filter((part) => part !== "").join(";");
    out += sgr === "" ? `${ESC}0m${text}` : `${ESC}0;${sgr}m${text}`;
    used += cellWidth(text);
  }
  if (used < columns) {
    const fill = line.fill !== undefined && line.fill !== "band" ? sgrFor(line.fill, theme, onDark) : "";
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
