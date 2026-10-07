import type { TimerUnits } from "../domain/timer.js";
import type { Capability, RawPath } from "../domain/models.js";
import type { OperationFailure } from "../domain/errors.js";

export type UnitState = "written" | "removed" | "absent" | "kept-foreign";

export interface TimerOutcome {
  readonly capability: Capability;
  readonly units: readonly { readonly name: string; readonly path: RawPath; readonly state: UnitState }[];
  readonly enabled: boolean;
  /** True when a unit Disktop did not write stopped the install before anything changed. */
  readonly refused: boolean;
  /** A failed systemd command must not be presented as a successful change. */
  readonly failure?: OperationFailure;
}

export interface UserTimerPort {
  install(units: TimerUnits): Promise<TimerOutcome>;
  uninstall(): Promise<TimerOutcome>;
}
