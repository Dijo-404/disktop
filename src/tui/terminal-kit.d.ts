/**
 * The slice of `terminal-kit` the renderer adapter uses. The library ships no
 * types, and ADR 0001 keeps it behind `Renderer`, so this declares only what
 * that one adapter touches rather than the library's whole surface.
 */
declare module "terminal-kit" {
  interface TerminalStyle {
    (text: string): void;
    readonly cyan: TerminalStyle;
    readonly red: TerminalStyle;
    readonly yellow: TerminalStyle;
    readonly bold: TerminalStyle;
    readonly dim: TerminalStyle;
    readonly inverse: TerminalStyle;
  }

  interface Terminal {
    (text: string): void;
    readonly width: number;
    readonly height: number;
    fullscreen(enabled: boolean): void;
    grabInput(options: false | { mouse?: string }): void;
    hideCursor(enabled?: boolean): void;
    moveTo(x: number, y: number): void;
    eraseDisplay(): void;
    eraseLine(): void;
    styleReset(): void;
    on(event: "key", handler: (name: string) => void): void;
    on(event: "resize", handler: (width: number, height: number) => void): void;
    removeAllListeners(event?: string): void;
    readonly bold: TerminalStyle;
    readonly dim: TerminalStyle;
    readonly inverse: TerminalStyle;
    readonly red: TerminalStyle;
    readonly yellow: TerminalStyle;
    readonly cyan: TerminalStyle;
  }

  const terminalKit: { readonly terminal: Terminal };
  export default terminalKit;
  export type { Terminal };
}
