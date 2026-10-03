import type { OperationFailure } from "../domain/errors.js";
import type { CliContext } from "./context.js";
import { EXIT } from "./output.js";

/**
 * What a command raised after it had been asked to stop.
 *
 * Once Ctrl+C has been pressed, a helper that went away or an operation that
 * gave up is the interruption doing what it was asked, not a crash, and it is
 * reported that way: exit 130, failure code `cancelled`.
 */
export class CommandInterrupted extends Error {
  constructor(cause: unknown) {
    super(
      `Stopped by an interrupt before it finished: ${cause instanceof Error ? cause.message : "no further detail"}`,
    );
    this.name = "CommandInterrupted";
  }
}

export interface Interruptible<T> {
  readonly value: T;
  /** Whether Ctrl+C (or SIGTERM, or a hangup) arrived while the work ran. */
  readonly interrupted: boolean;
}

/**
 * Run one command's work with Ctrl+C wired to its abort signal.
 *
 * The listener is removed however the work ends, so a command never leaves a
 * signal handler behind for whatever runs next in the same process.
 */
export async function interruptible<T>(
  context: CliContext,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<Interruptible<T>> {
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  context.signals.listen(interrupt);
  try {
    const value = await work(controller.signal);
    return { value, interrupted: controller.signal.aborted };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new CommandInterrupted(error);
    }
    throw error;
  } finally {
    context.signals.stop(interrupt);
  }
}

/**
 * The exit status of a result an interrupt may have cut short.
 *
 * A partial result after Ctrl+C is reported in full and exits 130. One that
 * finished everything before the interrupt landed keeps its own status:
 * nothing was left undone, so nothing is reported as interrupted.
 */
export function exitAfter(interrupted: boolean, exitCode: number): number {
  return interrupted && exitCode === EXIT.incomplete ? EXIT.interrupted : exitCode;
}

/**
 * A refusal after Ctrl+C. Whatever else it says, the reason there is no
 * result is that the command was stopped, so that is the code it carries.
 */
export function refusalAfter(
  interrupted: boolean,
  failure: OperationFailure,
): { readonly failure: OperationFailure; readonly exitCode: number } {
  if (!interrupted || failure.code === "cancelled") {
    return { failure, exitCode: interrupted ? EXIT.interrupted : EXIT.operationalError };
  }
  return {
    failure: { code: "cancelled", message: `Stopped by an interrupt before it finished: ${failure.message}` },
    exitCode: EXIT.interrupted,
  };
}
