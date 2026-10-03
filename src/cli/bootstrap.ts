import { StartupRefused } from "../domain/errors.js";
import { sanitizeText } from "../domain/paths.js";
import type { CliContext } from "./context.js";
import { CommandInterrupted } from "./interrupt.js";
import { EXIT, buildEnvelope, writeEnvelope } from "./output.js";
import type { CliOutput } from "./parser.js";
import { answerFromCommandTable, runCli } from "./run.js";

/** Match the Node versions tested and supported by the CLI. */
export function isSupportedNodeVersion(version: string): boolean {
  const match = /^(24|26)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (match === null) {
    return false;
  }

  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return false;
  }

  return match[1] === "24" ? minor >= 21 : minor >= 10;
}

export const UNSUPPORTED_RUNTIME_EXIT = 2;

/**
 * Refuse an untested runtime before anything reads a device.
 *
 * `engines` only warns unless npm is configured to enforce it, so the check
 * happens here too rather than trusting the installer.
 *
 * Help, the version, and a command line that does not parse are answered from
 * the command table alone, before any service exists. Building services reads
 * the configuration and, as root, verifies the install; none of that is needed
 * to say how Disktop is used, and a refusal there must not stop anybody from
 * reading how to run it properly.
 */
export async function bootstrapCli(
  args: readonly string[],
  nodeVersion: string,
  output: CliOutput,
  buildContext: () => Promise<CliContext>,
  version: string,
): Promise<number> {
  if (!isSupportedNodeVersion(nodeVersion)) {
    output.stderr(
      `Disktop requires Node.js 24.21.0 or later in 24.x, or 26.10.0 or later in 26.x; found ${sanitizeText(nodeVersion)}.\n`,
    );
    return UNSUPPORTED_RUNTIME_EXIT;
  }

  const answered = answerFromCommandTable(args, output, version, new Date());
  if (answered !== undefined) {
    return answered;
  }

  try {
    return await runCli(args, await buildContext());
  } catch (error) {
    return reportUnexpected(args, output, error);
  }
}

/**
 * Turn an unexpected failure into the envelope shape every other outcome uses.
 *
 * Without this a bad `--cursor` reaches the terminal as a stack trace, with
 * nothing on stdout and exit `1` — which in Disktop's own exit codes means
 * "alert threshold reached", so a script cannot tell a crash from a full disk.
 * Only the message is kept, made safe to print: a stack trace says nothing a
 * user can act on, and a message can quote a filename that commands a terminal.
 */
export function reportUnexpected(args: readonly string[], output: CliOutput, error: unknown): number {
  const message = sanitizeText(error instanceof Error ? error.message : "The command failed for an unknown reason.");
  const interrupted = error instanceof CommandInterrupted;
  const failure =
    error instanceof StartupRefused
      ? { ...error.failure, message: sanitizeText(error.failure.message) }
      : { code: interrupted ? ("cancelled" as const) : ("internal-error" as const), message };
  const exitCode = interrupted ? EXIT.interrupted : EXIT.operationalError;
  if (args.includes("--json")) {
    writeEnvelope(
      output.stdout,
      buildEnvelope({
        command: "disktop",
        generatedAt: new Date(),
        status: "error",
        exitCode,
        warnings: [],
        failure,
      }),
    );
  } else {
    output.stderr(
      error instanceof StartupRefused || interrupted
        ? `${failure.message}\n`
        : `Disktop could not complete that command: ${message}\n`,
    );
  }
  return exitCode;
}
