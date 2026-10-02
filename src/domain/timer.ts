export const TIMER_MARKER = "# Managed by Disktop. 'disktop timer uninstall' removes it.";
export const SERVICE_UNIT = "disktop-alerts.service";
export const TIMER_UNIT = "disktop-alerts.timer";

/** The only arguments the timer passes: it checks alerts and never cleans. */
export const TIMER_ARGUMENTS: readonly string[] = ["alerts", "check", "--notify"];

export interface EntryPoint {
  readonly node: string;
  readonly script: string;
}

export interface TimerUnits {
  readonly service: string;
  readonly timer: string;
}

/** One ExecStart= word: quoted, with systemd's specifiers and variables doubled. */
export function quoteExecArgument(value: string): string {
  if (value === "" || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RangeError("A path holding a control character cannot be written into a unit file");
  }
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$$$");
  return `"${escaped}"`;
}

export function renderUnits(entry: EntryPoint): TimerUnits {
  const command = [quoteExecArgument(entry.node), quoteExecArgument(entry.script), ...TIMER_ARGUMENTS].join(" ");
  return {
    service: [
      TIMER_MARKER,
      "[Unit]",
      "Description=Disktop low-space alert check",
      "",
      "[Service]",
      "Type=oneshot",
      `ExecStart=${command}`,
      "",
    ].join("\n"),
    timer: [
      TIMER_MARKER,
      "[Unit]",
      "Description=Run the Disktop alert check hourly",
      "",
      "[Timer]",
      "OnCalendar=hourly",
      "RandomizedDelaySec=300",
      "Persistent=true",
      "",
      "[Install]",
      "WantedBy=timers.target",
      "",
    ].join("\n"),
  };
}
