import { formatBytes } from "../../domain/sizes.js";
import type { JournalRecord } from "../../ports/actions.js";
import { LineBuilder, type HitRegion, type ScreenLine } from "../frame.js";
import { groupDigits, localDateTime, padEnd, padStart, relativeAge, truncateMiddle } from "../text.js";
import type { StyleName, Theme } from "../themes.js";
import { ruleLine, type Hint } from "../widgets/chrome.js";
import { emptyState, fit, listWindow, type ViewContext, type ViewOutput } from "./common.js";

/** The operations whose completed items can come back out of Trash. */
const RESTORABLE = new Set(["trash", "copy-move", "compress"]);

export function canUndo(record: JournalRecord): boolean {
  return (
    RESTORABLE.has(record.operation) &&
    record.state !== "uncertain" &&
    record.state !== "in-progress" &&
    record.items.some((item) => item.outcome === "completed" && item.destination !== undefined)
  );
}

function stateBadge(record: JournalRecord, theme: Theme): { text: string; style: StyleName } {
  switch (record.state) {
    case "complete":
      return { text: `${theme.glyphs.ok} complete`, style: "ok" };
    case "partial":
      return { text: `${theme.glyphs.warn} partial`, style: "warn" };
    case "uncertain":
      return { text: `${theme.glyphs.warn} uncertain`, style: "danger" };
    case "in-progress":
      return { text: `${theme.glyphs.info} running`, style: "info" };
  }
}

const OPERATION_LABELS: Readonly<Record<string, string>> = {
  trash: "to Trash",
  erase: "erased",
  "empty-trash": "emptied Trash",
  restore: "restored",
  "copy-move": "moved",
  compress: "compressed",
  "dedup-hardlink": "hardlinked",
  manager: "manager",
};

export function renderHistory(context: ViewContext, home: string | undefined): ViewOutput {
  const { state, theme, width, height } = context;
  const history = state.history;
  const hints: Hint[] = [["j/k", "move"], ["u", "undo"], ["n", "older"], ["r", "refresh"], ["h/l", "tabs"], ["q", "quit"]];

  if (!history.loaded) {
    return {
      lines: emptyState(
        history.failure === undefined ? ["Reading the action journal…"] : [history.failure, "Press r to try again."],
        width,
        height,
        theme,
        undefined,
        history.failure === undefined ? "strong" : "danger",
      ),
      hits: [],
      hints,
    };
  }
  if (history.records.length === 0) {
    return {
      lines: emptyState(
        [
          "No action has been applied yet.",
          "Everything Disktop changes is journalled here first, with what happened to each item. Trash actions can be undone from this tab.",
        ],
        width,
        height,
        theme,
        theme.glyphs.info,
      ),
      hits: [],
      hints,
    };
  }

  const lines: ScreenLine[] = [];
  const hits: HitRegion[] = [];
  const header = new LineBuilder(width)
    .add("  ")
    .add(padEnd("WHEN", 12), "heading")
    .add(padEnd("ACTION", 15), "heading")
    .add(padEnd("RESULT", 13), "heading")
    .add(padStart("ITEMS", 7), "heading")
    .add(padStart("SELECTED", 11), "heading");
  if (width >= 80) header.add(padStart("TO TRASH", 11), "heading");
  header.add("  UNDO", "heading");
  lines.push(header.build());

  const detailHeight = height >= 14 ? Math.min(7, Math.floor(height / 3)) : 0;
  const listRows = Math.max(1, height - 1 - detailHeight);
  const window = listWindow(history.selected, history.records.length, listRows);
  for (let index = window.start; index < window.end; index += 1) {
    const record = history.records[index] as JournalRecord;
    const selected = index === history.selected;
    hits.push({ row: context.top + lines.length, from: 0, to: width, action: { kind: "row", index } });
    const badge = stateBadge(record, theme);
    const line = new LineBuilder(width)
      .add(selected ? `${theme.glyphs.pointer} ` : "  ", "accent")
      .add(padEnd(relativeAge(Date.parse(record.startedAt), context.now), 12), "dim")
      .add(padEnd(OPERATION_LABELS[record.operation] ?? record.operation, 15), "strong")
      .add(padEnd(badge.text, 13), badge.style)
      .add(padStart(groupDigits(record.completed), 7))
      .add(padStart(record.selectedBytes === undefined ? "unknown" : formatBytes(record.selectedBytes, state.units), 11), record.selectedBytes === undefined ? "muted" : "normal");
    if (width >= 80) {
      line.add(padStart(record.bytesMovedToTrash > 0n ? formatBytes(record.bytesMovedToTrash, state.units) : "-", 11), "dim");
    }
    line.add("  ").add(canUndo(record) ? "u" : "-", canUndo(record) ? "key" : "muted");
    lines.push(line.build({ selected }));
  }

  const body = fit(lines, height - detailHeight);
  const current = history.records[history.selected];
  if (detailHeight > 0 && current !== undefined) {
    for (const line of detailLines(current, detailHeight, context, home)) {
      body.push(line);
    }
  }
  const status = new LineBuilder(width).add(" ");
  status.add(`${history.records.length} action${history.records.length === 1 ? "" : "s"}`, "dim");
  if (history.reconciled > 0n) {
    status.add(`${theme.glyphs.separator}${history.reconciled} interrupted action(s) reconciled on reading`, "warn");
  }
  if (history.nextCursor !== undefined) {
    status.addRight("older: n ", "muted");
  }
  return { lines: fit(body, height), hits, hints, status: status.build() };
}

function detailLines(record: JournalRecord, height: number, context: ViewContext, home: string | undefined): ScreenLine[] {
  const { state, theme, width } = context;
  const lines: ScreenLine[] = [ruleLine(`${localDateTime(Date.parse(record.startedAt))}  ${record.id}`, width, theme)];
  const summary = new LineBuilder(width).add("  ");
  summary
    .add(`${groupDigits(record.completed)} done`, "ok")
    .add(`${theme.glyphs.separator}${groupDigits(record.skipped)} skipped`, record.skipped > 0n ? "warn" : "dim")
    .add(`${theme.glyphs.separator}${groupDigits(record.failed)} failed`, record.failed > 0n ? "danger" : "dim");
  if (record.freeBytesBefore !== undefined && record.freeBytesAfter !== undefined) {
    const change = record.freeBytesAfter - record.freeBytesBefore;
    summary.add(`${theme.glyphs.separator}free space ${change >= 0n ? "+" : "-"}${formatBytes(change >= 0n ? change : -change, state.units)} observed`, "dim");
  }
  lines.push(summary.build());
  if (record.state === "uncertain") {
    lines.push(
      new LineBuilder(width)
        .add(`  ${theme.glyphs.warn} `, "danger")
        .add("Interrupted before its last item was recorded; undo is refused until that item can be judged.", "danger")
        .build(),
    );
  }
  if (record.manager !== undefined) {
    for (const command of record.manager.commands.slice(0, height - lines.length)) {
      lines.push(
        new LineBuilder(width)
          .add("  $ ", "muted")
          .add(truncateMiddle([command.tool, ...command.arguments].join(" "), width - 24, theme.glyphs.ellipsis), "normal")
          .addRight(`${command.state}${command.exitCode === undefined ? "" : ` (exit ${command.exitCode})`}`, command.exitCode === 0n ? "ok" : "dim", 1)
          .build(),
      );
    }
  }
  for (const item of record.items.slice(0, Math.max(0, height - lines.length))) {
    const style: StyleName = item.outcome === "completed" ? "ok" : item.outcome === "failed" || item.outcome === "uncertain" ? "danger" : "warn";
    const icon = item.outcome === "completed" ? theme.glyphs.ok : item.outcome === "skipped" ? "-" : theme.glyphs.fail;
    const where = home !== undefined && item.path.display.startsWith(`${home}/`) ? `${theme.glyphs.home}${item.path.display.slice(home.length)}` : item.path.display;
    lines.push(
      new LineBuilder(width)
        .add(`  ${icon} `, style)
        .add(truncateMiddle(where, Math.max(10, width - 40), theme.glyphs.ellipsis))
        .add(item.message === undefined ? "" : `  ${item.message}`, "dim")
        .build(),
    );
  }
  return lines.slice(0, height);
}
