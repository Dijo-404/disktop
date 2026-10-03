import type { DashboardService, DashboardSettings } from "../application/dashboard.js";
import type { ExploreService } from "../application/explore.js";
import type { ApplyService } from "../application/apply-action.js";
import type { FindService } from "../application/find.js";
import type { FootprintService } from "../application/footprint.js";
import type { PlanService } from "../application/plan-action.js";
import type { ReportService } from "../application/report.js";
import type { UndoService } from "../application/undo.js";
import type { ScanService } from "../application/scan.js";
import type { SnapshotService } from "../application/snapshots.js";
import type { Alert, RawPath, Warning } from "../domain/models.js";
import type { NotificationOutcome } from "../ports/notifications.js";
import type { TimerService } from "../application/timer.js";
import type { Accounting } from "../ports/scan.js";
import type { RetentionLimits } from "../ports/snapshots.js";
import type { CliOutput } from "./parser.js";

export interface AlertNotifications {
  /** Whether config.toml's alerts.notify asks for it without the flag. */
  readonly enabled: boolean;
  notify(alerts: readonly Alert[]): Promise<NotificationOutcome | undefined>;
}

/** The CLI shows what the application already decided; it owns no settings of its own. */
export type CliSettings = DashboardSettings;

export interface ScanDefaults {
  readonly accounting: Accounting;
  readonly crossFilesystems: boolean;
  readonly excludes: readonly RawPath[];
  readonly retention: RetentionLimits;
}

/**
 * The scan, index, and snapshot services a handler may reach, with the scan
 * settings the configuration already resolved.
 */
export interface StorageServices {
  readonly scan: ScanService;
  readonly explore: ExploreService;
  readonly snapshots: SnapshotService;
  readonly defaults: ScanDefaults;
  readonly find: FindDefaults;
}

/** What a search assumes when the command line does not say. */
export interface FindDefaults {
  readonly staleAfterDays: number;
}

/**
 * Interruption, as something a handler asks for rather than reaches for.
 *
 * A long command has to stop cleanly on Ctrl+C, and a test has to be able to
 * drive that without sending itself a signal.
 */
export interface InterruptSource {
  listen(handler: () => void): void;
  stop(handler: () => void): void;
}

/**
 * The reviewed-action pipeline, as the surfaces see it.
 *
 * There is no fifth method and no way around these four: a handler cannot reach
 * a helper, build a plan of its own, or delete anything.
 */
export interface ActionServices {
  readonly plan: PlanService["plan"];
  readonly apply: ApplyService["apply"];
  readonly history: UndoService["history"];
  readonly restore: UndoService["restore"];
  readonly find: FindService["find"];
}

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
  readonly storage: StorageServices;
  /** What the detectors found. Discovery only; nothing here applies anything. */
  readonly footprint: FootprintService;
  /** Reviewing, applying, undoing, and finding. The only path to a mutation. */
  readonly actions: ActionServices;
  /** Gathering a report and publishing it as a new file; it replaces nothing. */
  readonly report: ReportService;
  readonly signals: InterruptSource;
  /** Absent where nothing can show a notification. */
  readonly notifications?: AlertNotifications;
  readonly timer?: TimerService;
  /**
   * What went wrong before any command ran — a configuration file that could
   * not be applied, most of all. A command that lists findings has to say so:
   * somebody whose own cleanup rules were dropped is reading a list that is
   * missing exactly the thing they wrote.
   */
  readonly startupWarnings: readonly Warning[];
  readonly now: () => Date;
  /** Resolve a path the user typed against the working directory. */
  resolvePath(path: string): string;
  /** False when stdout is redirected, which also means no interactive surface. */
  readonly interactive: boolean;
  /**
   * Whether stderr is a terminal. Progress is drawn there and nowhere else:
   * written into a log or a pipe, a carriage-return progress line is noise.
   */
  readonly progress: boolean;
  /** Settings are passed in, so a `--units` given on the command line reaches the TUI. */
  launchTui(settings: CliSettings): Promise<number>;
}
