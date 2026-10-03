import type { ApplyService } from "../application/apply-action.js";
import type { DashboardService } from "../application/dashboard.js";
import type { ExploreService } from "../application/explore.js";
import type { FindService } from "../application/find.js";
import type { FootprintService } from "../application/footprint.js";
import type { PlanService } from "../application/plan-action.js";
import type { ScanService } from "../application/scan.js";
import type { SnapshotService } from "../application/snapshots.js";
import type { UndoService } from "../application/undo.js";
import type { RawPath } from "../domain/models.js";
import type { RetentionLimits } from "../ports/snapshots.js";

/**
 * Everything the TUI may reach: application services, already built.
 *
 * It is the same set the CLI handlers receive, minus output. There is no way
 * from here to a helper, an adapter, or a Linux command; the dependency rule
 * enforces that, and this interface is why the TUI never needs to.
 */
export interface TuiServices {
  readonly dashboard: DashboardService;
  readonly scan: ScanService;
  readonly explore: ExploreService;
  readonly snapshots: SnapshotService;
  readonly find: FindService;
  readonly footprint: FootprintService;
  readonly plan: PlanService["plan"];
  readonly apply: ApplyService["apply"];
  readonly history: UndoService["history"];
  readonly restore: UndoService["restore"];
  readonly defaults: {
    readonly excludes: readonly RawPath[];
    readonly retention: RetentionLimits;
    readonly staleAfterDays: number;
  };
  /** Where a first scan starts when nothing has been scanned yet. */
  readonly home: RawPath;
  readonly now: () => Date;
}
