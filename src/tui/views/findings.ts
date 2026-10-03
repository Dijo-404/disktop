import { categoryTotals, type Finding, type FindingCategory } from "../../domain/findings.js";
import { formatBytes } from "../../domain/sizes.js";
import { LineBuilder, type HitRegion, type ScreenLine } from "../frame.js";
import { findingsFor, isActionable, type FindingsTab } from "../state.js";
import { cellWidth, padEnd, padStart, relativeAge, truncate, truncateMiddle } from "../text.js";
import type { Theme } from "../themes.js";
import { SERIES, barSpans, seriesGlyph, sharePercent, stackedBarSpans } from "../widgets/bars.js";
import { ruleLine, spinnerFrame, type Hint } from "../widgets/chrome.js";
import { emptyState, fit, listWindow, type ViewContext, type ViewOutput } from "./common.js";

/** Short names for categories, so a column can hold them at 80 columns. */
export const CATEGORY_LABELS: Readonly<Record<FindingCategory, string>> = {
  "dev-environment": "dev env",
  "project-artifact": "build output",
  "language-cache": "lang cache",
  "ai-cache": "AI models",
  "ide-cache": "IDE cache",
  "browser-cache": "browser",
  "app-cache": "app cache",
  "game-data": "games",
  "vm-image": "VM image",
  "system-snapshot": "snapshot",
  "installed-app": "app",
  log: "log",
  "crash-dump": "crash dump",
  swap: "swap",
  temporary: "temporary",
  diagnostic: "diagnostic",
  "per-user-usage": "per user",
  "package-cache": "pkg cache",
  "container-data": "containers",
  "old-kernel": "old kernel",
};

const TAB_INTROS: Readonly<Record<FindingsTab, string>> = {
  Clean: "Everything the detectors found that a reviewed plan could act on",
  Dev: "Developer environments, build output, and language, AI, and IDE caches",
  Apps: "Installed applications, their caches, games, and virtual machines",
};

/** A size as text that cannot be mistaken for a measurement it is not. */
export function findingSizeText(finding: Finding, units: "iec" | "si"): { text: string; exact: boolean } {
  const bytes = finding.size.bytes;
  if (bytes === undefined) {
    return { text: "unknown", exact: false };
  }
  const formatted = formatBytes(bytes, units);
  return finding.size.basis === "manager-reported" ? { text: `~${formatted}`, exact: false } : { text: formatted, exact: true };
}

/** The operation a plan would fix by default, as it would be offered. */
export function defaultOperation(finding: Finding): string | undefined {
  const actions = finding.availableActionIds;
  if (actions.includes("manager")) {
    return "manager";
  }
  if (actions.includes("trash")) {
    return "trash";
  }
  return actions[0];
}

function actionLabel(finding: Finding): { text: string; style: "ok" | "warn" | "muted" | "danger" } {
  if (finding.capability.status !== "available") {
    return { text: finding.capability.status, style: "warn" };
  }
  const operation = defaultOperation(finding);
  if (operation === undefined) {
    return { text: "info only", style: "muted" };
  }
  if (operation === "trash") {
    return { text: "to Trash", style: "ok" };
  }
  if (operation === "manager") {
    return { text: "via manager", style: "warn" };
  }
  return { text: operation, style: "danger" };
}

function hintsFor(tab: FindingsTab, theme: Theme, loaded: boolean): Hint[] {
  if (!loaded) {
    return [["esc", "stop"], ["1-6", "tabs"], ["q", "quit"]];
  }
  return [
    ["j/k", "move"],
    [theme.glyphs.enter, "details"],
    ["c", "review plan"],
    ["p", "detectors"],
    ["r", "look again"],
    ["U", "units"],
    ...(tab === "Clean" ? [] : ([["h/l", "tabs"]] as Hint[])),
  ];
}

export function renderFindings(context: ViewContext, tab: FindingsTab, home: string | undefined): ViewOutput {
  const { state, theme, width, height } = context;
  const summary = state.findings.summary;

  if (summary === undefined) {
    const message =
      state.findings.failure !== undefined
        ? [state.findings.failure, "Press r to try again."]
        : state.busy === undefined
          ? ["Nothing has been looked for yet.", "Press r to ask every detector what it can see. Nothing is changed by looking."]
          : [
              `${spinnerFrame(state.tick, theme)} Asking every detector what it can see${theme.glyphs.ellipsis}`,
              "Sizes are measured from the scan index in one pass. On a large home directory this takes a while; Esc stops it.",
            ];
    return {
      lines: emptyState(message, width, height, theme, undefined, state.findings.failure === undefined ? "strong" : "danger"),
      hits: [],
      hints: hintsFor(tab, theme, false),
    };
  }

  if (state.findings.showProviders) {
    return { lines: providerLines(context), hits: [], hints: [["p", "back to findings"], ["r", "look again"], ["q", "quit"]] };
  }

  const findings = findingsFor(tab, summary.findings);
  const lines: ScreenLine[] = [];
  const hits: HitRegion[] = [];
  // Only what a plan could act on is totalled: a swap partition or a SMART
  // reading is worth seeing and is not space anybody can reclaim.
  const actionable = findings.filter(isActionable);
  const informational = findings.length - actionable.length;
  const totals = categoryTotals(actionable);
  const measured = totals.reduce((sum, total) => sum + total.bytes, 0n);
  const unmeasured = totals.reduce((sum, total) => sum + total.unmeasured, 0);

  const intro = new LineBuilder(width).add(" ");
  if (findings.length === 0) {
    intro.add(TAB_INTROS[tab], "title");
  } else {
    intro.add(formatBytes(measured, state.units), "title").add(` in ${actionable.length} to review`, "dim");
    if (unmeasured > 0) {
      intro.add(`${theme.glyphs.separator}${unmeasured} unmeasured`, "warn");
    }
    if (informational > 0) {
      intro.add(`${theme.glyphs.separator}${informational} for information`, "muted");
    }
  }
  const unavailable = summary.providers.filter((provider) => !provider.ran || provider.capability.status !== "available").length;
  const status = `${summary.complete ? "" : "incomplete · "}${unavailable > 0 ? `${unavailable} detector${unavailable === 1 ? "" : "s"} unavailable (p)` : `${summary.providers.length} detectors`}`;
  intro.addRight(status, summary.complete ? "muted" : "warn", 1);
  lines.push(intro.build());

  if (findings.length > 0 && measured > 0n) {
    lines.push(distributionLine(totals, measured, context));
  }

  if (findings.length === 0) {
    for (const line of emptyState(
      [
        `${theme.glyphs.ok} Nothing to show here.`,
        tab === "Clean"
          ? "No detector found anything it could offer to clean. Unavailable detectors are listed under p."
          : `${TAB_INTROS[tab]}: none were found on this machine.`,
      ],
      width,
      height - lines.length,
      theme,
    )) {
      lines.push(line);
    }
    return { lines: fit(lines, height), hits, hints: hintsFor(tab, theme, true), status: statusFor(context) };
  }

  const detailHeight = height >= 14 ? 4 : 0;
  const columns = { size: 11, bar: width >= 76 ? 10 : 0, category: width >= 66 ? 13 : 0, action: width >= 58 ? 13 : 0 };
  const titleWidth = Math.max(10, width - 2 - columns.size - (columns.bar > 0 ? columns.bar + 1 : 0) - 1 - columns.category - columns.action);
  const header = new LineBuilder(width).add("  ").add(padStart("SIZE", columns.size - 1), "heading").add(" ");
  if (columns.bar > 0) header.add(" ".repeat(columns.bar + 1));
  header.add("    ").add(padEnd("FINDING", titleWidth - 3), "heading");
  if (columns.category > 0) header.add(padEnd("CATEGORY", columns.category), "heading");
  if (columns.action > 0) header.add(padEnd("ACTION", columns.action), "heading");
  lines.push(header.build());

  const listRows = Math.max(1, height - lines.length - detailHeight);
  const selected = state.findings.selected[tab];
  const window = listWindow(selected, findings.length, listRows);
  const largest = findings.reduce((max, finding) => (finding.size.bytes !== undefined && finding.size.bytes > max ? finding.size.bytes : max), 0n);
  for (let index = window.start; index < window.end; index += 1) {
    const finding = findings[index] as Finding;
    hits.push({ row: context.top + lines.length, from: 0, to: width, action: { kind: "row", index } });
    const line = new LineBuilder(width);
    const isSelected = index === selected;
    line.add(isSelected ? `${theme.glyphs.pointer} ` : "  ", "accent");
    const size = findingSizeText(finding, state.units);
    line.add(padStart(size.text, columns.size - 1), size.exact ? "strong" : finding.size.bytes === undefined ? "muted" : "normal").add(" ");
    if (columns.bar > 0) {
      line.add(" ");
      const percent = finding.size.bytes === undefined ? 0 : sharePercent(finding.size.bytes, largest);
      for (const span of barSpans(percent, columns.bar, theme, finding.active ? "barWarn" : "barUsed")) {
        line.add(span.text, span.style);
      }
    }
    line.add(finding.active ? ` ${theme.glyphs.info} ` : "   ", "warn");
    line.add(truncate(finding.title, titleWidth - 4, theme.glyphs.ellipsis), isActionable(finding) ? "normal" : "dim");
    if (columns.category > 0) {
      line.padTo(width - columns.category - columns.action).add(padEnd(CATEGORY_LABELS[finding.category], columns.category - 1), "dim");
    }
    if (columns.action > 0) {
      const action = actionLabel(finding);
      line.padTo(width - columns.action).add(padEnd(action.text, columns.action - 1), action.style);
    }
    lines.push(line.build({ selected: isSelected }));
  }

  const body = fit(lines, height - detailHeight);
  const current = findings[selected];
  if (detailHeight > 0 && current !== undefined) {
    for (const line of detailLines(current, context, home)) {
      body.push(line);
    }
  }
  return { lines: fit(body, height), hits, hints: hintsFor(tab, theme, true), status: statusFor(context) };
}

/** Where the reclaimable bytes are, by category: a stacked bar and its legend. */
function distributionLine(totals: ReturnType<typeof categoryTotals>, whole: bigint, context: ViewContext): ScreenLine {
  const { state, theme, width } = context;
  const ranked = [...totals].filter((total) => total.bytes > 0n).sort((left, right) => (left.bytes > right.bytes ? -1 : left.bytes < right.bytes ? 1 : 0));
  const shown = ranked.slice(0, width >= 100 ? 5 : 3);
  const rest = whole - shown.reduce((sum, total) => sum + total.bytes, 0n);
  const barWidth = Math.max(10, Math.min(28, Math.floor(width / 4)));
  const line = new LineBuilder(width).add(" ");
  const segments = [
    ...shown.map((total, index) => ({ value: total.bytes, style: SERIES[index] ?? "series6", glyph: seriesGlyph(index, theme) })),
    ...(rest > 0n ? [{ value: rest, style: "series6" as const, glyph: seriesGlyph(5, theme) }] : []),
  ];
  for (const span of stackedBarSpans(segments, whole, barWidth, theme)) {
    line.add(span.text, span.style);
  }
  line.add("  ");
  for (const [index, total] of shown.entries()) {
    const text = `${CATEGORY_LABELS[total.category]} ${formatBytes(total.bytes, state.units)}`;
    if (line.remaining < cellWidth(text) + 4) {
      break;
    }
    const glyph = theme.color === "none" ? seriesGlyph(index, theme) : theme.glyphs.legend;
    line.add(glyph, SERIES[index] ?? "series6").add(` ${text}  `, "dim");
  }
  if (rest > 0n && line.remaining > 16) {
    line.add(theme.color === "none" ? seriesGlyph(5, theme) : theme.glyphs.legend, "series6").add(` other ${formatBytes(rest, state.units)}`, "dim");
  }
  return line.build();
}

function detailLines(finding: Finding, context: ViewContext, home: string | undefined): ScreenLine[] {
  const { theme, width } = context;
  const lines: ScreenLine[] = [ruleLine(truncate(finding.title, Math.max(8, width - 12), theme.glyphs.ellipsis), width, theme)];
  const first = new LineBuilder(width).add("  ");
  const path = finding.paths[0];
  if (path !== undefined) {
    const where = home !== undefined && path.display.startsWith(`${home}/`) ? `${theme.glyphs.home}${path.display.slice(home.length)}` : path.display;
    first.add(truncateMiddle(where, width - 24, theme.glyphs.ellipsis), "strong");
    if (finding.paths.length > 1) {
      first.add(` and ${finding.paths.length - 1} more`, "dim");
    }
  } else if (finding.managerScope !== undefined) {
    first.add(finding.managerScope, "strong");
  }
  first.addRight(`${finding.confidence}${theme.glyphs.separator}${finding.size.basis}`, "muted", 1);
  lines.push(first.build());
  lines.push(new LineBuilder(width).add("  ").add(finding.evidence[0] ?? finding.size.explanation, "dim").build());
  const last = new LineBuilder(width).add("  ");
  if (finding.capability.status !== "available") {
    last.add(`${theme.glyphs.warn} ${finding.capability.explanation}`, "warn");
  } else if (finding.regenerationCost !== undefined) {
    last.add("Regenerates: ", "muted").add(finding.regenerationCost, "dim");
  } else {
    last.add(finding.size.explanation, "muted");
  }
  lines.push(last.build());
  return lines;
}

function providerLines(context: ViewContext): ScreenLine[] {
  const { state, theme, width, height } = context;
  const summary = state.findings.summary;
  const lines: ScreenLine[] = [];
  lines.push(new LineBuilder(width).add(" Detectors", "title").add("  what each one could see, and why not when it could not", "dim").build());
  lines.push(
    new LineBuilder(width)
      .add("  ")
      .add(padEnd("DETECTOR", 28), "heading")
      .add(padEnd("STATE", 20), "heading")
      .add(padStart("FOUND", 6), "heading")
      .add("  WHY", "heading")
      .build(),
  );
  const providers = [...(summary?.providers ?? [])].sort((left, right) => Number(left.ran && left.capability.status === "available") - Number(right.ran && right.capability.status === "available"));
  for (const provider of providers.slice(0, Math.max(0, height - 3))) {
    const ok = provider.ran && provider.capability.status === "available";
    lines.push(
      new LineBuilder(width)
        .add("  ")
        .add(padEnd(provider.providerId, 28, theme.glyphs.ellipsis), ok ? "normal" : "strong")
        .add(padEnd(`${ok ? theme.glyphs.ok : theme.glyphs.warn} ${provider.capability.status}`, 20), ok ? "ok" : provider.capability.status === "missing-tool" ? "muted" : "warn")
        .add(padStart(String(provider.findings), 6), "dim")
        .add(`  ${ok ? "" : provider.capability.explanation}`, "dim")
        .build(),
    );
  }
  if ((summary?.providers.length ?? 0) > height - 3) {
    lines.push(new LineBuilder(width).add(`  ${theme.glyphs.ellipsis} ${(summary?.providers.length ?? 0) - (height - 3)} more`, "muted").build());
  }
  return fit(lines, height);
}

function statusFor(context: ViewContext): ScreenLine | undefined {
  const { state, theme, width, now } = context;
  const summary = state.findings.summary;
  if (summary === undefined || state.findings.loadedAt === undefined) {
    return undefined;
  }
  const line = new LineBuilder(width).add(" ");
  line
    .add(summary.complete ? theme.glyphs.ok : theme.glyphs.warn, summary.complete ? "ok" : "warn")
    .add(` looked ${relativeAge(state.findings.loadedAt, now)}`, "dim")
    .add(summary.measured ? `${theme.glyphs.separator}sizes measured` : `${theme.glyphs.separator}sizes not measured`, "dim");
  const firstWarning = summary.warnings[0];
  if (firstWarning !== undefined) {
    line.add(`${theme.glyphs.separator}${firstWarning.message}`, "warn");
  }
  return line.build();
}
