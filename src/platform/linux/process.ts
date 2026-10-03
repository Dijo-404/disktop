import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { posix } from "node:path";
import type { Capability } from "../../domain/models.js";
import { sanitizeText } from "../../domain/paths.js";

/** Trusted directories a system tool may be resolved from, in order. */
const TRUSTED_DIRECTORIES = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;

/** The only `PATH` any tool Disktop runs ever sees. */
export const TRUSTED_PATH = TRUSTED_DIRECTORIES.join(":");

/**
 * The variables a tool may inherit from the caller, and nothing else.
 *
 * They are the ones that decide which user session, bus, and container daemon
 * a tool talks to. Everything else — a library preload, a proxy, a secret in
 * an unrelated variable — stays behind. Queries and manager commands take the
 * same set, so a container cleanup is previewed and verified against the same
 * daemon it is applied to: docker reads its current context from the home
 * directory and `DOCKER_CONTEXT`, and its address from `DOCKER_HOST`.
 */
const PASSED_THROUGH = [
  "HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "CONTAINER_HOST",
] as const;

/** The environment every tool runs with: a trusted PATH, the C locale, and the session variables above. */
export function toolEnvironment(environment: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = { PATH: TRUSTED_PATH, LC_ALL: "C" };
  for (const name of PASSED_THROUGH) {
    const value = environment[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

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
 * How long a killed query's pipes may stay open. A tool that left a child
 * behind holding them would otherwise keep the caller waiting on a process
 * Disktop never started.
 */
const DRAIN_MILLISECONDS = 1_000;

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
 * arguments are literal values chosen by the adapter that calls this. The tool
 * reads no input, its output is bounded, and one that outlives its time limit
 * is killed outright: a query that ignores SIGTERM must not hold a listing
 * open forever.
 */
export async function runFixedCommand(
  name: string,
  commandArguments: readonly string[],
  limits: CommandLimits = DEFAULT_LIMITS,
  environment: Readonly<Record<string, string | undefined>> = process.env,
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
    let child: ChildProcess;
    try {
      child = spawn(executable, [...commandArguments], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: toolEnvironment(environment),
      });
    } catch (error) {
      resolve(spawnFailure(executable, error));
      return;
    }

    const stdout = new BoundedCapture(limits.maxOutputBytes);
    const stderr = new BoundedCapture(limits.maxOutputBytes);
    let stopped: string | undefined;
    let drain: NodeJS.Timeout | undefined;
    let settled = false;

    const settle = (outcome: CommandOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      resolve(outcome);
    };
    const stop = (reason: string): void => {
      if (stopped !== undefined) {
        return;
      }
      stopped = reason;
      child.kill("SIGKILL");
      drain = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(finish(executable, null, stdout.text(), stderr.text(), stopped));
      }, DRAIN_MILLISECONDS);
    };
    const timer = setTimeout(
      () => stop(`${executable} did not finish within ${limits.timeoutMilliseconds} ms and was stopped.`),
      limits.timeoutMilliseconds,
    );

    child.stdout?.on("data", (chunk: Buffer) => {
      if (!stdout.add(chunk)) {
        stop(`${executable} wrote more than ${limits.maxOutputBytes} bytes and was stopped.`);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.add(chunk);
    });
    child.on("error", (error) => settle(spawnFailure(executable, error)));
    child.on("close", (code, signal) =>
      settle(finish(executable, code, stdout.text(), stderr.text(), stopped ?? (signal === null ? undefined : `${executable} was terminated by ${signal}.`))),
    );
  });
}

/** Bytes kept up to a bound; whatever arrives past it is dropped and reported. */
class BoundedCapture {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;

  constructor(readonly limit: number) {}

  /** False once the bound is reached; the chunk that crossed it is kept only up to the bound. */
  add(chunk: Buffer): boolean {
    const room = this.limit - this.#bytes;
    if (chunk.length > room) {
      if (room > 0) {
        this.#chunks.push(chunk.subarray(0, room));
        this.#bytes += room;
      }
      return false;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.length;
    return true;
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}

function finish(
  executable: string,
  exitCode: number | null,
  stdout: string,
  stderr: string,
  stopped: string | undefined,
): CommandOutcome {
  if (stopped !== undefined) {
    return { capability: { status: "missing-tool", explanation: stopped }, stdout, stderr, exitCode };
  }
  if (exitCode === 0) {
    return { capability: { status: "available", explanation: `${executable} responded.` }, stdout, stderr, exitCode };
  }
  if (/permission denied|not permitted/i.test(stderr)) {
    return {
      capability: { status: "permission-denied", explanation: `${executable} could not be run by this user.` },
      stdout,
      stderr,
      exitCode,
    };
  }
  const detail = sanitizeText(stderr.trim().split("\n")[0] || `exited with status ${String(exitCode)}`);
  return { capability: { status: "missing-tool", explanation: `${executable} failed: ${detail}` }, stdout, stderr, exitCode };
}

function spawnFailure(executable: string, error: unknown): CommandOutcome {
  const code = (error as NodeJS.ErrnoException).code;
  const capability: Capability =
    code === "ENOENT"
      ? { status: "missing-tool", explanation: `${executable} disappeared before it could run.` }
      : code === "EACCES" || code === "EPERM"
        ? { status: "permission-denied", explanation: `${executable} could not be run by this user.` }
        : { status: "missing-tool", explanation: `${executable} could not be started: ${sanitizeText(String((error as Error).message))}` };
  return { capability, stdout: "", stderr: "", exitCode: null };
}
