import type { Filesystem } from "../../domain/models.js";
import { formatBytes, usedPercentOfInodes, usedPercentOfSpace } from "../../domain/sizes.js";
import { TABS, type AppState } from "../state.js";
import { usageBar, type StyleName, type Theme } from "../themes.js";

export interface ScreenSize {
  readonly columns: number;
  readonly rows: number;
}

export interface ScreenLine {
  readonly text: string;
  readonly style: StyleName;
}

/** The smallest terminal the layout is required to stay readable in. */
export const MINIMUM_SIZE: ScreenSize = { columns: 80, rows: 24 };

const HELP_TEXT = [
  "Keys",
  "  j / k or arrows   move the selection",
  "  g / G             first or last filesystem",
  "  h / l or Tab      previous or next tab",
  "  u                 switch between IEC and SI units",
  "  ?                 open and close this help",
  "  q or Ctrl+C       leave and restore the terminal",
  "",
  "Disktop changes nothing on disk. Scanning and cleanup arrive in later phases.",
];

/**
 * Build the whole screen as text.
 *
 * Every filename reaches this function already sanitized by `domain/paths.ts`,
 * and nothing here emits an escape sequence, so a name can only ever be drawn
 * as text. The size bar and the detail line collapse before the list does, so a
 * narrow terminal loses decoration rather than data.
 */
export function renderDisks(state: AppState, size: ScreenSize, theme: Theme): ScreenLine[] {
  const columns = Math.max(20, size.columns);
  const lines: ScreenLine[] = [];

  lines.push({ text: clip(headerText(state, theme, columns), columns), style: "header" });
  lines.push({ text: clip(tabText(state), columns), style: "tab" });

  if (state.showHelp) {
    for (const line of HELP_TEXT) {
      lines.push({ text: clip(line, columns), style: "normal" });
    }
    return pad(lines, size);
  }

  const reserved = lines.length + footerHeight(state);
  const listRows = Math.max(1, size.rows - reserved);
  const window = windowFor(state.selected, state.view.filesystems.length, listRows);

  if (state.view.filesystems.length === 0) {
    lines.push({ text: clip("No filesystem could be inspected.", columns), style: "dim" });
  }

  for (let index = window.start; index < window.end; index += 1) {
    const filesystem = state.view.filesystems[index] as Filesystem;
    lines.push({
      text: clip(filesystemRow(filesystem, state, theme, columns), columns),
      style: index === state.selected ? "selected" : rowStyle(filesystem, state),
    });
  }

  for (const line of footerLines(state, columns)) {
    lines.push(line);
  }
  return pad(lines, size);
}

function headerText(state: AppState, theme: Theme, columns: number): string {
  const selected = state.view.filesystems[state.selected];
  if (selected === undefined) {
    return `Disktop  no filesystem data  ${state.view.complete ? "" : "incomplete"}`.trimEnd();
  }
  const percent = usedPercentOfSpace(selected.totalBytes, selected.freeBytes, selected.availableBytes);
  const inodes = selected.totalInodes === undefined || selected.freeInodes === undefined
    ? ""
    : `   inodes ${usedPercentOfInodes(selected.totalInodes, selected.freeInodes)}%`;
  const alert = state.view.alerts.some((entry) => entry.filesystemId === selected.id) ? "   [warning]" : "";
  const head = `Disktop  ${selected.mounts[0]?.display ?? "?"}  ${percent}% used  ${formatBytes(selected.availableBytes, state.units)} available${inodes}${alert}`;

  // The bar is decoration, so it is only drawn when the row can spare the width.
  const spare = columns - head.length - 2;
  return spare >= 12 ? `${head}  ${usageBar(percent, Math.min(20, spare), theme)}` : head;
}

function tabText(state: AppState): string {
  return TABS.map((tab) => (tab === state.tab ? `[${tab}]` : ` ${tab} `)).join(" ");
}

function filesystemRow(filesystem: Filesystem, state: AppState, theme: Theme, columns: number): string {
  const mount = filesystem.mounts.map((point) => point.display).join(", ");
  const percent = usedPercentOfSpace(filesystem.totalBytes, filesystem.freeBytes, filesystem.availableBytes);
  const right = `${formatBytes(filesystem.availableBytes, state.units).padStart(10)} free  ${String(percent).padStart(3)}%`;
  const bar = columns >= 72 ? ` ${usageBar(percent, 10, theme)}` : "";
  const mountWidth = Math.max(4, columns - right.length - bar.length - 2);
  return `${truncate(mount, mountWidth).padEnd(mountWidth)}${bar} ${right}`;
}

function rowStyle(filesystem: Filesystem, state: AppState): StyleName {
  return state.view.alerts.some((alert) => alert.filesystemId === filesystem.id) ? "alert" : "normal";
}

function footerLines(state: AppState, columns: number): ScreenLine[] {
  const lines: ScreenLine[] = [];
  const selected = state.view.filesystems[state.selected];

  if (selected !== undefined) {
    const detail = `Selected: ${selected.mounts.map((point) => point.display).join(", ")}  |  ${selected.type}  |  ${formatBytes(selected.totalBytes, state.units)} total${selected.removable ? "  |  removable" : ""}${selected.network ? "  |  network" : ""}`;
    lines.push({ text: clip(detail, columns), style: "dim" });
  }

  const alert = state.view.alerts[0];
  if (alert !== undefined) {
    lines.push({ text: clip(alert.message, columns), style: "alert" });
  }

  if (state.notice !== undefined) {
    lines.push({ text: clip(state.notice, columns), style: "dim" });
  }

  if (!state.view.complete) {
    lines.push({
      text: clip(`Incomplete: ${state.view.warnings.length} reading(s) could not be taken. Nothing is reported as zero.`, columns),
      style: "alert",
    });
  }

  lines.push({ text: clip("? help  j/k move  h/l tab  u units  q quit", columns), style: "dim" });
  return lines;
}

function footerHeight(state: AppState): number {
  let height = 1;
  if (state.view.filesystems.length > 0) {
    height += 1;
  }
  if (state.view.alerts.length > 0) {
    height += 1;
  }
  if (state.notice !== undefined) {
    height += 1;
  }
  if (!state.view.complete) {
    height += 1;
  }
  return height;
}

/** Keep the selected row on screen without ever scrolling past the list. */
export function windowFor(selected: number, count: number, rows: number): { start: number; end: number } {
  if (count <= rows) {
    return { start: 0, end: count };
  }
  const start = Math.max(0, Math.min(count - rows, selected - Math.floor(rows / 2)));
  return { start, end: start + rows };
}

function pad(lines: readonly ScreenLine[], size: ScreenSize): ScreenLine[] {
  const padded = [...lines.slice(0, size.rows)];
  while (padded.length < size.rows) {
    padded.push({ text: "", style: "normal" });
  }
  return padded;
}

function clip(text: string, columns: number): string {
  return text.length <= columns ? text : truncate(text, columns);
}

/** A trimmed name ends in an ellipsis so a reader can tell it was trimmed. */
function truncate(text: string, width: number): string {
  if (text.length <= width) {
    return text;
  }
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}
