import type { Intent } from "./state.js";

/**
 * Vim keys and arrows reach the same intents. Nothing here deletes: a key can
 * move the selection, change a tab, or open help, and that is the whole
 * keyboard surface until the reviewed action pipeline exists.
 */
export function intentForKey(key: string): Intent {
  switch (key) {
    case "j":
    case "DOWN":
      return { kind: "move", delta: 1 };
    case "k":
    case "UP":
      return { kind: "move", delta: -1 };
    case "g":
    case "HOME":
      return { kind: "move", delta: Number.NEGATIVE_INFINITY };
    case "G":
    case "END":
      return { kind: "move", delta: Number.POSITIVE_INFINITY };
    case "PAGE_DOWN":
      return { kind: "move", delta: 10 };
    case "PAGE_UP":
      return { kind: "move", delta: -10 };
    case "TAB":
    case "l":
    case "RIGHT":
      return { kind: "tab", delta: 1 };
    case "SHIFT_TAB":
    case "h":
    case "LEFT":
      return { kind: "tab", delta: -1 };
    case "?":
      return { kind: "toggle-help" };
    case "u":
      return { kind: "toggle-units" };
    case "q":
    case "ESCAPE":
    case "CTRL_C":
      return { kind: "quit" };
    default:
      return { kind: "none" };
  }
}
