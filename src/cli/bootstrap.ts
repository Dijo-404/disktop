import type { CliContext } from "./context.js";
import type { CliOutput } from "./parser.js";
import { runCli } from "./run.js";

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
 */
export async function bootstrapCli(
  args: readonly string[],
  nodeVersion: string,
  output: CliOutput,
  buildContext: () => Promise<CliContext>,
): Promise<number> {
  if (!isSupportedNodeVersion(nodeVersion)) {
    output.stderr(
      `Disktop requires Node.js 24.21.0 or later in 24.x, or 26.10.0 or later in 26.x; found ${nodeVersion}.\n`,
    );
    return UNSUPPORTED_RUNTIME_EXIT;
  }

  return runCli(args, await buildContext());
}
