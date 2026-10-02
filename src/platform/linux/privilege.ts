import { spawn as spawnProcess } from "node:child_process";
import { MANAGER_TOOLS, type ManagerPrivilege } from "../../domain/managers.js";
import { sanitizeText } from "../../domain/paths.js";
import type { CommandRun, CommandRunner } from "../../ports/managers.js";
import { resolveTrustedExecutable } from "./process.js";

export interface Escalation {
  readonly kind: "none" | "sudo" | "pkexec";
  readonly argv: readonly string[];
}

export interface EscalationFacts {
  readonly euid: number;
  readonly interactive: boolean;
  readonly sudo?: string;
  readonly pkexec?: string;
}

const NONE: Escalation = { kind: "none", argv: [] };

export function escalationFor(
  privilege: ManagerPrivilege,
  facts: EscalationFacts,
): Escalation | { readonly refusal: string } {
  if (privilege === "user" || facts.euid === 0) {
    return NONE;
  }
  if (facts.sudo !== undefined) {
    return { kind: "sudo", argv: [facts.sudo, ...(facts.interactive ? [] : ["-n"]), "--"] };
  }
  if (facts.pkexec !== undefined && facts.interactive) {
    return { kind: "pkexec", argv: [facts.pkexec] };
  }
  return {
    refusal:
      "This needs administrator rights and neither sudo nor pkexec can ask for them here. Nothing was run.",
  };
}

/** sudo prefixes its own messages with "sudo:"; pkexec exits 126 or 127 when not authorised. */
export function deniedByEscalation(kind: Escalation["kind"], exitCode: number | null, stderr: string): boolean {
  if (kind === "sudo") {
    return exitCode === 1 && stderr.split("\n").some((line) => line.startsWith("sudo:"));
  }
  if (kind === "pkexec") {
    return exitCode === 126 || exitCode === 127;
  }
  return false;
}

export interface SpawnResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal?: string | null;
  readonly error?: string;
}

export interface SpawnOptions {
  readonly interactive: boolean;
  readonly signal: AbortSignal;
  readonly timeoutMilliseconds: number;
  readonly env: Readonly<Record<string, string>>;
}

export type SpawnLike = (program: string, argv: readonly string[], options: SpawnOptions) => Promise<SpawnResult>;

export interface RunnerOptions {
  readonly spawn?: SpawnLike;
  readonly euid?: number;
  readonly resolve?: (name: string) => Promise<string | undefined>;
  readonly timeoutMilliseconds?: number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

const TRUSTED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const PASSED_THROUGH = ["HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "DOCKER_HOST", "CONTAINER_HOST"];
const OUTPUT_BYTES = 4096;
const CAPTURE_BYTES = 64 * 1024;

export function createCommandRunner(options: RunnerOptions = {}): CommandRunner {
  const spawn = options.spawn ?? spawnCommand;
  const resolve = options.resolve ?? resolveTrustedExecutable;
  const euid = options.euid ?? process.geteuid?.() ?? -1;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 30 * 60_000;
  const environment = options.environment ?? process.env;
  const env: Record<string, string> = { PATH: TRUSTED_PATH, LC_ALL: "C" };
  for (const name of PASSED_THROUGH) {
    const value = environment[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }

  return {
    async run(command, privilege, runOptions) {
      if (!MANAGER_TOOLS.includes(command.tool)) {
        return outcome("missing-tool", null, "", `'${command.tool}' is not a manager tool Disktop runs.`);
      }
      const executable = await resolve(command.tool);
      if (executable === undefined) {
        return outcome("missing-tool", null, "", `${command.tool} is not installed in a trusted system directory.`);
      }
      const escalation = escalationFor(privilege, {
        euid,
        interactive: runOptions.interactive,
        ...(await optional("sudo", resolve)),
        ...(await optional("pkexec", resolve)),
      });
      if ("refusal" in escalation) {
        return outcome("denied", null, "", escalation.refusal);
      }

      const [program, ...prefix] = escalation.kind === "none" ? [executable] : escalation.argv;
      const argv = escalation.kind === "none" ? [...command.arguments] : [...prefix, executable, ...command.arguments];
      const result = await spawn(program as string, argv, {
        interactive: runOptions.interactive,
        signal: runOptions.signal,
        timeoutMilliseconds,
        env,
      });
      const output = tail(`${result.stdout}${result.stderr}`);

      if (runOptions.signal.aborted) {
        return outcome("cancelled", result.exitCode, output, "Stopped while the command was running.");
      }
      if (deniedByEscalation(escalation.kind, result.exitCode, result.stderr)) {
        const reason =
          result.stderr.split("\n").find((line) => line.startsWith("sudo:")) ??
          "The request for administrator rights was refused.";
        return outcome("denied", result.exitCode, output, sanitizeText(reason));
      }
      if (result.error !== undefined) {
        return outcome("missing-tool", result.exitCode, output, sanitizeText(result.error));
      }
      return outcome(
        "ran",
        result.exitCode,
        output,
        result.exitCode === 0 ? `${command.tool} finished.` : `${command.tool} exited with status ${String(result.exitCode)}.`,
      );
    },
  };
}

async function optional(
  name: "sudo" | "pkexec",
  resolve: (name: string) => Promise<string | undefined>,
): Promise<Partial<Record<"sudo" | "pkexec", string>>> {
  const path = await resolve(name);
  return path === undefined ? {} : { [name]: path };
}

function outcome(status: CommandRun["status"], exitCode: number | null, output: string, explanation: string): CommandRun {
  return { status, exitCode, output, explanation };
}

function tail(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  const kept = bytes.length > OUTPUT_BYTES ? bytes.subarray(bytes.length - OUTPUT_BYTES) : bytes;
  return sanitizeText(kept.toString("utf8"));
}

const spawnCommand: SpawnLike = (program, argv, options) =>
  new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    const keep = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      return next.length > CAPTURE_BYTES ? next.slice(next.length - CAPTURE_BYTES) : next;
    };
    const child = spawnProcess(program, [...argv], {
      shell: false,
      env: { ...options.env },
      stdio: [options.interactive ? "inherit" : "ignore", "pipe", "pipe"],
    });
    const stop = (): void => {
      child.kill("SIGTERM");
    };
    const timer = setTimeout(stop, options.timeoutMilliseconds);
    options.signal.addEventListener("abort", stop, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = keep(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = keep(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", stop);
      resolvePromise({ exitCode: null, stdout, stderr, error: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", stop);
      resolvePromise({ exitCode: code, stdout, stderr, signal });
    });
  });
