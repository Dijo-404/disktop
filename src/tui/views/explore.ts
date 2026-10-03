import type { IndexedEntry, RawPath } from "../../domain/models.js";
import { formatBytes } from "../../domain/sizes.js";
import { LineBuilder, type HitRegion, type ScreenLine } from "../frame.js";
import type { ExploreMode, ExploreRow, ExploreState } from "../state.js";
import {
  cellWidth,
  groupDigits,
  localDateTime,
  nanosecondsToMilliseconds,
  padEnd,
  padStart,
  relativeAge,
  truncate,
  truncateMiddle,
  truncateStart,
} from "../text.js";
import { sparkline, type Theme } from "../themes.js";
import { SERIES, barSpans, seriesGlyph, sharePercent, stackedBarSpans } from "../widgets/bars.js";
import { elapsed, ruleLine, spinnerFrame, type Hint } from "../widgets/chrome.js";
import { emptyState, fit, listWindow, type ViewContext, type ViewOutput } from "./common.js";

const MODE_LABELS: Readonly<Record<ExploreMode, string>> = {
  browse: "Browse",
  largest: "Largest files",
  duplicates: "Duplicates",
  stale: "Stale",
  empty: "Empty dirs",
  broken: "Broken links",
  search: "Search",
};

export function modeLabel(explore: ExploreState): string {
  if (explore.mode === "stale") {
    return `Stale >${explore.staleDays}d`;
  }
  if (explore.mode === "search" && explore.search !== undefined) {
    return `Search: ${explore.search.text}`;
  }
  return MODE_LABELS[explore.mode];
}

/** The path of `path` below `root`, or the whole display when it is not below it. */
export function relativeDisplay(path: RawPath, root: RawPath | undefined): string {
  if (root === undefined) {
    return path.display;
  }
  const base = root.display.endsWith("/") ? root.display : `${root.display}/`;
  if (path.display === root.display) {
    return ".";
  }
  return path.display.startsWith(base) ? path.display.slice(base.length) : path.display;
}

export function baseName(path: RawPath): string {
  const display = path.display;
  if (display === "/") {
    return "/";
  }
  const trimmed = display.endsWith("/") ? display.slice(0, -1) : display;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

/** `~/projects/disktop` for anything under the home directory. */
export function homeRelative(display: string, home: string | undefined, theme: Theme): string {
  if (home === undefined || home === "/" || home === "") {
    return display;
  }
  if (display === home) {
    return theme.glyphs.home;
  }
  return display.startsWith(`${home}/`) ? `${theme.glyphs.home}${display.slice(home.length)}` : display;
}

const HINTS_BROWSE = (theme: Theme): Hint[] => [
  ["j/k", "move"],
  [`${theme.glyphs.enter}/l`, "open"],
  ["h/⌫", "up"],
  ["s", "sort"],
  ["/", "filter"],
  ["f", "find"],
  ["c", "clean"],
  ["S", "rescan"],
  ["t", "types"],
];

function hintsFor(explore: ExploreState, theme: Theme): Hint[] {
  const ascii = (hints: Hint[]): Hint[] => (theme.unicode ? hints : hints.map(([key, label]) => [key.replace("⌫", "Bksp"), label]));
  if (explore.scan !== undefined) {
    return [["esc", "stop scan (keeps what was read)"], ["q", "quit"]];
  }
  if (explore.snapshot === undefined) {
    return [["S", "scan home"], ["1", "pick a disk"], ["?", "help"], ["q", "quit"]];
  }
  if (explore.mode === "browse") {
    return ascii(HINTS_BROWSE(theme));
  }
  return ascii([
    ["j/k", "move"],
    ["f", "next finder"],
    ["/", "filter"],
    ["c", "clean"],
    ["esc", "back to browse"],
    ["n", "more"],
  ]);
}

export function renderExplore(context: ViewContext, home: string | undefined): ViewOutput {
  const { state, theme, width, height } = context;
  const explore = state.explore;

  if (explore.scan !== undefined) {
    return { lines: scanProgress(context, home), hits: [], hints: hintsFor(explore, theme) };
  }

  if (explore.snapshot === undefined) {
    const target = explore.root === undefined ? `your home directory (${theme.glyphs.home})` : homeRelative(explore.root.display, home, theme);
    return {
      lines: emptyState(
        [
          explore.empty ?? "Nothing has been scanned here yet.",
          `Press S to scan ${target}. A scan reads names and sizes only, stays on one filesystem, and changes nothing.`,
          "Or pick a filesystem on the Disks tab and press Enter.",
        ],
        width,
        height,
        theme,
        theme.glyphs.info,
      ),
      hits: [],
      hints: hintsFor(explore, theme),
    };
  }

  const lines: ScreenLine[] = [];
  const hits: HitRegion[] = [];
  lines.push(contextLine(context, home));

  const typesHeight = explore.showTypes && explore.mode === "browse" && (explore.typeTotals?.length ?? 0) > 0 && height >= 16 ? 2 : 0;
  const detailHeight = height >= 12 ? 2 : 0;
  const listRows = Math.max(1, height - 2 - detailHeight - typesHeight);

  const columns = exploreColumns(width, explore);
  lines.push(columnHeader(columns, explore, width, theme));

  if (explore.rows.length === 0) {
    const message = explore.loading
      ? [`${spinnerFrame(state.tick, theme)} Reading the index${theme.glyphs.ellipsis}`]
      : [explore.empty ?? emptyMessage(explore), explore.mode === "browse" ? "" : "Press f for the next finder, or esc to go back to browsing."].filter((text) => text !== "");
    for (const line of emptyState(message, width, listRows, theme)) {
      lines.push(line);
    }
  } else {
    const window = listWindow(explore.selected, explore.rows.length, listRows);
    const whole = shareBase(explore);
    for (let index = window.start; index < window.end; index += 1) {
      const row = explore.rows[index] as ExploreRow;
      hits.push({ row: context.top + lines.length, from: 0, to: width, action: { kind: "row", index } });
      lines.push(rowLine(row, index === explore.selected, columns, whole, context, home));
    }
  }

  const body = fit(lines, height - detailHeight - typesHeight);
  if (detailHeight > 0) {
    for (const line of detailLines(context, home)) {
      body.push(line);
    }
  }
  if (typesHeight > 0) {
    for (const line of typeLines(context)) {
      body.push(line);
    }
  }
  return { lines: fit(body, height), hits, hints: hintsFor(explore, theme), status: footerStatus(context) };
}

function emptyMessage(explore: ExploreState): string {
  switch (explore.mode) {
    case "browse":
      return "This directory is empty.";
    case "largest":
      return "No files were indexed under this directory.";
    case "duplicates":
      return "No duplicate files of at least 1 MiB were found here.";
    case "stale":
      return `Nothing here is older than ${explore.staleDays} days.`;
    case "empty":
      return "No empty directories were found here.";
    case "broken":
      return "No broken symbolic links were found here.";
    case "search":
      return `Nothing matches '${explore.search?.text ?? ""}' here.`;
  }
}

interface ExploreColumns {
  readonly size: number;
  readonly bar: number;
  readonly percent: number;
  readonly name: number;
  readonly growth: number;
  readonly modified: number;
}

function exploreColumns(width: number, explore: ExploreState): ExploreColumns {
  const size = 11;
  const bar = width >= 72 ? 12 : width >= 56 ? 6 : 0;
  const percent = width >= 60 ? 7 : 0;
  const growth = explore.growth.size > 0 && width >= 76 ? 11 : 0;
  const modified = width >= 64 ? 10 : 0;
  const name = Math.max(8, width - 2 - size - (bar > 0 ? bar + 1 : 0) - percent - 1 - growth - modified);
  return { size, bar, percent, name, growth, modified };
}

function columnHeader(columns: ExploreColumns, explore: ExploreState, width: number, theme: Theme): ScreenLine {
  const sizeLabel = explore.sort === "apparent" ? "APPARENT" : "SIZE";
  const arrow = (sort: string): string => (explore.sort === sort ? (sort === "name" ? theme.glyphs.up : theme.glyphs.down) : "");
  const line = new LineBuilder(width).add("  ");
  line.add(padStart(`${sizeLabel}${explore.sort === "allocated" || explore.sort === "apparent" ? arrow(explore.sort) : ""}`, columns.size - 1), "heading").add(" ");
  if (columns.bar > 0) line.add(" ".repeat(columns.bar + 1));
  if (columns.percent > 0) line.add(padStart("SHARE", columns.percent - 1), "heading").add(" ");
  line.add(" ").add(padEnd(`NAME${arrow("name")}`, columns.name), "heading");
  if (columns.growth > 0) line.add(padStart("GROWTH", columns.growth - 1), "heading").add(" ");
  if (columns.modified > 0) line.add(padStart(`MODIFIED${arrow("modified")}`, columns.modified), "heading");
  return line.build();
}

function shareBase(explore: ExploreState): bigint {
  const apparent = explore.sort === "apparent";
  if (explore.mode === "browse" && explore.directory !== undefined) {
    return apparent ? explore.directory.entry.apparentBytes : explore.directory.entry.allocatedBytes;
  }
  const totals = explore.snapshot?.totals;
  return totals === undefined ? 0n : apparent ? totals.apparentBytes : totals.allocatedBytes;
}

function entrySize(entry: IndexedEntry, explore: ExploreState): bigint {
  return explore.sort === "apparent" ? entry.apparentBytes : entry.allocatedBytes;
}

function rowLine(row: ExploreRow, selected: boolean, columns: ExploreColumns, whole: bigint, context: ViewContext, home: string | undefined): ScreenLine {
  const { state, theme, width } = context;
  const explore = state.explore;
  const line = new LineBuilder(width);
  line.add(selected ? `${theme.glyphs.pointer} ` : "  ", "accent");

  if (row.kind === "group") {
    const group = row.group;
    const copies = group.group.files.length;
    line.add(padStart(formatBytes(group.group.apparentBytes, state.units), columns.size - 1), "strong").add(" ");
    line.add(` ${copies} identical copies`, "heading");
    if (group.decision.kind === "decided") {
      line.add(`${theme.glyphs.separator}frees ${formatBytes(group.reclaimableBytes, state.units)}`, "ok");
    } else {
      line.add(`${theme.glyphs.separator}keep rule could not decide`, "warn");
    }
    return line.build({ selected });
  }

  if (row.kind === "member") {
    line.add(padStart(row.keep ? `${theme.glyphs.ok} keep` : row.undecided ? "?" : `${theme.glyphs.fail} copy`, columns.size - 1), row.keep ? "ok" : row.undecided ? "warn" : "danger").add(" ");
    const room = width - line.used - (columns.modified > 0 ? columns.modified + 1 : 0);
    line.add("  ").add(truncateMiddle(homeRelative(row.file.path.display, home, theme), room - 2, theme.glyphs.ellipsis), row.keep ? "strong" : "normal");
    if (columns.modified > 0) {
      line.padTo(width - columns.modified).add(padStart(relativeAge(nanosecondsToMilliseconds(row.file.modifiedNanoseconds), context.now), columns.modified), "dim");
    }
    return line.build({ selected });
  }

  const entry = row.entry;
  const size = entrySize(entry, explore);
  line.add(padStart(formatBytes(size, state.units), columns.size - 1), entry.shared ? "dim" : "strong").add(" ");
  const percent = sharePercent(size, whole);
  if (columns.bar > 0) {
    line.add(" ");
    for (const span of barSpans(percent, columns.bar, theme, entry.kind === "directory" ? "barUsed" : "series2")) {
      line.add(span.text, span.style);
    }
  }
  if (columns.percent > 0) {
    line.add(padStart(whole > 0n ? `${percent.toFixed(1)}%` : "", columns.percent), "dim");
  }
  line.add("  ");
  const name = explore.mode === "browse" ? baseName(entry.path) : relativeDisplay(entry.path, explore.root);
  const decorated = entryName(name, entry, theme);
  const nameStyle = entry.broken === true ? "danger" : entry.kind === "directory" ? "directory" : entry.kind === "symlink" ? "symlink" : "normal";
  const fitted = explore.mode === "browse" ? truncate(decorated, columns.name - 1, theme.glyphs.ellipsis) : truncateMiddle(decorated, columns.name - 1, theme.glyphs.ellipsis);
  line.add(fitted, nameStyle);
  if (entry.shared) {
    line.add(" (hardlink)", "muted");
  }
  if (columns.growth > 0) {
    line.padTo(width - columns.modified - columns.growth);
    const growth = explore.growth.get(entry.path.bytesBase64);
    if (growth !== undefined && growth !== 0n) {
      line.add(padStart(`${growth > 0n ? "+" : ""}${formatBytes(growth, state.units)}`, columns.growth - 1), growth > 0n ? "warn" : "ok");
    }
  }
  if (columns.modified > 0) {
    line.padTo(width - columns.modified).add(padStart(relativeAge(nanosecondsToMilliseconds(entry.modifiedNanoseconds), context.now), columns.modified), "dim");
  }
  return line.build({ selected });
}

function entryName(name: string, entry: IndexedEntry, theme: Theme): string {
  if (entry.kind === "directory") {
    return name.endsWith("/") ? name : `${name}${theme.glyphs.directory}`;
  }
  if (entry.kind === "symlink") {
    return `${name}${entry.broken === true ? theme.glyphs.brokenLink : theme.glyphs.link}`.trimEnd();
  }
  return name;
}

/** Mode, breadcrumb, and what this place holds; the trend goes on the right when it fits. */
function contextLine(context: ViewContext, home: string | undefined): ScreenLine {
  const { state, theme, width } = context;
  const explore = state.explore;
  const line = new LineBuilder(width);
  line.add(` ${modeLabel(explore)} `, "badgeInfo").add(" ");

  const right: string[] = [];
  const directory = explore.mode === "browse" ? explore.directory?.entry : undefined;
  if (directory !== undefined) {
    right.push(formatBytes(entrySize(directory, explore), state.units));
    if (directory.childEntries !== undefined) {
      right.push(`${groupDigits(directory.childEntries)} items`);
    }
  } else if (explore.duplicates !== undefined && explore.mode === "duplicates") {
    right.push(`frees ${formatBytes(explore.duplicates.reclaimable, state.units)}`);
  }
  const trend = explore.trend;
  let trendText = "";
  if (trend !== undefined && trend.values.length >= 2 && width >= 70) {
    const spark = sparkline(trend.values.map((value) => Number(value)), theme);
    const sign = trend.delta > 0n ? "+" : trend.delta < 0n ? "-" : "±";
    const magnitude = trend.delta < 0n ? -trend.delta : trend.delta;
    trendText = `${spark} ${sign}${formatBytes(magnitude, state.units)} since ${trend.since}`;
  }
  const rightText = right.join(theme.glyphs.separator);
  const reserve = cellWidth(rightText) + (trendText === "" ? 0 : cellWidth(trendText) + 3) + 2;

  const path = explore.mode === "browse" ? explore.directory?.path ?? explore.root : explore.root;
  const crumbs = path === undefined ? "" : breadcrumb(path, home, theme);
  line.add(truncateStart(crumbs, Math.max(8, width - line.used - reserve), theme.glyphs.ellipsis), "strong");

  if (trendText !== "") {
    const start = width - cellWidth(rightText) - cellWidth(trendText) - 4;
    if (start > line.used) {
      line.padTo(start);
      const spark = sparkline(trend?.values.map((value) => Number(value)) ?? [], theme);
      line.add(spark, "accent").add(trendText.slice(spark.length), (trend?.delta ?? 0n) > 0n ? "warn" : "ok");
    }
  }
  line.addRight(rightText, "dim", 1);
  return line.build();
}

function breadcrumb(path: RawPath, home: string | undefined, theme: Theme): string {
  const relative = homeRelative(path.display, home, theme);
  if (relative === "/") {
    return "/";
  }
  const parts = relative.split("/").filter((part, index) => part !== "" || index === 0);
  if (parts[0] === "") {
    parts[0] = "/";
    return `/${parts.slice(1).join(theme.glyphs.crumb)}`;
  }
  return parts.join(theme.glyphs.crumb);
}

function detailLines(context: ViewContext, home: string | undefined): ScreenLine[] {
  const { state, theme, width, now } = context;
  const explore = state.explore;
  const row = explore.rows[explore.selected];
  const lines: ScreenLine[] = [ruleLine("", width, theme)];
  const detail = new LineBuilder(width).add("  ");

  if (row === undefined) {
    const snapshot = explore.snapshot;
    if (snapshot !== undefined) {
      detail.add(`Scanned ${relativeAge(Date.parse(snapshot.scannedAt), now)}`, "dim");
    }
    lines.push(detail.build());
    return lines;
  }

  if (row.kind === "group") {
    const decision = row.group.decision;
    detail.add(decision.kind === "decided" ? `Keeps ${homeRelative(decision.kept.path.display, home, theme)}` : "Undecided", "strong");
    detail.add(`${theme.glyphs.separator}${decision.kind === "decided" ? decision.basis : decision.reason}`, "dim");
  } else if (row.kind === "member") {
    detail
      .add(row.keep ? "This copy is kept" : row.undecided ? "The keep rule could not choose" : "A copy the keep rule would release", row.keep ? "ok" : "strong")
      .add(`${theme.glyphs.separator}${formatBytes(row.file.apparentBytes, state.units)}`, "dim")
      .add(`${theme.glyphs.separator}owner ${row.file.ownerId}`, "dim")
      .add(row.keep ? "" : `${theme.glyphs.separator}c plans moving it to Trash`, "muted");
  } else {
    const entry = row.entry;
    const pieces = [
      entry.childEntries === undefined ? entry.kind : `${groupDigits(entry.childEntries)} items`,
      `${formatBytes(entry.allocatedBytes, state.units)} on disk`,
      `${formatBytes(entry.apparentBytes, state.units)} apparent`,
      `modified ${localDateTime(nanosecondsToMilliseconds(entry.modifiedNanoseconds))}`,
      `uid ${entry.ownerId}`,
      entry.shared ? "hardlink, bytes counted elsewhere" : undefined,
      entry.broken === true ? "target missing" : undefined,
    ].filter((piece): piece is string => piece !== undefined);
    detail.add(truncate(baseName(entry.path), Math.max(8, Math.floor(width / 3)), theme.glyphs.ellipsis), "strong").add(theme.glyphs.separator, "muted");
    detail.add(truncate(pieces.join(theme.glyphs.separator), detail.remaining, theme.glyphs.ellipsis), "dim");
  }
  lines.push(detail.build());
  return lines;
}

/** A distribution of this directory's bytes by file type: what kind of thing is taking the room. */
function typeLines(context: ViewContext): ScreenLine[] {
  const { state, theme, width } = context;
  const totals = state.explore.typeTotals ?? [];
  const apparent = state.explore.sort === "apparent";
  const value = (total: (typeof totals)[number]): bigint => (apparent ? total.apparentBytes : total.allocatedBytes);
  const whole = totals.reduce((sum, total) => sum + value(total), 0n);
  const top = totals.slice(0, 5);
  const rest = whole - top.reduce((sum, total) => sum + value(total), 0n);
  const segments = [
    ...top.map((total, index) => ({ value: value(total), style: SERIES[index] ?? "series6", glyph: seriesGlyph(index, theme) })),
    ...(rest > 0n ? [{ value: rest, style: "series6" as const, glyph: seriesGlyph(5, theme) }] : []),
  ];
  const barWidth = Math.max(10, Math.min(24, Math.floor(width / 4)));
  const line = new LineBuilder(width).add("  ");
  for (const span of stackedBarSpans(segments, whole, barWidth, theme)) {
    line.add(span.text, span.style);
  }
  line.add("  ");
  for (const [index, total] of top.entries()) {
    const label = total.extension === "" ? "(none)" : `.${total.extension}`;
    const text = `${label} ${formatBytes(value(total), state.units)}`;
    if (line.remaining < cellWidth(text) + 4) {
      break;
    }
    line.add(theme.color === "none" ? seriesGlyph(index, theme) : theme.glyphs.legend, SERIES[index] ?? "series6").add(` ${text}  `, "dim");
  }
  if (rest > 0n && line.remaining > 14) {
    line.add(theme.color === "none" ? seriesGlyph(5, theme) : theme.glyphs.legend, "series6").add(` other ${formatBytes(rest, state.units)}`, "dim");
  }
  return [ruleLine("File types", width, theme), line.build()];
}

function footerStatus(context: ViewContext): ScreenLine | undefined {
  const { state, theme, width, now } = context;
  const snapshot = state.explore.snapshot;
  if (snapshot === undefined) {
    return undefined;
  }
  const line = new LineBuilder(width).add(" ");
  const complete = snapshot.completeness.complete;
  line
    .add(complete ? theme.glyphs.ok : theme.glyphs.warn, complete ? "ok" : "warn")
    .add(` scan ${relativeAge(Date.parse(snapshot.scannedAt), now)}`, "dim")
    .add(`${theme.glyphs.separator}${groupDigits(snapshot.completeness.scannedEntries)} entries`, "dim")
    .add(`${theme.glyphs.separator}${snapshot.scope.accounting}`, "dim");
  if (!complete) {
    const inaccessible = snapshot.completeness.inaccessibleDirectories;
    line.add(
      `${theme.glyphs.separator}incomplete${inaccessible > 0n ? `: ${groupDigits(inaccessible)} unreadable dirs` : ""}`,
      "warn",
    );
  }
  if (state.explore.nextCursor !== undefined) {
    line.addRight("more below: n ", "muted");
  }
  return line.build();
}

/** A running scan, drawn as a panel: what it has read so far, and how to stop it. */
function scanProgress(context: ViewContext, home: string | undefined): ScreenLine[] {
  const { state, theme, width, height, now } = context;
  const scan = state.explore.scan;
  if (scan === undefined) {
    return fit([], height);
  }
  const seconds = Math.max(1, (now - scan.startedAt) / 1000);
  const rate = Number(scan.entries) / seconds;
  const label = (text: string): LineBuilder => new LineBuilder(width).add("    ").add(padEnd(text, 14), "muted");
  const lines: ScreenLine[] = [];
  for (let index = 0; index < Math.max(0, Math.floor(height / 2) - 5); index += 1) {
    lines.push({ spans: [] });
  }
  lines.push(
    new LineBuilder(width)
      .add(`  ${spinnerFrame(state.tick, theme)} `, "accent")
      .add("Scanning ", "strong")
      .add(truncateMiddle(homeRelative(scan.root.display, home, theme), width - 16, theme.glyphs.ellipsis), "strong")
      .build(),
  );
  lines.push({ spans: [] });
  lines.push(label("Entries").add(groupDigits(scan.entries), "strong").add(`   ${groupDigits(Math.round(rate))}/s`, "dim").build());
  lines.push(label("Bytes read").add(formatBytes(scan.bytes, state.units), "strong").build());
  lines.push(
    label("Unreadable")
      .add(groupDigits(scan.inaccessible), scan.inaccessible > 0n ? "warn" : "dim")
      .add(scan.inaccessible > 0n ? " directories (the result will say so)" : " directories", "dim")
      .build(),
  );
  lines.push(label("Elapsed").add(elapsed(scan.startedAt, now), "dim").build());
  if (scan.current !== undefined) {
    lines.push(label("Now in").add(truncateMiddle(homeRelative(scan.current, home, theme), width - 20, theme.glyphs.ellipsis), "dim").build());
  }
  lines.push({ spans: [] });
  lines.push(
    new LineBuilder(width)
      .add("    ")
      .add("Esc", "key")
      .add(" stops at the next directory; everything read so far is indexed and marked incomplete.", "muted")
      .build(),
  );
  return fit(lines, height);
}
