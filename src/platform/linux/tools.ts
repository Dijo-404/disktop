import type { ToolOutput, ToolPort } from "../../ports/providers.js";
import { runFixedCommand } from "./process.js";

/**
 * Every system tool a detector may ask for.
 *
 * The list is here rather than at each call site so one reader can see the
 * whole set of commands Disktop is able to run. A name outside it is refused
 * before anything is spawned, which means a typo, a configuration value, or a
 * future detector cannot widen the set by accident.
 */
export const ALLOWED_TOOLS: readonly string[] = [
  "btrfs",
  "conda",
  "docker",
  "dpkg-query",
  "flatpak",
  "journalctl",
  "lsblk",
  "lsof",
  "npm",
  "pacman",
  "pip",
  "pip3",
  "podman",
  "rpm",
  "smartctl",
  "snap",
  "swapon",
  "zfs",
];

export type RunCommand = (name: string, commandArguments: readonly string[]) => Promise<ToolOutput>;

export function createToolPort(run: RunCommand = runFixedCommand): ToolPort {
  const allowed = new Set(ALLOWED_TOOLS);
  return {
    async run(name, commandArguments) {
      if (!allowed.has(name)) {
        return {
          capability: {
            status: "missing-tool",
            explanation: `'${name}' is not a tool Disktop runs. Add it to the allowlist in src/platform/linux/tools.ts to change that.`,
          },
          stdout: "",
          stderr: "",
          exitCode: null,
        };
      }
      return run(name, commandArguments);
    },
  };
}
