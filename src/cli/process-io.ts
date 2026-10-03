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
