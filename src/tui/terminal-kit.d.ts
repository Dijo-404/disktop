/**
 * The slice of `terminal-kit` the renderer adapter uses. The library ships no
 * types, and ADR 0001 keeps it behind `Renderer`, so this declares only what
 * that one adapter touches rather than the library's whole surface.
 */
declare module "terminal-kit" {
  interface MouseData {
    readonly x: number;
    readonly y: number;
  }

  interface Terminal {
    (text: string): void;
    readonly width: number;
    readonly height: number;
    /** Write text exactly as given: no `%` format or `^` markup interpretation. */
    noFormat(text: string): void;
    fullscreen(enabled: boolean): void;
    grabInput(options: false | { mouse?: string }): void;
    hideCursor(enabled?: boolean): void;
    styleReset(): void;
    on(event: "key", handler: (name: string) => void): void;
    on(event: "mouse", handler: (name: string, data: MouseData) => void): void;
    on(event: "resize", handler: (width: number, height: number) => void): void;
    off(event: string, handler: (...args: never[]) => void): void;
  }

  const terminalKit: { readonly terminal: Terminal };
  export default terminalKit;
  export type { Terminal };
}
