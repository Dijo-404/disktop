import { runCli, type CliOutput } from "./parser.js";

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

export function bootstrapCli(
  args: readonly string[],
  packageVersion: string,
  nodeVersion: string,
  output: CliOutput,
): number {
  if (!isSupportedNodeVersion(nodeVersion)) {
    output.stderr(
      `Disktop requires Node.js 24.21.0 or later in 24.x, or 26.10.0 or later in 26.x; found ${nodeVersion}.\n`,
    );
    return 2;
  }

  return runCli(args, packageVersion, output);
}
