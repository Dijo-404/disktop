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

/** SGR parameters for each style at each colour depth. Empty means "no attributes". */
function sgrFor(style: StyleName, theme: Theme): string {
  if (theme.color === "none") {
    switch (style) {
      case "title":
      case "strong":
      case "heading":
      case "brand":
      case "key":
      case "danger":
      case "badgeDanger":
        return "1";
      case "tabActive":
      case "badgeInfo":
      case "badgeWarn":
      case "badgeOk":
        return "7";
      case "input":
        return "4";
      default:
        return "";
    }
  }
  if (theme.color === "16") {
    switch (style) {
      case "normal":
        return "";
      case "dim":
        return "37";
      case "muted":
      case "border":
      case "barEmpty":
      case "barReserved":
        return "90";
      case "strong":
        return "1";
      case "accent":
      case "barUsed":
      case "series1":
      case "directory":
        return "36";
      case "title":
      case "brand":
        return "1;36";
      case "heading":
        return "1;37";
      case "tab":
        return "37";
      case "tabActive":
        return "1;30;46";
      case "symlink":
      case "series2":
        return "35";
      case "series3":
        return "34";
      case "series4":
        return "33";
      case "series5":
        return "32";
      case "series6":
        return "37";
      case "ok":
        return "32";
      case "warn":
      case "barWarn":
        return "33";
      case "danger":
      case "barDanger":
        return "1;31";
      case "info":
        return "36";
      case "key":
        return "1;36";
      case "band":
        return "";
      case "input":
        return "1;4";
      case "badgeOk":
        return "1;30;42";
      case "badgeWarn":
        return "1;30;43";
      case "badgeDanger":
        return "1;37;41";
      case "badgeInfo":
        return "1;30;46";
    }
  }
  switch (style) {
    case "normal":
      return "38;5;252";
    case "dim":
      return "38;5;248";
    case "muted":
      return "38;5;242";
    case "strong":
      return "1;38;5;255";
    case "accent":
    case "barUsed":
    case "series1":
      return "38;5;75";
    case "directory":
      return "38;5;117";
    case "title":
      return "1;38;5;255";
    case "brand":
      return "1;38;5;75";
    case "heading":
      return "1;38;5;246";
    case "tab":
      return "38;5;246";
    case "tabActive":
      return "1;38;5;16;48;5;75";
    case "symlink":
    case "series2":
      return "38;5;176";
    case "series3":
      return "38;5;114";
    case "series4":
      return "38;5;221";
    case "series5":
      return "38;5;209";
    case "series6":
      return "38;5;245";
    case "ok":
      return "38;5;114";
    case "warn":
    case "barWarn":
      return "38;5;214";
    case "danger":
    case "barDanger":
      return "1;38;5;203";
    case "info":
      return "38;5;111";
    case "barReserved":
      return "38;5;240";
    case "barEmpty":
      return "38;5;237";
    case "key":
      return "1;38;5;75";
    case "border":
      return "38;5;239";
    case "band":
      return "48;5;235";
    case "input":
      return "1;4;38;5;255";
    case "badgeOk":
      return "1;38;5;16;48;5;114";
    case "badgeWarn":
      return "1;38;5;16;48;5;214";
    case "badgeDanger":
      return "1;38;5;255;48;5;160";
    case "badgeInfo":
      return "1;38;5;16;48;5;110";
  }
}

/** The selection background, laid under every span of a selected row. */
function selectionSgr(theme: Theme): string {
  switch (theme.color) {
    case "none":
      return "7";
    case "16":
      return "44";
    case "256":
      return "48;5;237";
  }
}

/** The header band background, laid under every span of a banded row. */
function bandSgr(theme: Theme): string {
  return theme.color === "256" ? "48;5;235" : theme.color === "16" ? "" : "";
}

/**
 * Serialize one row to the characters and escapes that draw it, padded or cut
 * to exactly `columns` cells. Every span is cleaned of control characters here
 * as the last line of defence; this is the only function that emits SGR.
 */
export function serializeLine(line: ScreenLine, columns: number, theme: Theme): string {
  const under = line.selected === true ? selectionSgr(theme) : line.fill === "band" ? bandSgr(theme) : "";
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
