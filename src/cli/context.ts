import type { DashboardService, DashboardSettings } from "../application/dashboard.js";
import type { CliOutput } from "./parser.js";

/** The CLI shows what the application already decided; it owns no settings of its own. */
export type CliSettings = DashboardSettings;

/**
 * Everything a command handler is allowed to reach. Services arrive already
 * built, so no CLI module constructs an adapter or decides where data comes
 * from; the composition root does that once.
 */
export interface CliContext {
  readonly version: string;
  readonly output: CliOutput;
  readonly settings: CliSettings;
  readonly dashboard: DashboardService;
  readonly now: () => Date;
  /** False when stdout is redirected, which also means no interactive surface. */
  readonly interactive: boolean;
  /** Settings are passed in, so a `--units` given on the command line reaches the TUI. */
  launchTui(settings: CliSettings): Promise<number>;
}
