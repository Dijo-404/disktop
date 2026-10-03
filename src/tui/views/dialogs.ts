import type { ApplyOutcome } from "../../application/apply-action.js";
import type { UndoOutcome } from "../../application/undo.js";
import type { ActionOperation, ActionPlan } from "../../domain/actions.js";
import { describeCommand } from "../../domain/managers.js";
import { formatBytes } from "../../domain/sizes.js";
import { LineBuilder, type ScreenLine } from "../frame.js";
import { nextOperation, type Dialog } from "../state.js";
import { cellWidth, groupDigits, relativeAge, truncateMiddle, truncateStart, wrap } from "../text.js";
import { sanitizeText } from "../../domain/paths.js";
import type { StyleName, Theme } from "../themes.js";
import { boxInner, boxed, field } from "../widgets/box.js";
import { CATEGORY_LABELS, findingSizeText } from "./findings.js";
import type { ViewContext } from "./common.js";
import type { Hint } from "../widgets/chrome.js";

export const OPERATION_NAMES: Readonly<Record<ActionOperation, string>> = {
  trash: "Move to Trash",
  permanent: "Remove permanently",
  "empty-trash": "Empty Trash permanently",
  move: "Move to another disk",
  compress: "Compress",
  "dedup-hardlink": "Replace with a hardlink",
  manager: "Ask the package or container manager",
};

/** Whether applying this plan needs the word "yes" typed out rather than one key. */
export function needsTypedConfirmation(plan: ActionPlan): boolean {
  return plan.reversibility === "irreversible";
}

export interface DialogOutput {
  readonly lines: readonly ScreenLine[];
  readonly hints: readonly Hint[];
  readonly cursor?: { readonly row: number; readonly column: number };
}

export function renderDialog(dialog: Dialog, context: ViewContext, home: string | undefined): DialogOutput {
  switch (dialog.kind) {
    case "review":
      return reviewDialog(dialog, context, home);
    case "destination":
      return destinationDialog(dialog, context);
    case "applied":
      return appliedDialog(dialog.outcome, context);
    case "undo-confirm": {
      const inner = boxInner(context.width);
      const record = dialog.record;
      // A history page lists at most 1000 items; when it left some out, the
      // record's own count is the honest number, and it is an upper bound.
      const listed = record.items.filter((item) => item.outcome === "completed" && item.destination !== undefined).length;
      const omitted = (record.itemsOmitted ?? 0n) > 0n;
      const count = omitted ? groupDigits(record.completed) : groupDigits(listed);
      const plural = omitted ? record.completed !== 1n : listed !== 1;
      const content = [
        new LineBuilder(inner).add(`Put ${omitted ? "up to " : ""}${count} item${plural ? "s" : ""} back where ${plural ? "they were" : "it was"}?`, "strong").build(),
        { spans: [] },
        ...wrap(
          "Each item is moved out of Trash to its original path. Anything that now occupies an original path is left alone and that item is refused, so nothing is overwritten.",
          inner,
        ).map((text) => new LineBuilder(inner).add(text, "dim").build()),
        { spans: [] },
        field("Action", `${record.id} (${record.operation})`, inner),
        field("Started", relativeAge(Date.parse(record.startedAt), context.now), inner),
      ];
      return {
        lines: boxed("Undo", content, context.width, context.height, context.theme, "accent", footer([["y", "restore"], ["esc", "cancel"]], inner)),
        hints: [["y", "restore"], ["esc", "cancel"]],
      };
    }
    case "undone":
      return undoneDialog(dialog.outcome, context);
    case "refused": {
      const inner = boxInner(context.width);
      const content = [
        new LineBuilder(inner).add(`${context.theme.glyphs.fail} `, "danger").add(dialog.failure.code, "danger").build(),
        { spans: [] },
        ...wrap(dialog.failure.message, inner).map((text) => new LineBuilder(inner).add(text).build()),
        ...Object.entries(dialog.failure.details ?? {}).map(([key, value]) => field(key, value, inner)),
        { spans: [] },
        new LineBuilder(inner).add("Nothing was changed.", "dim").build(),
      ];
      return {
        lines: boxed(dialog.title, content, context.width, context.height, context.theme, "danger", footer([["esc", "close"]], inner)),
        hints: [["esc", "close"]],
      };
    }
    case "unavailable": {
      const inner = boxInner(context.width);
      const content = [
        new LineBuilder(inner).add(`${context.theme.glyphs.warn} `, "warn").add(dialog.capability.status, "warn").build(),
        { spans: [] },
        ...wrap(dialog.capability.explanation, inner).map((text) => new LineBuilder(inner).add(text).build()),
      ];
      return {
        lines: boxed(dialog.title, content, context.width, context.height, context.theme, "warn", footer([["esc", "close"]], inner)),
        hints: [["esc", "close"]],
      };
    }
    case "confirm-scan": {
      const inner = boxInner(context.width);
      const content = [
        new LineBuilder(inner).add("Scan ", "strong").add(truncateMiddle(dialog.path.display, inner - 6, context.theme.glyphs.ellipsis), "strong").add("?", "strong").build(),
        { spans: [] },
        ...wrap(dialog.reason, inner).map((text) => new LineBuilder(inner).add(text, "dim").build()),
        { spans: [] },
        ...wrap(
          "A scan reads names and sizes only, changes nothing, and stays on this one filesystem. Directories you cannot read are counted and reported, never shown as empty.",
          inner,
        ).map((text) => new LineBuilder(inner).add(text, "dim").build()),
      ];
      return {
        lines: boxed("Scan", content, context.width, context.height, context.theme, "accent", footer([["y", "scan"], ["esc", "cancel"]], inner)),
        hints: [["y", "scan"], ["esc", "cancel"]],
      };
    }
    case "finding":
      return findingDialog(dialog, context, home);
  }
}

function footer(hints: readonly Hint[], width: number): ScreenLine {
  const line = new LineBuilder(width);
  for (const [key, label] of hints) {
    line.add(key, "key").add(` ${label}   `, "muted");
  }
  return line.build();
}

function homeRelative(display: string, home: string | undefined, theme: Theme): string {
  return home !== undefined && home !== "/" && display.startsWith(`${home}/`) ? `${theme.glyphs.home}${display.slice(home.length)}` : display;
}

/** The smallest terminal a plan can be reviewed in: what it does has to fit on screen. */
export const REVIEW_MINIMUM = { columns: 60, rows: 20 } as const;

export function reviewFits(size: { readonly columns: number; readonly rows: number }): boolean {
  return size.columns >= REVIEW_MINIMUM.columns && size.rows >= REVIEW_MINIMUM.rows;
}

function reviewDialog(dialog: Extract<Dialog, { kind: "review" }>, context: ViewContext, home: string | undefined): DialogOutput {
  const { theme, width, height, state } = context;
  const plan = dialog.plan;
  const inner = boxInner(width);
  // A plan is confirmed only where it can be read in full: target, operation,
  // undo, and the field to type into. Below that size it says so and offers
  // no confirmation; the controller refuses one as well.
  if (!reviewFits({ columns: width, rows: height + 4 })) {
    const times = theme.unicode ? "×" : "x";
    const content = wrap(
      `Make the terminal larger to review this plan: it needs ${REVIEW_MINIMUM.columns}${times}${REVIEW_MINIMUM.rows} and this is ${width}${times}${height + 4}. Nothing has been applied.`,
      inner,
    ).map((text) => new LineBuilder(inner).add(text, "warn").build());
    return {
      lines: boxed("Review plan", content, width, height, theme, "warn", footer([["esc", "cancel"]], inner)),
      hints: [["esc", "cancel"]],
    };
  }
  const irreversible = needsTypedConfirmation(plan);
  const content: ScreenLine[] = [];

  for (const text of wrap(plan.scopeSummary, inner)) {
    content.push(new LineBuilder(inner).add(text, "strong").build());
  }
  content.push({ spans: [] });
  content.push(
    field(
      "Operation",
      [
        { text: OPERATION_NAMES[plan.operation], style: irreversible ? "danger" : "strong" },
        { text: plan.sourceDisposition === undefined ? "" : `, source to ${plan.sourceDisposition}`, style: "dim" },
      ],
      inner,
    ),
  );
  content.push(
    field(
      "Undo",
      irreversible
        ? [{ text: `${theme.glyphs.warn} cannot be undone`, style: "danger" }]
        : [{ text: `${theme.glyphs.ok} from the History tab`, style: "ok" }],
      inner,
    ),
  );
  const managerCount = plan.manager?.count;
  const count =
    plan.exactItemCount !== undefined
      ? groupDigits(plan.exactItemCount)
      : managerCount === undefined || managerCount.kind === "unknown"
        ? "unknown"
        : `${managerCount.kind === "estimated" ? "~" : ""}${groupDigits(managerCount.value)}`;
  content.push(
    field(
      "Selected",
      [
        { text: plan.selectedBytes === undefined ? "size unknown" : formatBytes(plan.selectedBytes, state.units), style: "strong" },
        { text: `${theme.glyphs.separator}${count} item${count === "1" ? "" : "s"}`, style: "dim" },
      ],
      inner,
    ),
  );
  content.push(
    field(
      "Permission",
      plan.permission === "manager-privilege"
        ? [{ text: "administrator: sudo or pkexec will ask, for this command only", style: "warn" }]
        : [{ text: "your user", style: "normal" }],
      inner,
    ),
  );
  if (plan.destination !== undefined) {
    content.push(field("Destination", truncateMiddle(homeRelative(plan.destination.display, home, theme), inner - 14, theme.glyphs.ellipsis), inner));
  }
  const minutes = Math.max(0, Math.round((Date.parse(plan.expiresAt) - context.now) / 60_000));
  content.push(field("Expires", minutes < 1 ? "in under a minute" : minutes < 120 ? `in ${minutes} min` : `in ${Math.round(minutes / 60)} h`, inner));

  if (dialog.pair !== undefined && plan.operation === "trash") {
    for (const text of wrap(
      "This is one copy of a duplicate group. A Trash move does not compare it with the kept copy again; it can be undone from History. o offers a hardlink replacement, which compares both in full first.",
      inner - 2,
    )) {
      content.push(new LineBuilder(inner).add(`${theme.glyphs.info} `, "info").add(text, "dim").build());
    }
  }
  if (plan.manager !== undefined) {
    content.push({ spans: [] });
    for (const command of plan.manager.commands.slice(0, 3)) {
      content.push(new LineBuilder(inner).add("$ ", "muted").add(describeCommand(command, plan.manager.privilege), "strong").build());
    }
    // Every command this plan runs is counted, even when not every one fits.
    if (plan.manager.commands.length > 3) {
      const more = plan.manager.commands.length - 3;
      content.push(new LineBuilder(inner).add(`  and ${more} more of the same, ${groupDigits(BigInt(plan.manager.commands.length))} in all`, "warn").build());
    }
  }
  for (const warning of plan.warnings) {
    for (const [index, text] of wrap(warning, inner - 2).entries()) {
      content.push(new LineBuilder(inner).add(index === 0 ? `${theme.glyphs.warn} ` : "  ", "warn").add(text, "warn").build());
    }
  }
  const entries = plan.entries ?? [];
  if (entries.length > 0) {
    content.push({ spans: [] });
    const room = Math.max(0, height - 4 - content.length - 1);
    for (const entry of entries.slice(0, room)) {
      content.push(
        new LineBuilder(inner)
          .add("  ")
          .add(truncateMiddle(homeRelative(entry.path.display, home, theme), inner - 14, theme.glyphs.ellipsis))
          .addRight(formatBytes(entry.reviewedBytes, state.units), "dim")
          .build(),
      );
    }
    if (entries.length > room && room > 0) {
      content[content.length - 1] = new LineBuilder(inner).add(`  ${theme.glyphs.ellipsis} and ${entries.length - room + 1} more`, "muted").build();
    }
  }

  let cursor: DialogOutput["cursor"];
  let footerLine: ScreenLine;
  const next = nextOperation(dialog.alternatives, plan.operation);
  if (irreversible) {
    const line = new LineBuilder(inner).add("Type ", "danger").add("yes", "strong").add(" and press Enter to apply: ", "danger");
    const column = line.used;
    line.add(dialog.typed, "input");
    // No other-operation key here: every printable key goes into the field.
    footerLine = line.add("   esc cancel", "muted").build();
    const boxWidth = Math.max(20, Math.min(width - 2, 96));
    const left = Math.max(0, Math.floor((width - boxWidth) / 2));
    cursor = { row: context.top + height - 2, column: left + 2 + column + dialog.typed.length };
  } else {
    footerLine = footer(
      [
        ["y", "apply"],
        ...(next === undefined ? [] : ([["o", `instead: ${OPERATION_NAMES[next].toLowerCase()}`]] as Hint[])),
        ["esc", "cancel"],
      ],
      inner,
    );
  }

  return {
    lines: boxed(irreversible ? "Review irreversible plan" : "Review plan", content, width, height, theme, irreversible ? "danger" : "accent", footerLine),
    hints: irreversible ? [[`yes ${theme.glyphs.enter}`, "apply"], ["esc", "cancel"]] : [["y", "apply"], ["o", "operation"], ["esc", "cancel"]],
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/**
 * Where a move or a compression publishes, typed before anything is planned.
 *
 * The field is the footer, which a short terminal keeps when it drops content,
 * so what is being typed is always on screen. It shows its end when it is too
 * long, because the end of a path names the directory. What becomes of the
 * source comes first, since a short terminal keeps the top of the content.
 */
function destinationDialog(dialog: Extract<Dialog, { kind: "destination" }>, context: ViewContext): DialogOutput {
  const { theme, width, height } = context;
  const inner = boxInner(width);
  const permanent = dialog.disposition === "permanent";
  const content: ScreenLine[] = [
    field(
      "Source after",
      permanent
        ? [{ text: `${theme.glyphs.warn} removed permanently, cannot be undone`, style: "danger" }]
        : [{ text: `${theme.glyphs.ok} moved to Trash, can be undone`, style: "ok" }],
      inner,
    ),
  ];
  if (dialog.error !== undefined) {
    for (const [index, text] of wrap(dialog.error, inner - 2).entries()) {
      content.push(new LineBuilder(inner).add(index === 0 ? `${theme.glyphs.warn} ` : "  ", "warn").add(text, "warn").build());
    }
  }
  content.push({ spans: [] });
  const explanation =
    dialog.operation === "move"
      ? "Type the directory on another disk to copy it into. The copy is verified before the source is touched. ~/ is your home."
      : "Type the directory the archive goes into, or leave it empty to put it beside the source. The archive is verified before the source is touched.";
  for (const text of wrap(explanation, inner)) {
    content.push(new LineBuilder(inner).add(text, "dim").build());
  }
  content.push({ spans: [] });
  content.push(footer([["tab", permanent ? "Trash instead" : "permanent instead"], [theme.glyphs.enter, "review"], ["esc", "cancel"]], inner));

  const line = new LineBuilder(inner).add("Into ", "muted");
  const column = line.used;
  // One cell is kept for the cursor after the last character.
  const shown = truncateStart(sanitizeText(dialog.text), Math.max(0, inner - column - 1), theme.glyphs.ellipsis);
  line.add(shown, "input");
  const boxWidth = Math.max(20, Math.min(width - 2, 96));
  const left = Math.max(0, Math.floor((width - boxWidth) / 2));
  const hints: Hint[] = [["tab", "Trash/permanent"], [theme.glyphs.enter, "review"], ["esc", "cancel"]];
  return {
    lines: boxed(OPERATION_NAMES[dialog.operation], content, width, height, theme, permanent ? "danger" : "accent", line.build()),
    hints,
    cursor: { row: context.top + height - 2, column: left + 2 + column + cellWidth(shown) },
  };
}

function appliedDialog(outcome: ApplyOutcome, context: ViewContext): DialogOutput {
  const { theme, width, height, state } = context;
  const inner = boxInner(width);
  if (outcome.kind !== "applied") {
    const message = outcome.kind === "refused" ? outcome.failure.message : outcome.capability.explanation;
    const content = wrap(message, inner).map((text) => new LineBuilder(inner).add(text).build());
    return {
      lines: boxed("Not applied", content, width, height, theme, "danger", footer([["esc", "close"]], inner)),
      hints: [["esc", "close"]],
    };
  }
  const { result, plan } = outcome;
  const tone: StyleName = result.state === "complete" ? "ok" : result.state === "partial" ? "warn" : "danger";
  const title = result.state === "complete" ? "Applied" : result.state === "partial" ? "Partly applied" : "Applied with uncertainty";
  const content: ScreenLine[] = [];
  content.push(
    new LineBuilder(inner)
      .add(`${result.state === "complete" ? theme.glyphs.ok : theme.glyphs.warn} `, tone)
      .add(`${groupDigits(result.completed)} done`, "ok")
      .add(`${theme.glyphs.separator}${groupDigits(result.skipped)} skipped`, result.skipped > 0n ? "warn" : "dim")
      .add(`${theme.glyphs.separator}${groupDigits(result.failed)} failed`, result.failed > 0n ? "danger" : "dim")
      .build(),
  );
  content.push({ spans: [] });
  content.push(field("Selected", result.selectedBytes === undefined ? "unknown" : formatBytes(result.selectedBytes, state.units), inner, 18));
  content.push(field("Moved to Trash", formatBytes(result.bytesMovedToTrash, state.units), inner, 18));
  const change = outcome.observedFreeSpaceChange;
  content.push(
    field(
      "Free space",
      change === undefined
        ? [{ text: "could not be read before and after", style: "muted" }]
        : [
            { text: `${change >= 0n ? "+" : "-"}${formatBytes(change >= 0n ? change : -change, state.units)}`, style: "strong" },
            { text: " observed (other programs write too)", style: "dim" },
          ],
      inner,
      18,
    ),
  );
  content.push(
    field(
      "Undo",
      result.undoAvailable
        ? [{ text: "History tab, select it, press u", style: "ok" }]
        : [{ text: plan.reversibility === "irreversible" ? "not possible: this was irreversible" : "nothing left to restore", style: "muted" }],
      inner,
      18,
    ),
  );
  if (result.verification.length > 0) {
    content.push({ spans: [] });
    for (const check of result.verification) {
      const icon = check.outcome === "passed" ? theme.glyphs.ok : check.outcome === "failed" ? theme.glyphs.fail : "?";
      const style: StyleName = check.outcome === "passed" ? "ok" : check.outcome === "failed" ? "danger" : "muted";
      content.push(new LineBuilder(inner).add(`${icon} `, style).add(check.check, "strong").add(`  ${check.detail}`, "dim").build());
    }
  }
  for (const note of outcome.notes) {
    for (const [index, text] of wrap(note, inner - 2).entries()) {
      content.push(new LineBuilder(inner).add(index === 0 ? `${theme.glyphs.info} ` : "  ", "info").add(text, "dim").build());
    }
  }
  return {
    lines: boxed(title, content, width, height, theme, tone === "ok" ? "accent" : tone, footer([["esc", "close"]], inner)),
    hints: [["esc", "close"]],
  };
}

function undoneDialog(outcome: UndoOutcome, context: ViewContext): DialogOutput {
  const { theme, width, height, state } = context;
  const inner = boxInner(width);
  if (outcome.kind !== "restored") {
    const message = outcome.kind === "refused" ? outcome.failure.message : outcome.capability.explanation;
    return {
      lines: boxed("Not restored", wrap(message, inner).map((text) => new LineBuilder(inner).add(text).build()), width, height, theme, "danger", footer([["esc", "close"]], inner)),
      hints: [["esc", "close"]],
    };
  }
  const { result } = outcome;
  const content: ScreenLine[] = [
    new LineBuilder(inner)
      .add(`${result.state === "complete" ? theme.glyphs.ok : theme.glyphs.warn} `, result.state === "complete" ? "ok" : "warn")
      .add(`${groupDigits(result.completed)} restored`, "ok")
      .add(`${theme.glyphs.separator}${groupDigits(result.skipped)} skipped`, result.skipped > 0n ? "warn" : "dim")
      .add(`${theme.glyphs.separator}${groupDigits(result.failed)} failed`, result.failed > 0n ? "danger" : "dim")
      .build(),
    { spans: [] },
    field("Restored bytes", result.selectedBytes === undefined ? "unknown" : formatBytes(result.selectedBytes, state.units), inner, 18),
  ];
  for (const note of outcome.notes) {
    for (const [index, text] of wrap(note, inner - 2).entries()) {
      content.push(new LineBuilder(inner).add(index === 0 ? `${theme.glyphs.info} ` : "  ", "info").add(text, "dim").build());
    }
  }
  return {
    lines: boxed("Restored", content, width, height, theme, "accent", footer([["esc", "close"]], inner)),
    hints: [["esc", "close"]],
  };
}

function findingDialog(dialog: Extract<Dialog, { kind: "finding" }>, context: ViewContext, home: string | undefined): DialogOutput {
  const { theme, width, height, state } = context;
  const finding = dialog.finding;
  const inner = boxInner(width);
  const all: ScreenLine[] = [];
  const size = findingSizeText(finding, state.units);
  all.push(field("Category", CATEGORY_LABELS[finding.category], inner));
  all.push(
    field(
      "Size",
      [
        { text: size.text, style: "strong" },
        { text: `  ${finding.size.basis}`, style: "dim" },
      ],
      inner,
    ),
  );
  for (const text of wrap(finding.size.explanation, inner - 14)) {
    all.push(field("", [{ text, style: "dim" }], inner));
  }
  all.push(field("Confidence", finding.confidence, inner));
  all.push(field("In use", finding.active ? [{ text: "yes: closing what uses it first is safer", style: "warn" }] : "no", inner));
  all.push(
    field(
      "Detector",
      [
        { text: `${finding.providerId} v${finding.providerVersion}`, style: "normal" },
        { text: finding.capability.status === "available" ? "" : `  ${finding.capability.status}`, style: "warn" },
      ],
      inner,
    ),
  );
  if (finding.capability.status !== "available") {
    for (const text of wrap(finding.capability.explanation, inner - 14)) {
      all.push(field("", [{ text, style: "warn" }], inner));
    }
  }
  all.push(field("Actions", finding.availableActionIds.length === 0 ? "none: this is information only" : finding.availableActionIds.join(", "), inner));
  if (finding.regenerationCost !== undefined) {
    for (const [index, text] of wrap(finding.regenerationCost, inner - 14).entries()) {
      all.push(field(index === 0 ? "Regenerates" : "", text, inner));
    }
  }
  if (finding.managerScope !== undefined) {
    all.push(field("Manager", finding.managerScope, inner));
  }
  all.push({ spans: [] });
  for (const evidence of finding.evidence) {
    for (const [index, text] of wrap(evidence, inner - 2).entries()) {
      all.push(new LineBuilder(inner).add(index === 0 ? `${theme.glyphs.bullet} ` : "  ", "muted").add(text, "dim").build());
    }
  }
  if (finding.paths.length > 0) {
    all.push({ spans: [] });
    for (const path of finding.paths) {
      all.push(new LineBuilder(inner).add("  ").add(truncateMiddle(homeRelative(path.display, home, theme), inner - 2, theme.glyphs.ellipsis)).build());
    }
  }
  const room = Math.max(1, height - 3);
  const scroll = Math.max(0, Math.min(dialog.scroll, Math.max(0, all.length - room)));
  const canPlan = finding.availableActionIds.length > 0 && finding.capability.status === "available";
  const hints: Hint[] = [...(canPlan ? ([["c", "review plan"]] as Hint[]) : []), ["j/k", "scroll"], ["esc", "close"]];
  return {
    lines: boxed(finding.title, all.slice(scroll, scroll + room), width, height, theme, "accent", footer(hints, inner)),
    hints,
  };
}
