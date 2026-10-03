import type { InterruptSource } from "./context.js";
import type { CliOutput } from "./parser.js";

/** The part of a writable stream the CLI's output depends on. */
export interface WritableLike {
  readonly destroyed: boolean;
  write(chunk: string): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface GuardedOutput extends CliOutput {
  /** Whether anything has been written to stdout, so a late failure does not add a second envelope. */
  wroteStdout(): boolean;
  /**
   * A stdout failure other than its reader going away. The exit status has to
   * report it: the command may have succeeded, but nobody received its answer.
   */
  failure(): string | undefined;
}

/**
 * stdout and stderr that survive their reader going away.
 *
 * `disktop devices | head -1` closes the pipe after one line, and the next
 * write fails with EPIPE. Without a listener Node raises that as an uncaught
 * exception, prints a stack trace, and exits 1 — which in Disktop's codes
 * means an alert threshold was reached. A reader that left is not a failure
 * of the command, so further output is dropped and the command finishes and
 * exits with its own status. Any other write failure, such as a full disk
 * behind a redirect, is remembered so the exit status can say so.
 */
export function guardStreams(stdout: WritableLike, stderr: WritableLike): GuardedOutput {
  let stdoutOpen = true;
  let stderrOpen = true;
  let wrote = false;
  let failure: string | undefined;

  stdout.on("error", (error) => {
    stdoutOpen = false;
    if (!isBrokenPipe(error)) {
      failure ??= error.message;
    }
  });
  stderr.on("error", () => {
    stderrOpen = false;
  });

  return {
    stdout(message) {
      if (stdoutOpen && !stdout.destroyed) {
        wrote = true;
        stdout.write(message);
      }
    },
    stderr(message) {
      if (stderrOpen && !stderr.destroyed) {
        stderr.write(message);
      }
    },
    wroteStdout: () => wrote,
    failure: () => failure,
  };
}

function isBrokenPipe(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

/** The signals that ask a running command to stop. */
export const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export interface SignalEmitter {
  on(signal: (typeof INTERRUPT_SIGNALS)[number], listener: () => void): unknown;
  off(signal: (typeof INTERRUPT_SIGNALS)[number], listener: () => void): unknown;
}

/**
 * Interruption as a command asks for it.
 *
 * The first Ctrl+C asks the command to stop at its next safe boundary, and the
 * command still reports and journals what it did. A second one does not tear
 * the process down halfway through an item, which is the one moment a record
 * could stop matching the disk; it says the command is already stopping.
 * Every listener a command adds is removed again when it stops listening.
 */
export function createInterruptSource(emitter: SignalEmitter, stderr: (message: string) => void): InterruptSource {
  const registered = new Map<() => void, () => void>();
  return {
    listen(handler) {
      if (registered.has(handler)) {
        return;
      }
      let received = 0;
      const listener = (): void => {
        received += 1;
        if (received === 1) {
          handler();
        } else if (received === 2) {
          stderr("\nStill stopping: the current item finishes first, so the record of what was done stays exact.\n");
        }
      };
      registered.set(handler, listener);
      for (const signal of INTERRUPT_SIGNALS) {
        emitter.on(signal, listener);
      }
    },
    stop(handler) {
      const listener = registered.get(handler);
      if (listener === undefined) {
        return;
      }
      registered.delete(handler);
      for (const signal of INTERRUPT_SIGNALS) {
        emitter.off(signal, listener);
      }
    },
  };
}
