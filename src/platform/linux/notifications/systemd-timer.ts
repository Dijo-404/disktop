import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Capability } from "../../../domain/models.js";
import { rawPathFromUtf8, sanitizeText } from "../../../domain/paths.js";
import { SERVICE_UNIT, TIMER_MARKER, TIMER_UNIT } from "../../../domain/timer.js";
import type { TimerOutcome, UnitState, UserTimerPort } from "../../../ports/timer.js";
import { resolveTrustedExecutable } from "../process.js";

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
      const text = await readFile(pathOf(name), "utf8");
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
      await writeAtomically(pathOf(SERVICE_UNIT), units.service);
      await writeAtomically(pathOf(TIMER_UNIT), units.timer);
      await systemctl(["--user", "daemon-reload"]);
      const enabled = await systemctl(["--user", "enable", "--now", TIMER_UNIT]);
      return outcome(capability, ["written", "written"], enabled.exitCode === 0);
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
        await systemctl(["--user", "disable", "--now", TIMER_UNIT]);
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
        await systemctl(["--user", "daemon-reload"]);
      }
      return outcome(capability, states, false);
    },
  };
}

async function writeAtomically(path: string, text: string): Promise<void> {
  const staging = `${path}.${randomBytes(6).toString("hex")}.partial`;
  const handle = await open(staging, "wx", UNIT_MODE);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(staging, UNIT_MODE);
  await rename(staging, path);
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
