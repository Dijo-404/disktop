import { incompatibilities } from "../application/snapshots.js";
import type { ActionOperation, ActionPlan } from "../domain/actions.js";
import { StaleScanIndex } from "../domain/errors.js";
import type { Finding } from "../domain/findings.js";
import type { IndexedEntry, RawPath } from "../domain/models.js";
import { isWithin, pathBytes, rawPathFromBytes } from "../domain/paths.js";
import { staleBeforeNanoseconds } from "../domain/staleness.js";
import type { EntryFilter } from "../ports/scan.js";
import type { SnapshotSummary } from "../ports/snapshots.js";
import type { HitRegion } from "./frame.js";
import { intentForKey, textIntentForKey, type Intent } from "./keys.js";
import { parseSearch, searchFilter } from "./search.js";
import type { TuiServices } from "./services.js";
import {
  EXPLORE_MODES,
  TABS,
  clearNotice,
  cycleTab,
  findingsFor,
  listLength,
  moveSelection,
  nextSort,
  omit,
  selectRow,
  selectedExploreRow,
  selectedFinding,
  selectedIndex,
  selectedRecord,
  switchTab,
  withNotice,
  withoutBusy,
  withoutDialog,
  withoutPrompt,
  type AppState,
  type Busy,
  type Dialog,
  type ExploreRow,
  type TabName,
} from "./state.js";
import { needsTypedConfirmation } from "./views/dialogs.js";
import { defaultOperation } from "./views/findings.js";
import { canUndo } from "./views/history.js";
import type { MouseEvent } from "./render.js";

/** How many rows one request for a list asks the index for. */
export const PAGE_ROWS = 200;

/** The most list rows the TUI holds at once; past this it asks for a filter. */
export const MAX_ROWS = 10_000;
const MAX_RECORDS = 2_000;

/** Operations the TUI can plan without asking for a destination or a pair. */
const PLANNABLE: readonly ActionOperation[] = ["trash", "permanent", "empty-trash", "manager"];

export interface ControllerHooks {
  /** Something changed; draw when convenient. */
  readonly changed: () => void;
  /** Rows a page key moves. */
  readonly pageRows: () => number;
  /** Hand the terminal to a password prompt, and take it back. */
  readonly suspend: (message: string) => void;
  readonly resume: () => void;
  /** The user asked to leave, with this exit status. */
  readonly exit: (code: number) => void;
  /**
   * How long after a confirmation dialog appears its confirming key is
   * ignored, so a key typed ahead is never taken as having read it. 400 ms
   * when absent.
   */
  readonly confirmDelayMilliseconds?: number;
}

type TaskKind = "inventory" | "explore" | "trend" | "scan" | "findings" | "history" | "plan" | "apply" | "undo" | "duplicates";

/** Tasks that change something on disk. They are never abandoned, only asked to stop. */
const MUTATING: ReadonlySet<TaskKind> = new Set<TaskKind>(["apply", "undo"]);

interface Running {
  readonly controller: AbortController;
  readonly generation: number;
  readonly promise: Promise<void>;
}

const EXIT_COMPLETE = 0;
const EXIT_INCOMPLETE = 3;
const EXIT_INTERRUPTED = 130;

/**
 * The TUI's behaviour: what each key does where it lands, and the work it
 * starts.
 *
 * Every piece of work is a task with its own `AbortController`. Starting a task
 * of a kind already running aborts the earlier one, and each task checks that
 * it is still the current one before it writes its result, so a slow answer to
 * an old question can never overwrite the answer to a new one. Tasks that
 * change the disk are never abandoned: Esc or Ctrl+C asks them to stop after
 * the current item, and leaving waits for them to report.
 */
export class TuiController {
  #state: AppState;
  readonly #services: TuiServices;
  readonly #hooks: ControllerHooks;
  readonly #running = new Map<TaskKind, Running>();
  readonly #busy = new Map<TaskKind, Busy>();
  #generation = 0;
  #leaving = false;
  #interrupted = false;
  #hits: readonly HitRegion[] = [];
  /** When the dialog on screen first appeared, by `performance.now()`. */
  #dialogShownAt = 0;

  constructor(services: TuiServices, initial: AppState, hooks: ControllerHooks) {
    this.#services = services;
    this.#state = initial;
    this.#hooks = hooks;
  }

  get state(): AppState {
    return this.#state;
  }

  /** Whether anything is running, so the spinner knows to keep turning. */
  get active(): boolean {
    return this.#running.size > 0;
  }

  /** Whether an action that changes the disk is running. */
  get acting(): boolean {
    return [...this.#running.keys()].some((kind) => MUTATING.has(kind));
  }

  /** Ask every running action to stop after its current item. */
  cancelActions(): void {
    for (const [kind, running] of this.#running) {
      if (MUTATING.has(kind)) {
        running.controller.abort();
      }
    }
  }

  /** The exit status a normal quit reports: incomplete when the inventory was. */
  get exitCode(): number {
    if (this.#interrupted) {
      return EXIT_INTERRUPTED;
    }
    return this.#state.disks.view.complete ? EXIT_COMPLETE : EXIT_INCOMPLETE;
  }

  /** The clickable regions of the frame on screen now. */
  setHits(hits: readonly HitRegion[]): void {
    this.#hits = hits;
  }

  tick(): void {
    this.#set({ ...this.#state, tick: this.#state.tick + 1 });
  }

  /** Wait until no task is running. Tests use this; so does leaving. */
  async idle(): Promise<void> {
    while (this.#running.size > 0) {
      await Promise.allSettled([...this.#running.values()].map((running) => running.promise));
    }
  }

  /**
   * Stop everything and wait for it to finish stopping.
   *
   * A scan asked to stop still writes what it read, and an apply asked to stop
   * finishes and journals its current item, so both are awaited. Reads are
   * given a moment and then left behind: nothing depends on their answer.
   */
  async shutdown(graceMilliseconds = 5_000): Promise<void> {
    this.#leaving = true;
    for (const running of this.#running.values()) {
      running.controller.abort();
    }
    const mutating = [...this.#running.entries()].filter(([kind]) => MUTATING.has(kind)).map(([, running]) => running.promise);
    const others = [...this.#running.entries()].filter(([kind]) => !MUTATING.has(kind)).map(([, running]) => running.promise);
    await Promise.allSettled(mutating);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(others),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMilliseconds);
        timer.unref();
      }),
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------- input

  handleKey(key: string): void {
    if (this.#leaving) {
      return;
    }
    const state = this.#state;
    const typing = state.prompt !== undefined || (state.dialog?.kind === "review" && needsTypedConfirmation(state.dialog.plan) && !state.showHelp);
    const intent = typing ? textIntentForKey(key) : intentForKey(key);
    this.#dispatch(intent);
  }

  handleMouse(event: MouseEvent): void {
    if (this.#leaving) {
      return;
    }
    if (event.kind === "wheel-up" || event.kind === "wheel-down") {
      const delta = event.kind === "wheel-up" ? -3 : 3;
      const dialog = this.#state.dialog;
      if (dialog?.kind === "finding") {
        this.#set({ ...this.#state, dialog: { ...dialog, scroll: Math.max(0, dialog.scroll + delta) } });
        return;
      }
      if (dialog === undefined && !this.#state.showHelp) {
        this.#set(moveSelection(this.#state, delta));
        this.#maybeLoadMore();
      }
      return;
    }
    // A click never reaches behind an open dialog, a prompt, or help: what is
    // in front has to be answered or closed with the keyboard first.
    if (this.#state.dialog !== undefined || this.#state.showHelp || this.#state.prompt !== undefined) {
      return;
    }
    const hit = this.#hits.find((region) => region.row === event.row && event.column >= region.from && event.column < region.to);
    if (hit === undefined) {
      return;
    }
    if (hit.action.kind === "tab") {
      this.#gotoTab(TABS[hit.action.index] as TabName);
      return;
    }
    if (hit.action.index === selectedIndex(this.#state)) {
      this.#dispatch({ kind: "open" });
    } else {
      this.#set(selectRow(this.#state, hit.action.index));
    }
  }

  /** Start whatever the first screen needs. */
  start(): void {
    this.#refreshInventory(false);
  }

  #dispatch(intent: Intent): void {
    const state = this.#state;

    if (intent.kind === "interrupt") {
      this.#interrupt();
      return;
    }
    if (state.prompt !== undefined) {
      this.#promptIntent(intent);
      return;
    }
    if (state.showHelp) {
      if (intent.kind === "help" || intent.kind === "cancel") {
        this.#set({ ...state, showHelp: false });
      } else if (intent.kind === "quit") {
        this.#quit();
      }
      return;
    }
    if (state.dialog !== undefined) {
      this.#dialogIntent(state.dialog, intent);
      return;
    }

    switch (intent.kind) {
      case "move":
        this.#set(clearNotice(moveSelection(state, intent.delta)));
        this.#maybeLoadMore();
        return;
      case "page": {
        const rows = Math.max(1, intent.half === true ? Math.floor(this.#hooks.pageRows() / 2) : this.#hooks.pageRows());
        this.#set(moveSelection(state, rows * intent.direction));
        this.#maybeLoadMore();
        return;
      }
      case "tab":
        this.#gotoTab(cycleTab(state, intent.delta).tab);
        return;
      case "goto-tab":
        this.#gotoTab(TABS[intent.index] as TabName);
        return;
      case "left":
        if (state.tab === "Explore") {
          this.#exploreUp();
        } else {
          this.#gotoTab(cycleTab(state, -1).tab);
        }
        return;
      case "right":
        if (state.tab === "Explore") {
          this.#open();
        } else {
          this.#gotoTab(cycleTab(state, 1).tab);
        }
        return;
      case "open":
        this.#open();
        return;
      case "up":
        if (state.tab === "Explore") {
          this.#exploreUp();
        }
        return;
      case "help":
        this.#set({ ...state, showHelp: true });
        return;
      case "units":
        this.#set(withNotice({ ...state, units: state.units === "iec" ? "si" : "iec" }, state.units === "iec" ? "Units: SI (kB, MB, GB)" : "Units: IEC (KiB, MiB, GiB)"));
        return;
      case "quit":
        this.#quit();
        return;
      case "cancel":
        this.#cancel();
        return;
      case "refresh":
        this.#refresh();
        return;
      case "scan":
        this.#askToScan();
        return;
      case "sort":
        if (state.tab === "Explore" && state.explore.snapshot !== undefined && state.explore.mode !== "duplicates") {
          const sort = nextSort(state.explore.sort);
          this.#set(withNotice({ ...state, explore: { ...state.explore, sort } }, `Sorted by ${sort === "allocated" ? "size on disk" : sort === "apparent" ? "apparent size" : sort === "modified" ? "last modified" : "name"}`));
          this.#reloadExplore(true);
        }
        return;
      case "mode":
        if (state.tab === "Explore" && state.explore.snapshot !== undefined) {
          const current = EXPLORE_MODES.indexOf(state.explore.mode);
          const mode = EXPLORE_MODES[(current + 1) % EXPLORE_MODES.length] ?? "browse";
          // A cursor belongs to the query that issued it; a new mode starts over.
          this.#set({ ...state, explore: { ...omit(state.explore, "nextCursor", "duplicates"), mode, rows: [], selected: 0 } });
          this.#reloadExplore(true);
        }
        return;
      case "search":
        if (state.tab === "Explore" && state.explore.snapshot !== undefined) {
          this.#set({ ...state, prompt: { kind: "search", text: state.explore.search?.text ?? "" } });
        }
        return;
      case "types":
        if (state.tab === "Explore") {
          const showTypes = !state.explore.showTypes;
          this.#set({ ...state, explore: { ...state.explore, showTypes } });
          if (showTypes && state.explore.typeTotals === undefined) {
            this.#reloadExplore(false);
          }
        }
        return;
      case "clean":
        this.#planSelected();
        return;
      case "undo":
        if (state.tab === "History") {
          const record = selectedRecord(state);
          if (record === undefined) {
            return;
          }
          if (!canUndo(record)) {
            this.#set(
              withNotice(
                state,
                record.state === "uncertain"
                  ? "That action was interrupted and could not be judged; it cannot be undone until it is."
                  : "Only a Trash action leaves something to put back.",
                "warn",
              ),
            );
            return;
          }
          this.#set({ ...state, dialog: { kind: "undo-confirm", record } });
        }
        return;
      case "providers":
        if (state.tab === "Clean" || state.tab === "Dev" || state.tab === "Apps") {
          this.#set({ ...state, findings: { ...state.findings, showProviders: !state.findings.showProviders } });
        }
        return;
      case "deny":
        if (state.tab === "Explore" || state.tab === "History") {
          this.#loadMore();
        }
        return;
      case "confirm":
      case "operation":
      case "type":
      case "backspace":
      case "submit":
      case "clear-input":
      case "none":
        return;
    }
  }

  #promptIntent(intent: Intent): void {
    const prompt = this.#state.prompt;
    if (prompt === undefined) {
      return;
    }
    switch (intent.kind) {
      case "type":
        if (prompt.text.length < 200) {
          this.#set({ ...this.#state, prompt: { kind: prompt.kind, text: prompt.text + intent.text } });
        }
        return;
      case "backspace":
        this.#set({ ...this.#state, prompt: { kind: prompt.kind, text: Array.from(prompt.text).slice(0, -1).join("") } });
        return;
      case "clear-input":
        this.#set({ ...this.#state, prompt: { kind: prompt.kind, text: "" } });
        return;
      case "cancel":
        this.#set(withoutPrompt(this.#state));
        return;
      case "submit": {
        const text = prompt.text.trim();
        const closed = withoutPrompt(this.#state);
        if (text === "") {
          const explore = omit(closed.explore, "search");
          this.#set({ ...closed, explore: { ...explore, mode: "browse", rows: [], selected: 0 } });
          this.#reloadExplore(true);
          return;
        }
        const parsed = parseSearch(text);
        if (!parsed.ok) {
          // Said on the prompt row, which is on screen while the prompt is
          // open, and the prompt stays open to be corrected.
          this.#set({ ...this.#state, prompt: { ...prompt, error: parsed.message } });
          return;
        }
        this.#set({ ...closed, explore: { ...omit(closed.explore, "nextCursor", "duplicates"), mode: "search", search: parsed.query, rows: [], selected: 0 } });
        this.#reloadExplore(true);
        return;
      }
      default:
        return;
    }
  }

  #dialogIntent(dialog: Dialog, intent: Intent): void {
    const state = this.#state;
    if (intent.kind === "cancel" || (intent.kind === "deny" && dialog.kind !== "review")) {
      this.#abortPlanning();
      this.#set(withoutDialog(state));
      return;
    }
    const confirming =
      ((dialog.kind === "review" || dialog.kind === "undo-confirm" || dialog.kind === "confirm-scan") && intent.kind === "confirm") ||
      (dialog.kind === "review" && intent.kind === "submit") ||
      (dialog.kind === "confirm-scan" && intent.kind === "open");
    if (confirming && !this.#dialogSettled()) {
      return;
    }
    if (intent.kind === "quit" && dialog.kind !== "review") {
      this.#quit();
      return;
    }
    switch (dialog.kind) {
      case "review": {
        const typed = needsTypedConfirmation(dialog.plan);
        if (typed) {
          if (intent.kind === "type" && dialog.typed.length < 16) {
            this.#set({ ...state, dialog: { ...dialog, typed: dialog.typed + intent.text } });
          } else if (intent.kind === "backspace") {
            this.#set({ ...state, dialog: { ...dialog, typed: dialog.typed.slice(0, -1) } });
          } else if (intent.kind === "clear-input") {
            this.#set({ ...state, dialog: { ...dialog, typed: "" } });
          } else if (intent.kind === "submit") {
            if (dialog.typed.trim().toLowerCase() === "yes") {
              this.#apply(dialog.plan, dialog.origin);
            } else {
              this.#set(withNotice(state, "Type yes to apply this irreversible plan, or press Esc.", "warn"));
            }
          }
          return;
        }
        if (intent.kind === "confirm") {
          this.#apply(dialog.plan, dialog.origin);
        } else if (intent.kind === "operation") {
          const others = dialog.alternatives.filter((operation) => operation !== dialog.plan.operation);
          const next = others[0];
          if (next !== undefined) {
            this.#replan(dialog, next);
          }
        } else if (intent.kind === "deny") {
          this.#abortPlanning();
          this.#set(withoutDialog(state));
        }
        return;
      }
      case "undo-confirm":
        if (intent.kind === "confirm") {
          this.#undo(dialog.record.id);
        }
        return;
      case "confirm-scan":
        if (intent.kind === "confirm" || intent.kind === "open") {
          this.#scan(dialog.path);
        }
        return;
      case "finding":
        if (intent.kind === "move") {
          const delta = Number.isFinite(intent.delta) ? intent.delta : intent.delta > 0 ? 10_000 : -10_000;
          this.#set({ ...state, dialog: { ...dialog, scroll: Math.max(0, dialog.scroll + delta) } });
        } else if (intent.kind === "page") {
          this.#set({ ...state, dialog: { ...dialog, scroll: Math.max(0, dialog.scroll + intent.direction * this.#hooks.pageRows()) } });
        } else if (intent.kind === "clean") {
          this.#set(withoutDialog(state));
          this.#planFinding(dialog.finding);
        } else if (intent.kind === "open") {
          this.#set(withoutDialog(state));
        }
        return;
      case "applied":
      case "undone":
      case "refused":
      case "unavailable":
        if (intent.kind === "open" || intent.kind === "confirm") {
          this.#set(withoutDialog(state));
        }
        return;
    }
  }

  // ---------------------------------------------------------------- navigation

  #gotoTab(tab: TabName): void {
    const state = switchTab(withoutPrompt(this.#state), tab);
    this.#set(state);
    if ((tab === "Clean" || tab === "Dev" || tab === "Apps") && state.findings.summary === undefined && !this.#running.has("findings") && state.findings.failure === undefined) {
      this.#discover();
    }
    if (tab === "History" && !state.history.loaded && !this.#running.has("history")) {
      this.#loadHistory(false);
    }
    if (tab === "Explore" && state.explore.snapshot === undefined && !this.#running.has("explore") && state.explore.scan === undefined) {
      this.#openExplore(state.explore.root);
    }
  }

  #open(): void {
    const state = this.#state;
    switch (state.tab) {
      case "Disks": {
        const filesystem = state.disks.view.filesystems[state.disks.selected];
        const mount = filesystem?.mounts[0];
        if (mount !== undefined) {
          this.#set(switchTab(state, "Explore"));
          this.#openExplore(mount, true);
        }
        return;
      }
      case "Explore": {
        const row = selectedExploreRow(state);
        // A directory still loading is not opened again: a second Enter would
        // record the same parent twice on the trail.
        if (state.explore.loading) {
          return;
        }
        if (row?.kind === "entry" && row.entry.kind === "directory") {
          const explore = state.explore;
          // Loading is set here, synchronously, so a second Enter before the
          // child arrives is ignored rather than pushing the parent again.
          if (explore.mode !== "browse") {
            this.#set({ ...state, explore: { ...omit(explore, "nextCursor", "duplicates"), mode: "browse", trail: [], rows: [], selected: 0, loading: true } });
          } else if (explore.directory !== undefined) {
            this.#set({
              ...state,
              explore: {
                ...explore,
                loading: true,
                trail: [...explore.trail, { path: explore.directory.path, id: explore.directory.id, selected: explore.selected }],
              },
            });
          }
          this.#loadDirectory(row.entry.path, 0);
        }
        return;
      }
      case "Clean":
      case "Dev":
      case "Apps": {
        // The detectors list hides the findings; Enter acts on nothing hidden.
        const finding = state.findings.showProviders ? undefined : selectedFinding(state);
        if (finding !== undefined) {
          this.#set({ ...state, dialog: { kind: "finding", finding, scroll: 0 } });
        }
        return;
      }
      case "History":
        return;
    }
  }

  #exploreUp(): void {
    const state = this.#state;
    const explore = state.explore;
    if (explore.mode !== "browse") {
      this.#set({ ...state, explore: { ...omit(explore, "nextCursor", "duplicates"), mode: "browse", rows: [], selected: 0 } });
      this.#reloadExplore(true);
      return;
    }
    const step = explore.trail[explore.trail.length - 1];
    if (step !== undefined) {
      this.#set({ ...state, explore: { ...explore, trail: explore.trail.slice(0, -1) } });
      this.#loadDirectory(step.path, step.selected);
      return;
    }
    const current = explore.directory?.path;
    const scanRoot = explore.snapshot?.scope.roots.find((root) => current !== undefined && isWithin(pathBytes(root), pathBytes(current)));
    if (current === undefined || scanRoot === undefined || scanRoot.bytesBase64 === current.bytesBase64) {
      this.#set(withNotice(state, "This is the top of the scan. Scan a parent directory to go higher.", "info"));
      return;
    }
    const parent = parentPath(current);
    if (parent !== undefined) {
      this.#loadDirectory(parent, 0, current);
    }
  }

  #quit(): void {
    if (this.#running.has("apply") || this.#running.has("undo")) {
      this.#set(withNotice(this.#state, "An action is running. Press Esc to stop it after the current item, then quit.", "warn"));
      return;
    }
    this.#hooks.exit(this.exitCode);
  }

  /** Ctrl+C: stop everything, let a running action finish its item, then leave with 130. */
  #interrupt(): void {
    this.#interrupted = true;
    for (const running of this.#running.values()) {
      running.controller.abort();
    }
    this.#hooks.exit(EXIT_INTERRUPTED);
  }

  #cancel(): void {
    const state = this.#state;
    const cancellable = [...this.#running.entries()].reverse().find(([kind]) => kind === "scan" || kind === "findings" || kind === "duplicates" || kind === "plan" || MUTATING.has(kind));
    if (cancellable !== undefined) {
      const [kind, running] = cancellable;
      running.controller.abort();
      this.#set(
        withNotice(
          state,
          MUTATING.has(kind)
            ? "Stopping after the current item; what was done is journalled."
            : kind === "scan"
              ? "Stopping the scan; what it read is kept and marked incomplete."
              : "Stopped.",
          "warn",
        ),
      );
      return;
    }
    if (state.tab === "Explore" && state.explore.mode !== "browse") {
      this.#exploreUp();
      return;
    }
    if (state.tab !== "Disks" && (state.tab === "Clean" || state.tab === "Dev" || state.tab === "Apps") && state.findings.showProviders) {
      this.#set({ ...state, findings: { ...state.findings, showProviders: false } });
      return;
    }
    this.#set(clearNotice(state));
  }

  #refresh(): void {
    switch (this.#state.tab) {
      case "Disks":
        this.#refreshInventory(true);
        return;
      case "Explore":
        if (this.#state.explore.snapshot !== undefined) {
          this.#openExplore(this.#state.explore.directory?.path ?? this.#state.explore.root);
        }
        return;
      case "Clean":
      case "Dev":
      case "Apps":
        this.#discover();
        return;
      case "History":
        this.#loadHistory(false);
        return;
    }
  }

  #maybeLoadMore(): void {
    const state = this.#state;
    if (state.tab === "Explore" && state.explore.nextCursor !== undefined && state.explore.selected >= state.explore.rows.length - 5) {
      this.#loadMore();
    }
    if (state.tab === "History" && state.history.nextCursor !== undefined && state.history.selected >= state.history.records.length - 3) {
      this.#loadMore();
    }
  }

  /**
   * Fetch the next page, up to a bound. A directory can hold millions of
   * entries; the TUI keeps at most `MAX_ROWS` of them in memory and says so,
   * rather than growing with every page somebody scrolls past.
   */
  #loadMore(): void {
    const state = this.#state;
    if (state.tab === "Explore" && state.explore.mode !== "duplicates" && state.explore.nextCursor !== undefined && !this.#running.has("explore")) {
      if (state.explore.rows.length >= MAX_ROWS) {
        this.#set(withNotice(state, `Showing the first ${MAX_ROWS.toLocaleString("en")} rows. Press / to narrow the list.`, "info"));
        return;
      }
      this.#reloadExplore(false, state.explore.nextCursor);
    }
    if (state.tab === "History" && state.history.nextCursor !== undefined && !this.#running.has("history")) {
      if (state.history.records.length >= MAX_RECORDS) {
        this.#set(withNotice(state, `Showing the newest ${MAX_RECORDS.toLocaleString("en")} actions; 'disktop history --json' pages through them all.`, "info"));
        return;
      }
      this.#loadHistory(true);
    }
  }

  // ---------------------------------------------------------------- tasks

  #set(next: AppState): void {
    if (next === this.#state) {
      return;
    }
    let state = next;
    if (state.dialog !== undefined) {
      if (dialogIdentity(state.dialog) !== (this.#state.dialog === undefined ? undefined : dialogIdentity(this.#state.dialog))) {
        this.#dialogShownAt = performance.now();
      }
      // A dialog takes the keyboard: a prompt left open behind it would
      // receive keys meant for the dialog while not being on screen.
      if (state.prompt !== undefined) {
        state = withoutPrompt(state);
      }
    }
    this.#state = state;
    this.#hooks.changed();
  }

  /** Whether a confirming key now could have followed reading the dialog. */
  #dialogSettled(): boolean {
    return performance.now() - this.#dialogShownAt >= (this.#hooks.confirmDelayMilliseconds ?? 400);
  }

  /** Stop a plan that is still being reviewed; its answer is no longer wanted. */
  #abortPlanning(): void {
    this.#running.get("plan")?.controller.abort();
  }

  /** Update state only if this task is still the current one of its kind. */
  #ifCurrent(kind: TaskKind, generation: number, update: (state: AppState) => AppState): void {
    if (this.#running.get(kind)?.generation === generation) {
      this.#set(update(this.#state));
    }
  }

  /**
   * Run `work` as the current task of its kind.
   *
   * A failure is shown on the status row, and `recover` puts the state the
   * task was changing back into something that does not claim it is still
   * loading. Nothing fails silently and nothing spins forever.
   */
  #run(
    kind: TaskKind,
    busy: Omit<Busy, "startedAt"> | undefined,
    work: (signal: AbortSignal, generation: number) => Promise<void>,
    recover?: (state: AppState, message: string) => AppState,
  ): void {
    const previous = this.#running.get(kind);
    if (MUTATING.has(kind) && this.acting) {
      // One change to the disk at a time: an apply and an undo never overlap,
      // and the second is refused rather than queued behind the first.
      this.#set(withNotice(this.#state, "An action is already running; wait for it to finish.", "warn"));
      return;
    }
    previous?.controller.abort();
    const controller = new AbortController();
    this.#generation += 1;
    const generation = this.#generation;
    if (busy !== undefined) {
      this.#busy.set(kind, { ...busy, startedAt: this.#services.now().getTime() });
      this.#syncBusy();
    }
    // The task is registered before its first line runs, so a result it
    // produces synchronously is already recognised as current.
    let begin: () => void = () => undefined;
    const registered = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const promise = (async () => {
      await registered;
      try {
        await work(controller.signal, generation);
      } catch (error) {
        if (this.#running.get(kind)?.generation === generation && !this.#leaving) {
          const message = error instanceof Error ? error.message : "The operation failed for an unknown reason.";
          const recovered = recover === undefined ? this.#state : recover(this.#state, message);
          this.#set(withNotice(recovered, message, "danger"));
        }
      } finally {
        if (this.#running.get(kind)?.generation === generation) {
          this.#running.delete(kind);
          this.#busy.delete(kind);
          this.#syncBusy();
        }
      }
    })();
    this.#running.set(kind, { controller, generation, promise });
    begin();
  }

  #syncBusy(): void {
    const latest = [...this.#busy.values()].pop();
    this.#set(latest === undefined ? withoutBusy(this.#state) : { ...this.#state, busy: latest });
  }

  #refreshInventory(announce: boolean): void {
    this.#run("inventory", undefined, async (_signal, generation) => {
      const view = await this.#services.dashboard.inventory();
      this.#ifCurrent("inventory", generation, (state) => {
        const updated = { ...state, disks: { view, selected: Math.min(state.disks.selected, Math.max(0, view.filesystems.length - 1)) } };
        return announce ? withNotice(updated, view.complete ? "Filesystems read again." : "Filesystems read again; some readings could not be taken.", view.complete ? "ok" : "warn") : updated;
      });
    });
  }

  /**
   * Show what a stored scan says about `path`, or offer to scan it.
   *
   * The newest snapshot whose roots cover the path answers; with no path, the
   * newest scan of anything does. Explore never scans on its own.
   */
  #openExplore(path: RawPath | undefined, offerScan = false): void {
    this.#run("explore", undefined, async (_signal, generation) => {
      const snapshots = await this.#services.snapshots.list();
      const wanted = path;
      const snapshot =
        wanted === undefined
          ? snapshots[0]
          : snapshots.find((candidate) => candidate.scope.roots.some((root) => isWithin(pathBytes(root), pathBytes(wanted))));
      const root = wanted ?? snapshot?.scope.roots[0] ?? this.#services.home;
      if (snapshot === undefined) {
        this.#ifCurrent("explore", generation, (state) => {
          const rest = omit(state.explore, "snapshot", "directory", "scan", "empty");
          const next = { ...state, explore: { ...rest, root, rows: [], selected: 0, trail: [], loading: false, growth: new Map<string, bigint>() } };
          return offerScan ? { ...next, dialog: { kind: "confirm-scan", path: root, reason: "Nothing has been scanned here yet." } } : next;
        });
        return;
      }
      this.#ifCurrent("explore", generation, (state) => {
        const rest = omit(state.explore, "trend", "typeTotals");
        return {
          ...state,
          explore: { ...rest, root, snapshot, mode: "browse", trail: [], rows: [], selected: 0, loading: true, growth: new Map<string, bigint>() },
        };
      });
      await this.#loadDirectoryNow(root, 0, undefined, snapshot, generation);
      this.#loadTrend(snapshot, snapshots);
    }, exploreFailed);
  }

  #loadDirectory(path: RawPath, selected: number, select?: RawPath): void {
    const snapshot = this.#state.explore.snapshot;
    if (snapshot === undefined) {
      return;
    }
    this.#run("explore", undefined, async (_signal, generation) => {
      this.#ifCurrent("explore", generation, (state) => ({ ...state, explore: { ...state.explore, loading: true } }));
      await this.#loadDirectoryNow(path, selected, select, snapshot, generation);
    }, exploreFailed);
  }

  async #loadDirectoryNow(path: RawPath, selected: number, select: RawPath | undefined, snapshot: SnapshotSummary, generation: number): Promise<void> {
    const explore = this.#services.explore;
    try {
      const found = await explore.page({ scanId: snapshot.scanId, filter: { atPath: path }, limit: 1 });
      if (found.kind === "unavailable") {
        this.#ifCurrent("explore", generation, (state) => ({ ...state, explore: { ...state.explore, loading: false, rows: [], empty: found.capability.explanation } }));
        return;
      }
      // The index is asked for exactly this path; anything else in the answer
      // (an older helper that ignores the filter) is not this directory.
      const entry = found.page.entries.find((candidate) => candidate.path.bytesBase64 === path.bytesBase64);
      if (entry === undefined) {
        this.#ifCurrent("explore", generation, (state) => ({
          ...state,
          explore: { ...state.explore, loading: false, rows: [], empty: `${path.display} is not in this scan. Press S to scan it.` },
        }));
        return;
      }
      const showTypes = this.#state.explore.showTypes;
      const [children, types] = await Promise.all([
        explore.page({ scanId: snapshot.scanId, filter: { parentId: entry.id }, sort: this.#state.explore.sort, order: orderFor(this.#state.explore.sort), limit: PAGE_ROWS }),
        showTypes ? explore.page({ scanId: snapshot.scanId, filter: { underPath: path }, limit: 1, includeTypeTotals: true }) : Promise.resolve(undefined),
      ]);
      if (children.kind === "unavailable") {
        this.#ifCurrent("explore", generation, (state) => ({ ...state, explore: { ...state.explore, loading: false, rows: [], empty: children.capability.explanation } }));
        return;
      }
      this.#ifCurrent("explore", generation, (state) => {
        const rows: ExploreRow[] = children.page.entries.map((child) => entryRow(child));
        const target = select === undefined ? selected : Math.max(0, rows.findIndex((row) => row.kind === "entry" && row.entry.path.bytesBase64 === select.bytesBase64));
        const rest = omit(state.explore, "empty", "nextCursor", "typeTotals");
        const typeTotals = types?.kind === "page" ? types.page.typeTotals : undefined;
        return {
          ...state,
          explore: {
            ...rest,
            mode: "browse",
            directory: { path, id: entry.id, entry },
            rows,
            selected: Math.min(target, Math.max(0, rows.length - 1)),
            loading: false,
            ...(children.page.nextCursor === undefined ? {} : { nextCursor: children.page.nextCursor }),
            ...(typeTotals === undefined ? {} : { typeTotals }),
          },
        };
      });
    } catch (error) {
      if (error instanceof StaleScanIndex) {
        this.#ifCurrent("explore", generation, (state) => ({
          ...state,
          explore: {
            ...state.explore,
            loading: false,
            rows: [],
            empty: "This scan has been pruned from the index, which keeps only the newest scans. Press S to scan again.",
          },
        }));
        return;
      }
      throw error;
    }
  }

  /** Reload the current mode's list, from the start or from a cursor. */
  #reloadExplore(reset: boolean, cursor?: string): void {
    const state = this.#state;
    const explore = state.explore;
    const snapshot = explore.snapshot;
    if (snapshot === undefined) {
      return;
    }
    const place = explore.directory?.path ?? explore.root;
    if (place === undefined) {
      return;
    }
    if (explore.mode === "browse" && cursor === undefined) {
      this.#loadDirectory(place, reset ? 0 : explore.selected);
      return;
    }
    if (explore.mode === "duplicates") {
      this.#findDuplicates(place, snapshot);
      return;
    }
    this.#run("explore", undefined, async (signal, generation) => {
      this.#ifCurrent("explore", generation, (current) => ({ ...current, explore: { ...current.explore, loading: true } }));
      const mode = explore.mode;
      const now = this.#services.now();
      let entries: readonly IndexedEntry[] = [];
      let nextCursor: string | undefined;
      try {
        if (mode === "stale" || mode === "empty" || mode === "broken") {
          const outcome = await this.#services.find.find(
            {
              kind: mode,
              scanId: snapshot.scanId,
              path: place,
              limit: PAGE_ROWS,
              ...(cursor === undefined ? {} : { cursor }),
              ...(mode === "stale" ? { staleBeforeNanoseconds: staleBeforeNanoseconds(now, explore.staleDays) } : {}),
            },
            signal,
          );
          if (outcome.kind === "refused" || outcome.kind === "unavailable") {
            const message = outcome.kind === "refused" ? outcome.failure.message : outcome.capability.explanation;
            this.#ifCurrent("explore", generation, (current) => ({ ...current, explore: { ...current.explore, loading: false, rows: [], empty: message } }));
            return;
          }
          if (outcome.kind === "found" || outcome.kind === "stale") {
            entries = outcome.entries;
            nextCursor = outcome.nextCursor;
          }
          if (outcome.kind === "stale") {
            const basis = outcome.basis;
            this.#ifCurrent("explore", generation, (current) => ({ ...current, explore: { ...current.explore, staleBasis: basis } }));
          }
        } else {
          // Browsing pages through one directory's children; the other modes
          // rank everything below the current place.
          const filter: EntryFilter =
            mode === "browse"
              ? { parentId: explore.directory?.id ?? "" }
              : mode === "largest"
                ? { underPath: place, kinds: ["file"] }
                : { underPath: place, ...(explore.search === undefined ? {} : searchFilter(explore.search, now)) };
          const sort = mode === "largest" ? "allocated" : explore.sort;
          const outcome = await this.#services.explore.page({
            scanId: snapshot.scanId,
            filter,
            sort,
            order: orderFor(sort),
            limit: PAGE_ROWS,
            ...(cursor === undefined ? {} : { cursor }),
          });
          if (outcome.kind === "unavailable") {
            this.#ifCurrent("explore", generation, (current) => ({ ...current, explore: { ...current.explore, loading: false, rows: [], empty: outcome.capability.explanation } }));
            return;
          }
          entries = outcome.page.entries;
          nextCursor = outcome.page.nextCursor;
        }
      } catch (error) {
        if (error instanceof StaleScanIndex) {
          this.#ifCurrent("explore", generation, (current) => ({
            ...current,
            explore: { ...current.explore, loading: false, rows: [], empty: "This scan has been pruned from the index. Press S to scan again." },
          }));
          return;
        }
        throw error;
      }
      this.#ifCurrent("explore", generation, (current) => {
        const appended = cursor === undefined ? [] : current.explore.rows;
        const rows = [...appended, ...entries.map((entry) => entryRow(entry))];
        const rest = omit(current.explore, "nextCursor", "empty");
        return {
          ...current,
          explore: {
            ...rest,
            rows,
            selected: cursor === undefined ? 0 : current.explore.selected,
            loading: false,
            ...(nextCursor === undefined ? {} : { nextCursor }),
          },
        };
      });
    }, exploreFailed);
  }

  #findDuplicates(place: RawPath, snapshot: SnapshotSummary): void {
    this.#run("duplicates", { label: "Comparing file contents", detail: "sizes, then edges, then whole files", cancellable: true }, async (signal, generation) => {
      this.#set({ ...this.#state, explore: { ...this.#state.explore, loading: true, rows: [] } });
      const outcome = await this.#services.find.find({ kind: "duplicates", scanId: snapshot.scanId, path: place, rule: "oldest", limit: PAGE_ROWS }, signal);
      this.#ifCurrent("duplicates", generation, (state) => {
        if (state.explore.mode !== "duplicates") {
          return state;
        }
        if (outcome.kind !== "duplicates") {
          const message = outcome.kind === "refused" ? outcome.failure.message : outcome.kind === "unavailable" ? outcome.capability.explanation : "Unexpected answer.";
          return { ...state, explore: { ...state.explore, loading: false, rows: [], empty: message } };
        }
        const result = outcome.result;
        if (result.kind !== "found") {
          const message = result.kind === "refused" ? result.failure.message : result.capability.explanation;
          return { ...state, explore: { ...state.explore, loading: false, rows: [], empty: message } };
        }
        const rows: ExploreRow[] = [];
        for (const [index, group] of result.groups.entries()) {
          rows.push({ kind: "group", group, index });
          for (const file of group.group.files) {
            const keep = group.decision.kind === "decided" && group.decision.kept.path.bytesBase64 === file.path.bytesBase64;
            rows.push({ kind: "member", file, keep, undecided: group.decision.kind !== "decided", groupIndex: index });
          }
        }
        const rest = omit(state.explore, "nextCursor", "empty");
        const next = {
          ...state,
          explore: {
            ...rest,
            rows,
            selected: 0,
            loading: false,
            duplicates: { reclaimable: result.reclaimableBytes, complete: result.complete, warnings: result.warnings },
          },
        };
        return result.complete ? next : withNotice(next, result.warnings[0]?.message ?? "The duplicate search was incomplete.", "warn");
      });
    }, exploreFailed);
  }

  /**
   * The growth trend for this scan's scope: totals of every comparable
   * snapshot, oldest first, and per-directory changes since the previous one.
   */
  #loadTrend(snapshot: SnapshotSummary, snapshots: readonly SnapshotSummary[]): void {
    this.#run("trend", undefined, async (_signal, generation) => {
      const comparable = snapshots.filter((candidate) => sameScope(candidate, snapshot));
      const ordered = [...comparable].sort((left, right) => Date.parse(left.scannedAt) - Date.parse(right.scannedAt)).slice(-24);
      const total = (summary: SnapshotSummary): bigint => (summary.scope.accounting === "apparent" ? summary.totals.apparentBytes : summary.totals.allocatedBytes);
      const position = ordered.findIndex((candidate) => candidate.id === snapshot.id);
      const previous = position > 0 ? ordered[position - 1] : undefined;
      let growth = new Map<string, bigint>();
      if (previous !== undefined) {
        const diff = await this.#services.snapshots.diff(previous.id, snapshot.id);
        if (diff.kind === "diff") {
          growth = new Map(diff.diff.directories.filter((change) => change.deltaBytes !== 0n).map((change) => [change.path.bytesBase64, change.deltaBytes]));
        }
      }
      this.#ifCurrent("trend", generation, (state) => {
        if (state.explore.snapshot?.id !== snapshot.id) {
          return state;
        }
        const first = ordered[0];
        const trend =
          ordered.length >= 2 && first !== undefined
            ? { values: ordered.map(total), since: shortDate(first.scannedAt), delta: total(snapshot) - total(first) }
            : undefined;
        const rest = omit(state.explore, "trend");
        return {
          ...state,
          explore: {
            ...rest,
            growth,
            ...(trend === undefined ? {} : { trend }),
          },
        };
      });
    });
  }

  #askToScan(): void {
    const state = this.#state;
    let path: RawPath;
    if (state.tab === "Disks") {
      const mount = state.disks.view.filesystems[state.disks.selected]?.mounts[0];
      if (mount === undefined) {
        return;
      }
      path = mount;
    } else if (state.tab === "Explore") {
      path = state.explore.directory?.path ?? state.explore.root ?? this.#services.home;
    } else {
      return;
    }
    this.#set({ ...state, dialog: { kind: "confirm-scan", path, reason: state.explore.snapshot === undefined ? "Nothing has been scanned here yet." : "This replaces the stored scan's view with a fresh one; the older scan stays available for growth comparisons." } });
  }

  #scan(root: RawPath): void {
    const startedAt = this.#services.now().getTime();
    this.#set(switchTab(withoutDialog(this.#state), "Explore"));
    this.#run("scan", { label: "Scanning", detail: root.display, cancellable: true }, async (signal, generation) => {
      this.#set({ ...this.#state, explore: { ...this.#state.explore, root, scan: { root, entries: 0n, bytes: 0n, inaccessible: 0n, startedAt } } });
      const outcome = await this.#services.scan.run([root], {}, signal, (progress) => {
        this.#ifCurrent("scan", generation, (state) =>
          state.explore.scan === undefined
            ? state
            : {
                ...state,
                explore: {
                  ...state.explore,
                  scan: {
                    ...state.explore.scan,
                    entries: progress.scannedEntries,
                    bytes: progress.processedBytes,
                    inaccessible: progress.inaccessibleDirectories,
                    ...(progress.currentPath === undefined ? {} : { current: progress.currentPath.display }),
                  },
                },
              },
        );
      });
      const current = (): boolean => this.#running.get("scan")?.generation === generation;
      if (outcome.kind === "unavailable") {
        if (current()) {
          this.#set({ ...withoutScan(this.#state), dialog: { kind: "unavailable", title: "Cannot scan", capability: outcome.capability } });
        }
        return;
      }
      // What a scan read is recorded whether or not anybody is still looking
      // at it: a stopped scan's snapshot is real history.
      const summary = outcome.summary;
      await this.#services.snapshots.record(summary, { excludes: this.#services.defaults.excludes }, this.#services.now());
      await this.#services.snapshots.prune(this.#services.defaults.retention);
      // A scan that a newer one has replaced leaves the screen to it.
      if (!current()) {
        return;
      }
      const seconds = Math.max(0, Math.round((this.#services.now().getTime() - startedAt) / 1000));
      const complete = summary.completeness.complete;
      const cancelled = summary.completeness.warnings.some((warning) => warning.code === "cancelled");
      this.#set(
        withNotice(
          withoutScan(this.#state),
          complete
            ? `Scanned ${summary.completeness.scannedEntries.toLocaleString("en")} entries in ${seconds}s.`
            : cancelled
              ? `Scan stopped after ${summary.completeness.scannedEntries.toLocaleString("en")} entries; what it read is shown and marked incomplete.`
              : `Scanned with gaps: ${summary.completeness.warnings[0]?.message ?? "some directories could not be read"}.`,
          complete ? "ok" : "warn",
        ),
      );
      if (!this.#leaving) {
        this.#openExplore(root);
      }
    }, (state) => withoutScan(state));
  }

  #discover(): void {
    this.#set({ ...this.#state, findings: omit({ ...this.#state.findings, showProviders: false }, "failure") });
    this.#run("findings", { label: "Looking for what can be cleaned", detail: "every detector, then one measuring pass", cancellable: true }, async (signal, generation) => {
      const summary = await this.#services.footprint.discover({ measureSizes: true }, signal);
      this.#ifCurrent("findings", generation, (state) => {
        const rest = omit(state.findings, "failure");
        const selected = { Clean: 0, Dev: 0, Apps: 0 };
        return { ...state, findings: { ...rest, summary, loadedAt: this.#services.now().getTime(), selected } };
      });
    }, (state, message) => ({ ...state, findings: { ...state.findings, failure: message } }));
  }

  #loadHistory(more: boolean): void {
    const cursor = more ? this.#state.history.nextCursor : undefined;
    this.#run("history", undefined, async (_signal, generation) => {
      try {
        const page = await this.#services.history(cursor, 50);
        this.#ifCurrent("history", generation, (state) => {
          const rest = omit(state.history, "nextCursor", "failure");
          return {
            ...state,
            history: {
              ...rest,
              records: more ? [...state.history.records, ...page.records] : page.records,
              selected: more ? state.history.selected : 0,
              reconciled: state.history.reconciled + page.reconciled,
              loaded: true,
              ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
            },
          };
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "The journal could not be read.";
        this.#ifCurrent("history", generation, (state) => ({ ...state, history: { ...state.history, loaded: state.history.records.length > 0, failure: message } }));
        if (this.#state.history.records.length > 0) {
          throw error;
        }
      }
    });
  }

  // ---------------------------------------------------------------- plans and actions

  #planSelected(): void {
    const state = this.#state;
    if (state.tab === "Clean" || state.tab === "Dev" || state.tab === "Apps") {
      const finding = state.findings.showProviders ? undefined : selectedFinding(state);
      if (finding !== undefined) {
        this.#planFinding(finding);
      }
      return;
    }
    if (state.tab === "Explore") {
      const row = selectedExploreRow(state);
      if (row?.kind === "entry") {
        this.#plan({ operation: "trash", path: row.entry.path }, ["trash", "permanent"], "path");
      } else if (row?.kind === "member") {
        if (row.keep) {
          this.#set(withNotice(state, "This is the copy the keep rule keeps. Select one of the others to clean.", "info"));
          return;
        }
        // Releasing a copy because another exists is only offered through an
        // operation that compares the two in full before it acts (ADR 0006):
        // a hardlink replacement. Trash stays on offer because it can be
        // undone. A plain permanent removal is not offered for a duplicate.
        const group = state.explore.rows.find((candidate) => candidate.kind === "group" && candidate.index === row.groupIndex);
        const kept = group?.kind === "group" && group.group.decision.kind === "decided" ? group.group.decision.kept.path : undefined;
        if (kept === undefined) {
          this.#plan({ operation: "trash", path: row.file.path }, ["trash"], "path");
        } else {
          this.#plan({ operation: "trash", path: row.file.path }, ["trash", "dedup-hardlink"], "path", undefined, { keep: kept, copy: row.file.path });
        }
      }
    }
  }

  #planFinding(finding: Finding): void {
    const operation = defaultOperation(finding) as ActionOperation | undefined;
    if (operation === undefined || finding.availableActionIds.length === 0) {
      this.#set(withNotice(this.#state, "This finding is information only; there is nothing to plan for it.", "info"));
      return;
    }
    if (finding.capability.status !== "available") {
      this.#set({ ...this.#state, dialog: { kind: "unavailable", title: "Cannot plan this", capability: finding.capability } });
      return;
    }
    const alternatives = finding.availableActionIds.filter((candidate) => PLANNABLE.includes(candidate));
    if (!PLANNABLE.includes(operation)) {
      this.#set(withNotice(this.#state, `'${operation}' needs a destination; plan it with 'disktop clean plan ${finding.id} --operation ${operation}'.`, "info"));
      return;
    }
    this.#plan({ operation, findingId: finding.id }, alternatives, "finding");
  }

  #replan(dialog: Extract<Dialog, { kind: "review" }>, operation: ActionOperation): void {
    if (dialog.origin === "finding" && dialog.findingId !== undefined) {
      this.#plan({ operation, findingId: dialog.findingId }, dialog.alternatives, "finding", dialog.plan.id);
    } else if (dialog.pair !== undefined) {
      // A duplicate copy: a hardlink names the kept copy as its subject and
      // the copy as the one replaced; Trash moves the copy alone.
      const { keep, copy } = dialog.pair;
      const request =
        operation === "dedup-hardlink"
          ? { operation, path: keep, replacePath: copy, keepPath: keep }
          : { operation, path: copy };
      this.#plan(request, dialog.alternatives, "path", dialog.plan.id, dialog.pair);
    } else if (dialog.path !== undefined) {
      this.#plan({ operation, path: dialog.path }, dialog.alternatives, "path", dialog.plan.id);
    }
  }

  /**
   * Review a request into a plan. `replacing` names the review this one was
   * asked for from (`o`), which is the one dialog its answer may replace.
   */
  #plan(
    request: { operation: ActionOperation; findingId?: string; path?: RawPath; replacePath?: RawPath; keepPath?: RawPath },
    alternatives: readonly ActionOperation[],
    origin: "finding" | "path",
    replacing?: string,
    pair?: { readonly keep: RawPath; readonly copy: RawPath },
  ): void {
    this.#run("plan", { label: "Reviewing", detail: "fingerprinting every entry as it is now", cancellable: true }, async (signal, generation) => {
      const outcome = await this.#services.plan(request, signal);
      this.#ifCurrent("plan", generation, (state) => {
        // A plan nobody is waiting for any more — stopped, or overtaken by
        // another dialog — is dropped: a review must never appear in place of
        // something else, where a key meant for that would answer it.
        const asked = replacing !== undefined && state.dialog?.kind === "review" && state.dialog.plan.id === replacing;
        if (signal.aborted || (state.dialog !== undefined && !asked)) {
          return state;
        }
        if (outcome.kind === "refused") {
          return { ...withoutDialog(state), dialog: { kind: "refused", title: "Plan refused", failure: outcome.failure } };
        }
        return {
          ...state,
          dialog: {
            kind: "review",
            plan: outcome.plan,
            alternatives,
            typed: "",
            origin,
            ...(request.findingId === undefined ? {} : { findingId: request.findingId }),
            ...(request.path === undefined ? {} : { path: request.path }),
            ...(pair === undefined ? {} : { pair }),
          },
        };
      });
    });
  }

  #apply(plan: ActionPlan, origin: "finding" | "path"): void {
    const privileged = plan.permission === "manager-privilege";
    this.#abortPlanning();
    this.#set(withoutDialog(this.#state));
    this.#run("apply", { label: "Applying", detail: plan.scopeSummary, cancellable: false }, async (signal) => {
      if (privileged) {
        this.#hooks.suspend(`Disktop is running a reviewed manager command. sudo or pkexec may ask for your password.\n`);
      }
      let outcome;
      try {
        outcome = await this.#services.apply(
          { planId: plan.id, confirmed: true, acknowledgePermanent: plan.reversibility === "irreversible", interactive: true },
          signal,
        );
      } finally {
        if (privileged) {
          this.#hooks.resume();
        }
      }
      this.#set({ ...withoutDialog(this.#state), dialog: { kind: "applied", outcome } });
      if (outcome.kind === "applied") {
        // What was freed shows on the Disks tab, and the action in History.
        this.#refreshInventory(false);
        this.#loadHistory(false);
        // A stored scan and a list of findings are readings from before the
        // action. They are left as they were and labelled, never edited to look
        // like a fresh measurement.
        if (origin === "path") {
          this.#set(withNotice(this.#state, "The stored scan still lists what was moved until the next scan (S).", "info"));
        } else if (this.#state.findings.summary !== undefined) {
          this.#set(withNotice(this.#state, "Findings were measured before this action; press r on Clean to look again.", "info"));
        }
      }
    });
  }

  #undo(journalId: string): void {
    this.#set(withoutDialog(this.#state));
    this.#run("undo", { label: "Restoring from Trash", cancellable: false }, async (signal) => {
      const outcome = await this.#services.restore(journalId, signal);
      this.#set({ ...withoutDialog(this.#state), dialog: { kind: "undone", outcome } });
      this.#refreshInventory(false);
      this.#loadHistory(false);
    });
  }
}

/** The state with no scan in progress on screen. */
function withoutScan(state: AppState): AppState {
  return state.explore.scan === undefined ? state : { ...state, explore: omit(state.explore, "scan") };
}

/** What makes a dialog the same dialog across redraws: its kind and its subject. */
function dialogIdentity(dialog: Dialog): string {
  switch (dialog.kind) {
    case "review":
      return `review:${dialog.plan.id}`;
    case "undo-confirm":
      return `undo:${dialog.record.id}`;
    case "confirm-scan":
      return `scan:${dialog.path.bytesBase64}`;
    case "finding":
      return `finding:${dialog.finding.id}`;
    default:
      return dialog.kind;
  }
}

function exploreFailed(state: AppState, message: string): AppState {
  return { ...state, explore: { ...omit(state.explore, "nextCursor"), loading: false, rows: [], empty: message } };
}

function orderFor(sort: string): "ascending" | "descending" {
  return sort === "name" ? "ascending" : "descending";
}

function entryRow(entry: IndexedEntry): ExploreRow {
  return { kind: "entry", entry };
}

function parentPath(path: RawPath): RawPath | undefined {
  const bytes = pathBytes(path);
  let end = bytes.length;
  while (end > 1 && bytes[end - 1] === 0x2f) {
    end -= 1;
  }
  const slash = bytes.subarray(0, end).lastIndexOf(0x2f);
  if (slash < 0) {
    return undefined;
  }
  return rawPathFromBytes(bytes.subarray(0, Math.max(1, slash)));
}

function sameScope(left: SnapshotSummary, right: SnapshotSummary): boolean {
  return incompatibilities(left.scope, right.scope).length === 0;
}

function shortDate(iso: string): string {
  const date = new Date(Date.parse(iso));
  return `${date.toLocaleString("en", { month: "short", timeZone: "UTC" })} ${date.getUTCDate()}`;
}

/** For tests: how many rows the current tab lists. */
export function rowsInView(state: AppState): number {
  return listLength(state);
}

export { findingsFor };
