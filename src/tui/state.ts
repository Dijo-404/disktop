import type { InventoryView } from "../application/dashboard.js";
import type { DecidedGroup } from "../application/duplicates.js";
import type { FootprintSummary } from "../application/footprint.js";
import type { ApplyOutcome } from "../application/apply-action.js";
import type { UndoOutcome } from "../application/undo.js";
import type { ActionOperation, ActionPlan, SourceDisposition } from "../domain/actions.js";
import type { DuplicateFile } from "../domain/duplicates.js";
import type { OperationFailure } from "../domain/errors.js";
import type { Finding, FindingCategory } from "../domain/findings.js";
import type { Capability, IndexedEntry, RawPath, Warning } from "../domain/models.js";
import type { StalenessBasis } from "../domain/staleness.js";
import type { JournalRecord } from "../ports/actions.js";
import type { EntrySort, TypeTotal } from "../ports/scan.js";
import type { SnapshotSummary } from "../ports/snapshots.js";
import type { SearchQuery } from "./search.js";

export const TABS = ["Disks", "Explore", "Clean", "Dev", "Apps", "History"] as const;
export type TabName = (typeof TABS)[number];

/** The finding categories each findings tab shows. Clean shows everything else. */
export const DEV_CATEGORIES: ReadonlySet<FindingCategory> = new Set<FindingCategory>([
  "dev-environment",
  "project-artifact",
  "language-cache",
  "ai-cache",
  "ide-cache",
]);
export const APP_CATEGORIES: ReadonlySet<FindingCategory> = new Set<FindingCategory>([
  "installed-app",
  "app-cache",
  "browser-cache",
  "game-data",
  "vm-image",
]);

export type FindingsTab = "Clean" | "Dev" | "Apps";

/** Whether a plan could be made for this finding at all. */
export function isActionable(finding: Finding): boolean {
  return finding.availableActionIds.length > 0 && finding.capability.status === "available";
}

/**
 * The findings a tab lists: what can be acted on first, then what is there
 * for information, each part in the size order discovery returned.
 */
export function findingsFor(tab: FindingsTab, findings: readonly Finding[]): readonly Finding[] {
  const shown =
    tab === "Dev"
      ? findings.filter((finding) => DEV_CATEGORIES.has(finding.category))
      : tab === "Apps"
        ? findings.filter((finding) => APP_CATEGORIES.has(finding.category))
        : // An installed application is inventory, shown under Apps, and never
          // a cleanup candidate in its own right.
          findings.filter((finding) => finding.category !== "installed-app");
  return [...shown.filter(isActionable), ...shown.filter((finding) => !isActionable(finding))];
}

/** Work that is running, so the screen can say what it is waiting for. */
export interface Busy {
  readonly label: string;
  readonly startedAt: number;
  readonly detail?: string;
  /** Whether Esc stops it. An apply stops only after its current item. */
  readonly cancellable: boolean;
}

export interface DisksState {
  readonly view: InventoryView;
  readonly selected: number;
}

export type ExploreMode = "browse" | "largest" | "duplicates" | "stale" | "empty" | "broken" | "search";

export const EXPLORE_MODES: readonly ExploreMode[] = ["browse", "largest", "duplicates", "stale", "empty", "broken"];

export type ExploreRow =
  | { readonly kind: "entry"; readonly entry: IndexedEntry }
  | { readonly kind: "group"; readonly group: DecidedGroup; readonly index: number }
  | {
      readonly kind: "member";
      readonly file: DuplicateFile;
      readonly keep: boolean;
      readonly undecided: boolean;
      readonly groupIndex: number;
    };

/** One level of the directory trail, so going up restores where the cursor was. */
export interface TrailStep {
  readonly path: RawPath;
  readonly id: string;
  readonly selected: number;
}

export interface ScanRun {
  readonly root: RawPath;
  readonly entries: bigint;
  readonly bytes: bigint;
  readonly inaccessible: bigint;
  readonly current?: string;
  readonly startedAt: number;
}

export interface ExploreState {
  /** The path being explored; the root of a stored scan or a directory inside one. */
  readonly root?: RawPath;
  readonly snapshot?: SnapshotSummary;
  readonly mode: ExploreMode;
  readonly directory?: { readonly path: RawPath; readonly id: string; readonly entry: IndexedEntry };
  readonly trail: readonly TrailStep[];
  readonly sort: EntrySort;
  readonly search?: SearchQuery;
  readonly rows: readonly ExploreRow[];
  readonly nextCursor?: string;
  readonly typeTotals?: readonly TypeTotal[];
  readonly selected: number;
  readonly showTypes: boolean;
  readonly staleBasis?: StalenessBasis;
  readonly staleDays: number;
  /** Totals by snapshot over time for this root's comparable scope, oldest first. */
  readonly trend?: { readonly values: readonly bigint[]; readonly since: string; readonly delta: bigint };
  readonly growth: ReadonlyMap<string, bigint>;
  readonly duplicates?: { readonly reclaimable: bigint; readonly complete: boolean; readonly warnings: readonly Warning[] };
  readonly scan?: ScanRun;
  /** Why there is nothing to show, when there is nothing. */
  readonly empty?: string;
  readonly loading: boolean;
}

export interface FindingsState {
  readonly summary?: FootprintSummary;
  readonly loadedAt?: number;
  readonly selected: Readonly<Record<FindingsTab, number>>;
  readonly showProviders: boolean;
  readonly failure?: string;
}

export interface HistoryState {
  readonly records: readonly JournalRecord[];
  readonly nextCursor?: string;
  readonly reconciled: bigint;
  readonly selected: number;
  readonly loaded: boolean;
  readonly failure?: string;
}

/** A modal in front of the current tab. Only one is open at a time. */
export type Dialog =
  | {
      readonly kind: "review";
      readonly plan: ActionPlan;
      /** The operations this target could be planned with instead. */
      readonly alternatives: readonly ActionOperation[];
      readonly typed: string;
      readonly origin: "finding" | "path";
      readonly findingId?: string;
      readonly path?: RawPath;
      /** For a duplicate copy: the copy a hardlink replacement would keep, and this one. */
      readonly pair?: { readonly keep: RawPath; readonly copy: RawPath };
      /** For a move or a compression: what the destination dialog was told. */
      readonly asked?: DestinationAnswer;
    }
  | {
      /**
       * Where a move or a compression publishes, asked before anything is
       * planned. It only plans: the review that follows is what applies.
       */
      readonly kind: "destination";
      readonly operation: "move" | "compress";
      /** The destination as typed; `~/` means the home directory. */
      readonly text: string;
      readonly disposition: SourceDisposition;
      readonly alternatives: readonly ActionOperation[];
      readonly origin: "finding" | "path";
      readonly findingId?: string;
      readonly path?: RawPath;
      /** Why the last Enter was refused, shown in the dialog until the next edit. */
      readonly error?: string;
    }
  | { readonly kind: "applied"; readonly outcome: ApplyOutcome }
  | { readonly kind: "undo-confirm"; readonly record: JournalRecord }
  | { readonly kind: "undone"; readonly outcome: UndoOutcome }
  | { readonly kind: "refused"; readonly title: string; readonly failure: OperationFailure }
  | { readonly kind: "unavailable"; readonly title: string; readonly capability: Capability }
  | { readonly kind: "confirm-scan"; readonly path: RawPath; readonly reason: string }
  | { readonly kind: "finding"; readonly finding: Finding; readonly scroll: number };

export interface DestinationAnswer {
  readonly text: string;
  readonly disposition: SourceDisposition;
}

/** Operations that publish an output, and so ask where before they are planned. */
export function needsDestination(operation: ActionOperation): operation is "move" | "compress" {
  return operation === "move" || operation === "compress";
}

/**
 * The operation `o` offers after `current`: the next one along, round to the
 * first. An irreversible review takes typed input and has no `o`, which is why
 * callers list the irreversible operations last.
 */
export function nextOperation(alternatives: readonly ActionOperation[], current: ActionOperation): ActionOperation | undefined {
  const index = alternatives.indexOf(current);
  const next = alternatives[(index + 1) % alternatives.length];
  return next === current ? undefined : next;
}

export interface Prompt {
  readonly kind: "search";
  readonly text: string;
  /** Why the last Enter was refused, shown on the prompt row until the next edit. */
  readonly error?: string;
}

export interface AppState {
  readonly tab: TabName;
  readonly units: "iec" | "si";
  readonly disks: DisksState;
  readonly explore: ExploreState;
  readonly findings: FindingsState;
  readonly history: HistoryState;
  readonly dialog?: Dialog;
  readonly prompt?: Prompt;
  readonly showHelp: boolean;
  readonly busy?: Busy;
  /** A one-line message for the status row, with how it should read. */
  readonly notice?: { readonly text: string; readonly tone: "info" | "ok" | "warn" | "danger" };
  /** A frame counter for the spinner; advanced only while something is busy. */
  readonly tick: number;
}

export function initialState(view: InventoryView, units: "iec" | "si", staleDays = 183): AppState {
  return {
    tab: "Disks",
    units,
    disks: { view, selected: 0 },
    explore: {
      mode: "browse",
      trail: [],
      sort: "allocated",
      rows: [],
      selected: 0,
      showTypes: true,
      staleDays,
      growth: new Map(),
      loading: false,
    },
    findings: { selected: { Clean: 0, Dev: 0, Apps: 0 }, showProviders: false },
    history: { records: [], reconciled: 0n, selected: 0, loaded: false },
    showHelp: false,
    tick: 0,
  };
}

/** How many rows the list in the current tab holds, for moving the selection. */
export function listLength(state: AppState): number {
  switch (state.tab) {
    case "Disks":
      return state.disks.view.filesystems.length;
    case "Explore":
      return state.explore.rows.length;
    case "Clean":
    case "Dev":
    case "Apps":
      return findingsFor(state.tab, state.findings.summary?.findings ?? []).length;
    case "History":
      return state.history.records.length;
  }
}

export function selectedIndex(state: AppState): number {
  switch (state.tab) {
    case "Disks":
      return state.disks.selected;
    case "Explore":
      return state.explore.selected;
    case "Clean":
    case "Dev":
    case "Apps":
      return state.findings.selected[state.tab];
    case "History":
      return state.history.selected;
  }
}

/** Clamp a selection into a list of `count` rows. */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  if (index === Number.POSITIVE_INFINITY) {
    return count - 1;
  }
  if (index === Number.NEGATIVE_INFINITY || Number.isNaN(index)) {
    return 0;
  }
  return Math.max(0, Math.min(count - 1, Math.trunc(index)));
}

/** Move the selection of the current tab, never past either end. */
export function moveSelection(state: AppState, delta: number): AppState {
  return selectRow(state, selectedIndex(state) + delta);
}

export function selectRow(state: AppState, index: number): AppState {
  const target = clampIndex(index, listLength(state));
  if (target === selectedIndex(state)) {
    return state;
  }
  switch (state.tab) {
    case "Disks":
      return { ...state, disks: { ...state.disks, selected: target } };
    case "Explore":
      return { ...state, explore: { ...state.explore, selected: target } };
    case "Clean":
    case "Dev":
    case "Apps":
      return {
        ...state,
        findings: { ...state.findings, selected: { ...state.findings.selected, [state.tab]: target } },
      };
    case "History":
      return { ...state, history: { ...state.history, selected: target } };
  }
}

export function switchTab(state: AppState, tab: TabName): AppState {
  if (tab === state.tab) {
    return state;
  }
  const rest = omit(state, "notice");
  return { ...rest, tab, showHelp: false };
}

export function cycleTab(state: AppState, delta: number): AppState {
  const index = (TABS.indexOf(state.tab) + delta + TABS.length * 4) % TABS.length;
  return switchTab(state, TABS[index] as TabName);
}

export function selectedFinding(state: AppState): Finding | undefined {
  if (state.tab !== "Clean" && state.tab !== "Dev" && state.tab !== "Apps") {
    return undefined;
  }
  return findingsFor(state.tab, state.findings.summary?.findings ?? [])[state.findings.selected[state.tab]];
}

export function selectedExploreRow(state: AppState): ExploreRow | undefined {
  return state.explore.rows[state.explore.selected];
}

export function selectedRecord(state: AppState): JournalRecord | undefined {
  return state.history.records[state.history.selected];
}

export function withNotice(state: AppState, text: string, tone: "info" | "ok" | "warn" | "danger" = "info"): AppState {
  return { ...state, notice: { text, tone } };
}

export function clearNotice(state: AppState): AppState {
  if (state.notice === undefined) {
    return state;
  }
  const rest = omit(state, "notice");
  return rest;
}

export function withoutDialog(state: AppState): AppState {
  if (state.dialog === undefined) {
    return state;
  }
  const rest = omit(state, "dialog");
  return rest;
}

export function withoutPrompt(state: AppState): AppState {
  if (state.prompt === undefined) {
    return state;
  }
  const rest = omit(state, "prompt");
  return rest;
}

export function withoutBusy(state: AppState): AppState {
  if (state.busy === undefined) {
    return state;
  }
  const rest = omit(state, "busy");
  return rest;
}

export function nextSort(sort: EntrySort): EntrySort {
  const order: readonly EntrySort[] = ["allocated", "apparent", "modified", "name"];
  return order[(order.indexOf(sort) + 1) % order.length] as EntrySort;
}

/**
 * A copy of `value` without `keys`. Optional properties are removed rather
 * than set to `undefined`, which `exactOptionalPropertyTypes` tells apart.
 */
export function omit<T extends object, K extends keyof T>(value: T, ...keys: readonly K[]): Omit<T, K> {
  const copy = { ...value } as Record<PropertyKey, unknown>;
  for (const key of keys) {
    delete copy[key];
  }
  return copy as Omit<T, K>;
}
