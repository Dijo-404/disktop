import type { ManagerCommand, ManagerPrivilege } from "../domain/managers.js";

export interface CommandRun {
  readonly status: "ran" | "denied" | "missing-tool" | "cancelled";
  readonly exitCode: number | null;
  /** The last 4 KiB of what the command printed, sanitized. */
  readonly output: string;
  readonly explanation: string;
}

export interface RunOptions {
  readonly interactive: boolean;
  readonly signal: AbortSignal;
}

/** Runs one derived manager command, escalating only that command when it needs root. */
export interface CommandRunner {
  run(command: ManagerCommand, privilege: ManagerPrivilege, options: RunOptions): Promise<CommandRun>;
}
