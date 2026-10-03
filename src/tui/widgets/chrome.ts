import { formatBytes, usedPercentOfInodes, usedPercentOfSpace } from "../../domain/sizes.js";
import { LineBuilder, type HitRegion, type ScreenLine } from "../frame.js";
import { TABS, type AppState } from "../state.js";
import { cellWidth, truncateMiddle } from "../text.js";
import type { Theme } from "../themes.js";
import { barSpans, usageStyle } from "./bars.js";

export type Hint = readonly [key: string, label: string];

/**
 * The top band: which filesystem is in focus, how full it is, and whether any
 * filesystem has crossed its threshold. Pieces drop from the right as the
 * terminal narrows; the mount and its used share are the last to go.
 */
export function headerLine(state: AppState, theme: Theme, columns: number, threshold: number): ScreenLine {
  const line = new LineBuilder(columns);
  const { glyphs } = theme;
  line.add(` ${glyphs.brand} `, "brand").add("Disktop", "title").add("  ", "band");

  const view = state.disks.view;
  const selected = view.filesystems[state.disks.selected];
  const alerts = view.alerts.length;
  const alertText = alerts === 0 ? "" : ` ${glyphs.warn} ${alerts} alert${alerts === 1 ? "" : "s"} `;
  const incomplete = view.complete ? "" : ` ${glyphs.warn} incomplete `;

  if (selected === undefined) {
    line.add("no filesystem could be read", "dim");
  } else {
    const percent = usedPercentOfSpace(selected.totalBytes, selected.freeBytes, selected.availableBytes);
    const mount = selected.mounts[0]?.display ?? selected.source;
    const free = `${formatBytes(selected.availableBytes, state.units)} free`;
    const inodes =
      selected.totalInodes === undefined || selected.freeInodes === undefined || selected.totalInodes === 0n
        ? ""
        : `inodes ${usedPercentOfInodes(selected.totalInodes, selected.freeInodes)}%`;
    const right = cellWidth(alertText) + cellWidth(incomplete);
    const room = columns - line.used - right - 1;

    const mountWidth = Math.max(4, Math.min(cellWidth(mount), Math.floor(room * 0.4)));
    line.add(truncateMiddle(mount, mountWidth, glyphs.ellipsis), "strong");
    const pieces: { text: string; style: "dim" | "normal" }[] = [];
    let spare = room - mountWidth;
    const pctText = ` ${String(percent).padStart(3)}%`;
    const barWidth = Math.min(20, spare - cellWidth(pctText) - cellWidth(free) - 6);
    if (barWidth >= 8) {
      line.add("  ", "band");
      for (const span of barSpans(percent, barWidth, theme, usageStyle(percent, threshold))) {
        line.add(span.text, span.style);
      }
      spare -= barWidth + 2;
    }
    if (spare >= cellWidth(pctText)) {
      line.add(pctText, percent >= threshold ? "danger" : "strong");
      spare -= cellWidth(pctText);
    }
    pieces.push({ text: free, style: "normal" });
    if (inodes !== "") {
      pieces.push({ text: inodes, style: "dim" });
    }
    for (const piece of pieces) {
      if (spare >= cellWidth(piece.text) + 3) {
        line.add("  ", "band").add(piece.text, piece.style);
        spare -= cellWidth(piece.text) + 2;
      }
    }
  }

  if (incomplete !== "") {
    line.addRight(incomplete, "badgeWarn", alertText === "" ? 0 : cellWidth(alertText));
  }
  if (alertText !== "") {
    line.addRight(alertText, "badgeDanger");
  }
  return line.build({ fill: "band" });
}

/** The tab bar, with numbers so every tab is one key away, and where each tab sits for a click. */
export function tabLine(state: AppState, columns: number, row: number): { line: ScreenLine; hits: HitRegion[] } {
  const line = new LineBuilder(columns);
  const hits: HitRegion[] = [];
  const compact = columns < 64;
  line.add(" ");
  for (const [index, tab] of TABS.entries()) {
    const label = compact ? ` ${tab} ` : ` ${index + 1} ${tab} `;
    const from = line.used;
    line.add(label, tab === state.tab ? "tabActive" : "tab");
    hits.push({ row, from, to: line.used, action: { kind: "tab", index } });
    line.add(compact ? "" : " ");
  }
  if (!compact) {
    line.addRight("? help ", "muted");
  }
  return { line: line.build(), hits };
}

/** Key hints, as many as fit, most important first. */
export function hintLine(hints: readonly Hint[], columns: number): ScreenLine {
  const line = new LineBuilder(columns);
  line.add(" ");
  for (const [key, label] of hints) {
    const width = cellWidth(key) + 1 + cellWidth(label) + 2;
    if (line.remaining < width) {
      break;
    }
    line.add(key, "key").add(` ${label}`, "muted").add("  ");
  }
  return line.build();
}

/** A horizontal rule with an optional title set into it. */
export function ruleLine(title: string, columns: number, theme: Theme): ScreenLine {
  const line = new LineBuilder(columns);
  if (title === "") {
    return line.add(theme.glyphs.rule.repeat(columns), "border").build();
  }
  line.add(theme.glyphs.rule.repeat(2), "border").add(` ${title} `, "heading");
  return line.add(theme.glyphs.rule.repeat(Math.max(0, line.remaining)), "border").build();
}

/** The spinner frame for a tick, from the theme's glyph set. */
export function spinnerFrame(tick: number, theme: Theme): string {
  const frames = theme.glyphs.spinner;
  return frames[tick % frames.length] as string;
}

/** Elapsed time as a person reads it: 4s, 1m 12s. */
export function elapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** The status row: what is running, or the last thing that happened. */
export function statusLine(state: AppState, theme: Theme, columns: number, now: number, fallback: ScreenLine | undefined): ScreenLine {
  const line = new LineBuilder(columns);
  if (state.busy !== undefined) {
    const busy = state.busy;
    line.add(` ${spinnerFrame(state.tick, theme)} `, "accent").add(busy.label, "strong");
    if (busy.detail !== undefined) {
      line.add(theme.glyphs.separator, "muted").add(busy.detail, "dim");
    }
    const right = `${elapsed(busy.startedAt, now)}${busy.cancellable ? "  esc stop" : "  finishing current item"} `;
    line.addRight(right, "muted");
    return line.build();
  }
  if (state.notice !== undefined) {
    const { text, tone } = state.notice;
    const icon = tone === "ok" ? theme.glyphs.ok : tone === "danger" ? theme.glyphs.fail : tone === "warn" ? theme.glyphs.warn : theme.glyphs.info;
    const style = tone === "ok" ? "ok" : tone === "danger" ? "danger" : tone === "warn" ? "warn" : "info";
    line.add(` ${icon} `, style).add(text, tone === "info" ? "normal" : style);
    return line.build();
  }
  return fallback ?? line.build();
}
