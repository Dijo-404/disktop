import { execFile } from "node:child_process";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Capability } from "../../../domain/models.js";
import { rawPathFromUtf8, sanitizeText } from "../../../domain/paths.js";
import { SERVICE_UNIT, TIMER_MARKER, TIMER_UNIT } from "../../../domain/timer.js";
import type { TimerOutcome, UnitState, UserTimerPort } from "../../../ports/timer.js";
import { readOwnFile, writeFileAtomically } from "../../../storage/files.js";
import { resolveTrustedExecutable } from "../process.js";

/** A unit file Disktop wrote is a few hundred bytes; anything far larger is not one. */
const MAX_UNIT_BYTES = 64 * 1024;

export type Systemctl = (commandArguments: readonly string[]) => Promise<{ readonly exitCode: number | null; readonly stderr: string }>;

export interface SystemdTimerOptions {
  readonly unitDirectory: string;
  readonly systemctl?: Systemctl;
}

const UNIT_MODE = 0o644;

export function createSystemdUserTimer(options: SystemdTimerOptions): UserTimerPort {
  const systemctl = options.systemctl ?? runSystemctl;
  const names = [SERVICE_UNIT, TIMER_UNIT] as const;
  const pathOf = (name: string): string => join(options.unitDirectory, name);

  async function probe(): Promise<Capability> {
    const answer = await systemctl(["--user", "show-environment"]);
    return answer.exitCode === 0
      ? { status: "available", explanation: "A systemd user instance answered." }
      : {
          status: "missing-tool",
          explanation: `No systemd user instance is reachable: ${sanitizeText(answer.stderr.trim().split("\n")[0] ?? "")}`,
        };
  }

  async function ownership(name: string): Promise<"absent" | "ours" | "foreign"> {
    try {
      // A pipe or a device in a unit's place is not Disktop's, and is not
      // waited on to find that out.
      const text = await readOwnFile(pathOf(name), MAX_UNIT_BYTES, { followSymlinks: true });
      return text.startsWith(TIMER_MARKER) ? "ours" : "foreign";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "foreign";
    }
  }

  const outcome = (capability: Capability, states: readonly UnitState[], enabled: boolean, refused = false): TimerOutcome => ({
    capability,
    units: names.map((name, index) => ({ name, path: rawPathFromUtf8(pathOf(name)), state: states[index] as UnitState })),
    enabled,
    refused,
  });

  const commandFailure = (result: TimerOutcome, command: string, stderr: string, recovery: string): TimerOutcome => ({
    ...result,
    failure: {
      code: /permission|access denied|authentication/i.test(stderr) ? "permission-denied" : "internal-error",
      message: `systemctl --user ${command} failed: ${sanitizeText(stderr.trim().slice(0, 2048)) || "no diagnostic was returned"}. ${recovery}`,
    },
  });

  return {
    async install(units) {
      const capability = await probe();
      if (capability.status !== "available") {
        return outcome(capability, ["absent", "absent"], false);
      }
      const owners = await Promise.all(names.map(ownership));
      if (owners.includes("foreign")) {
        return outcome(
          capability,
          owners.map((owner) => (owner === "foreign" ? "kept-foreign" : owner === "ours" ? "written" : "absent")),
          false,
          true,
        );
      }
      await mkdir(options.unitDirectory, { recursive: true, mode: 0o755 });
      await writeFileAtomically(pathOf(SERVICE_UNIT), units.service, UNIT_MODE);
      await writeFileAtomically(pathOf(TIMER_UNIT), units.timer, UNIT_MODE);
      const reloaded = await systemctl(["--user", "daemon-reload"]);
      if (reloaded.exitCode !== 0) {
        return commandFailure(outcome(capability, ["written", "written"], false), "daemon-reload", reloaded.stderr,
          "The units were written but were not enabled. Retry 'disktop timer install' when the user instance is reachable.");
      }
      const enabled = await systemctl(["--user", "enable", "--now", TIMER_UNIT]);
      return enabled.exitCode === 0
        ? outcome(capability, ["written", "written"], true)
        : commandFailure(outcome(capability, ["written", "written"], false), `enable --now ${TIMER_UNIT}`, enabled.stderr,
            "The units remain installed; retry 'disktop timer install' after resolving the systemd error.");
    },

    async uninstall() {
      const capability = await probe();
      const owners = await Promise.all(names.map(ownership));
      if (owners.includes("foreign")) {
        return outcome(
          capability,
          owners.map((owner) => (owner === "foreign" ? "kept-foreign" : owner === "ours" ? "written" : "absent")),
          false,
          true,
        );
      }
      if (capability.status === "available" && owners[1] === "ours") {
        const disabled = await systemctl(["--user", "disable", "--now", TIMER_UNIT]);
        if (disabled.exitCode !== 0) {
          return commandFailure(outcome(capability, owners.map((owner) => owner === "ours" ? "written" : "absent"), true),
            `disable --now ${TIMER_UNIT}`, disabled.stderr,
            "The units were kept because the timer could still be running. Retry 'disktop timer uninstall' after resolving the systemd error.");
        }
      }
      const states: UnitState[] = [];
      for (const [index, name] of names.entries()) {
        const owner = owners[index];
        if (owner === "ours") {
          await unlink(pathOf(name));
          states.push("removed");
        } else {
          states.push(owner === "foreign" ? "kept-foreign" : "absent");
        }
      }
      if (capability.status === "available") {
        const reloaded = await systemctl(["--user", "daemon-reload"]);
        if (reloaded.exitCode !== 0) {
          return commandFailure(outcome(capability, states, false), "daemon-reload", reloaded.stderr,
            "The timer was stopped and the units removed. Run 'systemctl --user daemon-reload' to refresh the user instance.");
        }
      }
      return outcome(capability, states, false);
    },
  };
}

const runSystemctl: Systemctl = async (commandArguments) => {
  const program = await resolveTrustedExecutable("systemctl");
  if (program === undefined) {
    return { exitCode: null, stderr: "systemctl is not installed in a trusted system directory." };
  }
  return new Promise((resolvePromise) => {
    execFile(
      program,
      [...commandArguments],
      { shell: false, timeout: 30_000, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
      (error, _stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolvePromise({ exitCode: error === null ? 0 : typeof code === "number" ? code : null, stderr });
      },
    );
  });
};
