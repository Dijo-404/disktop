import { execFile } from "node:child_process";
import { sanitizeText } from "../../../domain/paths.js";
import type { NotificationPort } from "../../../ports/notifications.js";
import { resolveTrustedExecutable } from "../process.js";

export interface NotifySendOptions {
  readonly resolve?: (name: string) => Promise<string | undefined>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly execute?: (program: string, argv: readonly string[], env: Readonly<Record<string, string>>) => Promise<{ readonly exitCode: number | null; readonly stderr: string }>;
}

const PASSED = ["DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "HOME"];

export function createNotifySend(options: NotifySendOptions = {}): NotificationPort {
  const resolve = options.resolve ?? resolveTrustedExecutable;
  const environment = options.environment ?? process.env;
  const execute = options.execute ?? run;
  return {
    id: "notify-send",
    async send(title, body) {
      if (environment.DBUS_SESSION_BUS_ADDRESS === undefined) {
        return { sent: false, explanation: "No desktop session bus is reachable, so there is nowhere to show a notification." };
      }
      const program = await resolve("notify-send");
      if (program === undefined) {
        return { sent: false, explanation: "notify-send is not installed in a trusted system directory." };
      }
      const env: Record<string, string> = { PATH: "/usr/bin:/bin", LC_ALL: "C" };
      for (const name of PASSED) {
        const value = environment[name];
        if (value !== undefined) {
          env[name] = value;
        }
      }
      const outcome = await execute(program, ["--app-name=Disktop", "--urgency=critical", "--", title, body], env);
      return outcome.exitCode === 0
        ? { sent: true, explanation: "Sent through notify-send." }
        : { sent: false, explanation: `notify-send failed: ${sanitizeText(outcome.stderr.trim().split("\n")[0] ?? "")}` };
    },
  };
}

function run(program: string, argv: readonly string[], env: Readonly<Record<string, string>>): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(program, [...argv], { shell: false, timeout: 10_000, env: { ...env }, encoding: "utf8" }, (error, _stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      resolvePromise({ exitCode: error === null ? 0 : typeof code === "number" ? code : null, stderr });
    });
  });
}
