import type { Terminal } from "terminal-kit";
import type { ScreenLine, ScreenSize } from "./views/disks.js";
import type { StyleName, Theme } from "./themes.js";

/**
 * The only thing a view may ask a terminal to do.
 *
 * Views build lines of text and a style name; nothing above this interface can
 * write an escape sequence, which is what makes the sanitized display strings
 * from `domain/paths.ts` meaningful. ADR 0001 keeps the library choice behind
 * this boundary so a second renderer only has to satisfy the interface.
 */
export interface Renderer {
  size(): ScreenSize;
  start(): Promise<void>;
  draw(lines: readonly ScreenLine[]): void;
  onKey(handler: (key: string) => void): void;
  onResize(handler: () => void): void;
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

class TerminalKitRenderer implements Renderer {
  readonly #terminal: Terminal;
  readonly #options: RendererOptions;
  #started = false;
  #stopped = false;

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
    this.#terminal.fullscreen(true);
    this.#terminal.hideCursor(true);
    this.#terminal.grabInput(this.#options.mouse ? { mouse: "button" } : {});
  }

  draw(lines: readonly ScreenLine[]): void {
    if (this.#stopped) {
      return;
    }
    this.#terminal.moveTo(1, 1);
    this.#terminal.eraseDisplay();
    for (const [index, line] of lines.entries()) {
      this.#terminal.moveTo(1, index + 1);
      this.#write(line);
    }
  }

  onKey(handler: (key: string) => void): void {
    this.#terminal.on("key", handler);
  }

  onResize(handler: () => void): void {
    this.#terminal.on("resize", () => handler());
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
    this.#terminal.removeAllListeners("key");
    this.#terminal.removeAllListeners("resize");
    this.#terminal.grabInput(false);
    this.#terminal.hideCursor(false);
    this.#terminal.styleReset();
    this.#terminal.fullscreen(false);
  }

  #write(line: ScreenLine): void {
    if (!this.#options.theme.color) {
      this.#terminal(line.text);
      return;
    }
    styleFor(this.#terminal, line.style)(line.text);
  }
}

function styleFor(terminal: Terminal, style: StyleName): (text: string) => void {
  switch (style) {
    case "header":
      return (text) => terminal.bold.cyan(text);
    case "tab":
      return (text) => terminal.bold(text);
    case "selected":
      return (text) => terminal.inverse(text);
    case "alert":
      return (text) => terminal.bold.red(text);
    case "dim":
      return (text) => terminal.dim(text);
    case "normal":
      return (text) => terminal(text);
  }
}
