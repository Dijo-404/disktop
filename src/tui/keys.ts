/**
 * Keys become intents; the controller decides what an intent means where it
 * lands. Vim keys and arrows reach the same intents.
 *
 * No key deletes anything. The furthest any single key goes is opening a
 * review of a plan (`c`); applying it takes a separate confirmation, and an
 * irreversible plan takes the word "yes" typed out.
 */
export type Intent =
  | { readonly kind: "move"; readonly delta: number }
  | { readonly kind: "page"; readonly direction: 1 | -1; readonly half?: boolean }
  | { readonly kind: "tab"; readonly delta: number }
  | { readonly kind: "goto-tab"; readonly index: number }
  | { readonly kind: "left" }
  | { readonly kind: "right" }
  | { readonly kind: "open" }
  | { readonly kind: "up" }
  | { readonly kind: "help" }
  | { readonly kind: "units" }
  | { readonly kind: "quit" }
  | { readonly kind: "interrupt" }
  | { readonly kind: "cancel" }
  | { readonly kind: "refresh" }
  | { readonly kind: "scan" }
  | { readonly kind: "sort" }
  | { readonly kind: "mode" }
  | { readonly kind: "search" }
  | { readonly kind: "types" }
  | { readonly kind: "clean" }
  | { readonly kind: "undo" }
  | { readonly kind: "providers" }
  | { readonly kind: "confirm" }
  | { readonly kind: "deny" }
  | { readonly kind: "operation" }
  | { readonly kind: "type"; readonly text: string }
  | { readonly kind: "backspace" }
  | { readonly kind: "submit" }
  | { readonly kind: "clear-input" }
  | { readonly kind: "none" };

/** Intents for a key while the user is typing into a field. */
export function textIntentForKey(key: string): Intent {
  switch (key) {
    case "ENTER":
    case "KP_ENTER":
      return { kind: "submit" };
    case "ESCAPE":
      return { kind: "cancel" };
    case "CTRL_C":
      return { kind: "interrupt" };
    case "BACKSPACE":
    case "CTRL_H":
      return { kind: "backspace" };
    case "CTRL_U":
      return { kind: "clear-input" };
    default:
      return isPrintable(key) ? { kind: "type", text: key } : { kind: "none" };
  }
}

/** Intents for a key in normal navigation. */
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
    case "CTRL_F":
      return { kind: "page", direction: 1 };
    case "PAGE_UP":
    case "CTRL_B":
      return { kind: "page", direction: -1 };
    case "CTRL_D":
      return { kind: "page", direction: 1, half: true };
    case "CTRL_U":
      return { kind: "page", direction: -1, half: true };
    case "TAB":
    case "]":
      return { kind: "tab", delta: 1 };
    case "SHIFT_TAB":
    case "[":
      return { kind: "tab", delta: -1 };
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
    case "6":
      return { kind: "goto-tab", index: Number(key) - 1 };
    case "h":
    case "LEFT":
      return { kind: "left" };
    case "l":
    case "RIGHT":
      return { kind: "right" };
    case "ENTER":
    case "KP_ENTER":
      return { kind: "open" };
    case "BACKSPACE":
    case "-":
      return { kind: "up" };
    case "?":
    case "F1":
      return { kind: "help" };
    case "U":
      return { kind: "units" };
    case "q":
      return { kind: "quit" };
    case "CTRL_C":
      return { kind: "interrupt" };
    case "ESCAPE":
      return { kind: "cancel" };
    case "r":
    case "F5":
    case "CTRL_R":
      return { kind: "refresh" };
    case "s":
      return { kind: "sort" };
    case "S":
      return { kind: "scan" };
    case "f":
      return { kind: "mode" };
    case "/":
      return { kind: "search" };
    case "t":
      return { kind: "types" };
    case "c":
      return { kind: "clean" };
    case "u":
      return { kind: "undo" };
    case "p":
      return { kind: "providers" };
    case "y":
    case "Y":
      return { kind: "confirm" };
    case "n":
    case "N":
      return { kind: "deny" };
    case "o":
      return { kind: "operation" };
    default:
      return { kind: "none" };
  }
}

/** A single printable character, which is what terminal-kit names a typed key. */
function isPrintable(key: string): boolean {
  if (key.length === 0 || key.length > 8) {
    return false;
  }
  // terminal-kit names special keys in capitals with underscores (CTRL_A, F5).
  if (/^[A-Z][A-Z0-9_]+$/.test(key)) {
    return false;
  }
  return !/[\u0000-\u001f\u007f-\u009f]/.test(key);
}
