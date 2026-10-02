import type { OperationFailure } from "../domain/errors.js";
import type { Warning } from "../domain/models.js";
import { renderUnits, type EntryPoint } from "../domain/timer.js";
import type { TimerOutcome, UserTimerPort } from "../ports/timer.js";

export type TimerResult =
  | { readonly kind: "done"; readonly outcome: TimerOutcome; readonly warnings: readonly Warning[] }
  | { readonly kind: "refused"; readonly failure: OperationFailure };

export interface TimerService {
  install(): Promise<TimerResult>;
  uninstall(): Promise<TimerResult>;
}

export interface TimerDependencies {
  readonly port: UserTimerPort;
  readonly entry: () => EntryPoint;
}

export function createTimerService(dependencies: TimerDependencies): TimerService {
  const settle = (outcome: TimerOutcome, warnings: readonly Warning[]): TimerResult => {
    if (outcome.capability.status !== "available") {
      return { kind: "refused", failure: { code: "unsupported", message: outcome.capability.explanation } };
    }
    if (outcome.refused) {
      const foreign = outcome.units.filter((unit) => unit.state === "kept-foreign").map((unit) => unit.path.display);
      return {
        kind: "refused",
        failure: {
          code: "invalid-input",
          message: `${foreign.join(" and ")} exists and Disktop did not write it, so nothing was changed.`,
        },
      };
    }
    return { kind: "done", outcome, warnings };
  };

  return {
    async install() {
      const entry = dependencies.entry();
      let units;
      try {
        units = renderUnits(entry);
      } catch (error) {
        return { kind: "refused", failure: { code: "invalid-input", message: (error as Error).message } };
      }
      const warnings: Warning[] = entry.script.includes("/_npx/")
        ? [
            {
              code: "ephemeral-install",
              message: "Disktop is running from npx's cache, which can be cleared at any time. Install it globally so the timer keeps working.",
            },
          ]
        : [];
      return settle(await dependencies.port.install(units), warnings);
    },
    async uninstall() {
      const outcome = await dependencies.port.uninstall();
      return outcome.capability.status === "available" || outcome.units.some((unit) => unit.state === "removed")
        ? { kind: "done", outcome, warnings: [] }
        : settle(outcome, []);
    },
  };
}
