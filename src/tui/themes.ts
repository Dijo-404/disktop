export type StyleName = "normal" | "header" | "tab" | "selected" | "alert" | "dim";

export interface Theme {
  readonly color: boolean;
  /** Box-drawing characters are replaced when the terminal cannot be trusted with them. */
  readonly ascii: boolean;
  readonly barFull: string;
  readonly barEmpty: string;
}

export const ASCII_THEME: Theme = { color: false, ascii: true, barFull: "#", barEmpty: "." };
export const COLOR_THEME: Theme = { color: true, ascii: false, barFull: "█", barEmpty: "░" };

export interface TerminalEnvironment {
  readonly NO_COLOR?: string | undefined;
  readonly TERM?: string | undefined;
}

/**
 * `NO_COLOR` is honoured whatever its value, as the convention requires, and a
 * `dumb` or absent `TERM` also drops to plain ASCII rather than betting that
 * the terminal understands block characters.
 */
export function selectTheme(environment: TerminalEnvironment, isTty: boolean): Theme {
  const term = environment.TERM;
  if (!isTty || environment.NO_COLOR !== undefined || term === undefined || term === "" || term === "dumb") {
    return ASCII_THEME;
  }
  return COLOR_THEME;
}

/** A proportional bar drawn from the theme's characters, never from colour alone. */
export function usageBar(percent: number, width: number, theme: Theme): string {
  if (width <= 0) {
    return "";
  }
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return theme.barFull.repeat(filled) + theme.barEmpty.repeat(width - filled);
}
