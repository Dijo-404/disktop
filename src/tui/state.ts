import type { DashboardView } from "../application/dashboard.js";

export const TABS = ["Disks", "Explore", "Clean", "Dev", "Apps", "History"] as const;
export type TabName = (typeof TABS)[number];

/** Which tabs have something behind them. The rest are shown and refuse politely. */
export const IMPLEMENTED_TABS: ReadonlySet<TabName> = new Set<TabName>(["Disks"]);

export interface AppState {
  readonly view: DashboardView;
  readonly tab: TabName;
  readonly selected: number;
  readonly showHelp: boolean;
  readonly units: "iec" | "si";
  readonly notice: string | undefined;
}

export function initialState(view: DashboardView, units: "iec" | "si"): AppState {
  return { view, tab: "Disks", selected: 0, showHelp: false, units, notice: undefined };
}

export type Intent =
  | { readonly kind: "move"; readonly delta: number }
  | { readonly kind: "tab"; readonly delta: number }
  | { readonly kind: "toggle-help" }
  | { readonly kind: "toggle-units" }
  | { readonly kind: "quit" }
  | { readonly kind: "none" };

export function reduce(state: AppState, intent: Intent): AppState {
  switch (intent.kind) {
    case "move": {
      const count = state.view.filesystems.length;
      if (count === 0) {
        return state;
      }
      const selected = Math.max(0, Math.min(count - 1, state.selected + intent.delta));
      return selected === state.selected ? state : { ...state, selected, notice: undefined };
    }
    case "tab": {
      const index = (TABS.indexOf(state.tab) + intent.delta + TABS.length) % TABS.length;
      const tab = TABS[index] as (typeof TABS)[number];
      return {
        ...state,
        tab,
        notice: IMPLEMENTED_TABS.has(tab) ? undefined : `${tab} arrives in a later phase; it has nothing to show yet.`,
      };
    }
    case "toggle-help":
      return { ...state, showHelp: !state.showHelp, notice: undefined };
    case "toggle-units":
      return { ...state, units: state.units === "iec" ? "si" : "iec", notice: undefined };
    case "quit":
    case "none":
      return state;
  }
}
