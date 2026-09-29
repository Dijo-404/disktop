import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { posix } from "node:path";
import type { Capability } from "../../domain/models.js";

/** Trusted directories a system tool may be resolved from, in order. */
const TRUSTED_DIRECTORIES = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;

export interface CommandOutcome {
  readonly capability: Capability;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export interface CommandLimits {
  readonly timeoutMilliseconds: number;
  readonly maxOutputBytes: number;
}

export const DEFAULT_LIMITS: CommandLimits = { timeoutMilliseconds: 10_000, maxOutputBytes: 8 * 1024 * 1024 };

/**
 * Resolve a tool to an absolute path inside a trusted directory.
 *
 * `PATH` is not consulted: a tool Disktop runs must be the system's, not
 * whichever executable happens to come first in the caller's environment.
 */
export async function resolveTrustedExecutable(name: string): Promise<string | undefined> {
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    throw new RangeError(`'${name}' is not a plain executable name`);
  }
  for (const directory of TRUSTED_DIRECTORIES) {
    const candidate = posix.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Run a system tool with a fixed argument vector and no shell.
 *
 * Nothing here interpolates a path or a user string into a command line; the
 * arguments are literal values chosen by the adapter that calls this.
 */
export async function runFixedCommand(
  name: string,
  commandArguments: readonly string[],
  limits: CommandLimits = DEFAULT_LIMITS,
): Promise<CommandOutcome> {
  const executable = await resolveTrustedExecutable(name);
  if (executable === undefined) {
    return {
      capability: { status: "missing-tool", explanation: `${name} was not found in ${TRUSTED_DIRECTORIES.join(", ")}.` },
      stdout: "",
      stderr: "",
      exitCode: null,
    };
  }

  return new Promise((resolve) => {
    execFile(
      executable,
      [...commandArguments],
      {
        timeout: limits.timeoutMilliseconds,
        maxBuffer: limits.maxOutputBytes,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        env: { PATH: TRUSTED_DIRECTORIES.join(":"), LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ capability: { status: "available", explanation: `${executable} responded.` }, stdout, stderr, exitCode: 0 });
          return;
        }
        resolve({ capability: failureCapability(executable, error, stderr), stdout, stderr, exitCode: exitCodeOf(error) });
      },
    );
  });
}

/** execFile reports a spawn failure as a string errno and an exit status as a number. */
interface ExecFailure {
  readonly code?: string | number | null;
  readonly message: string;
}

function failureCapability(executable: string, error: ExecFailure, stderr: string): Capability {
  if (error.code === "ENOENT") {
    return { status: "missing-tool", explanation: `${executable} disappeared before it could run.` };
  }
  if (error.code === "EACCES" || error.code === "EPERM" || /permission denied|not permitted/i.test(stderr)) {
    return { status: "permission-denied", explanation: `${executable} could not be run by this user.` };
  }
  const detail = stderr.trim().split("\n")[0] ?? error.message;
  return { status: "missing-tool", explanation: `${executable} failed: ${detail}` };
}

function exitCodeOf(error: ExecFailure): number | null {
  return typeof error.code === "number" ? error.code : null;
}
