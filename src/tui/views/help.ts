import { LineBuilder, type ScreenLine } from "../frame.js";
import type { TabName } from "../state.js";
import { cellWidth, padEnd } from "../text.js";
import type { Theme } from "../themes.js";
import { boxInner, boxed } from "../widgets/box.js";
import type { ViewContext } from "./common.js";

type Section = readonly [title: string, keys: readonly (readonly [string, string])[]];

const FINDINGS_KEYS: Section = [
  "Clean · Dev · Apps",
  [
    ["⏎", "all about a finding"],
    ["c", "review a plan for it"],
    ["p", "which detectors ran"],
    ["r", "look again"],
    ["h l", "previous / next tab"],
  ],
];

function tabSection(tab: TabName): Section {
  switch (tab) {
    case "Disks":
      return ["Disks", [["⏎", "explore filesystem"], ["S", "scan it"], ["r", "read again"], ["h l", "previous / next tab"]]];
    case "Explore":
      return [
        "Explore",
        [
          ["⏎ l →", "open directory"],
          ["h ⌫ ←", "up one level"],
          ["s", "sort: size, age, name"],
          ["f", "finders: dupes, stale…"],
          ["/", "filter (see below)"],
          ["t", "file types"],
          ["n", "more rows"],
          ["c", "plan cleaning the row"],
          ["o (review)", "move or compress"],
          ["S", "scan again"],
          ["A", "measure unreadable as root"],
        ],
      ];
    case "Clean":
    case "Dev":
    case "Apps":
      return FINDINGS_KEYS;
    case "History":
      return ["History", [["u", "undo a Trash action"], ["n", "older actions"], ["r", "read again"], ["h l", "previous / next tab"]]];
  }
}

const EVERYWHERE: Section = [
  "Everywhere",
  [
    ["j k ↑ ↓", "move"],
    ["g G", "first / last"],
    ["PgUp PgDn", "page"],
    ["^U ^D", "half page"],
    ["1-6 Tab", "switch tab"],
    ["U", "IEC / SI units"],
    ["?", "this help"],
    ["esc", "close or stop"],
    ["q ^C", "quit"],
  ],
];

const READING: Section = [
  "Reading it",
  [
    ["~1.2 GiB", "a manager's estimate"],
    ["unknown", "not measured, not zero"],
    ["▲", "incomplete or too full"],
    ["●", "in use right now"],
  ],
];

const FILTER: Section = ["Filter syntax", [["words", "name contains"], ["ext:log", "extension"], [">1GiB <5MB", "size on disk"], ["age>30", "modified >30 days ago"], ["type:dir", "file dir link"]]];

const ASCII_KEYS: Readonly<Record<string, string>> = { "↑": "Up", "↓": "Dn", "←": "Left", "→": "Right", "⌫": "Bksp", "▲": "!", "●": "*", "⏎": "Enter", "…": "...", "·": "|" };

function block(section: Section, width: number, keyWidth: number, theme: Theme): ScreenLine[] {
  const [title, keys] = section;
  const ascii = (text: string): string => (theme.unicode ? text : text.replace(/[↑↓←→⌫▲●⏎…·]/g, (glyph) => ASCII_KEYS[glyph] ?? glyph));
  return [
    new LineBuilder(width).add(ascii(title), "heading").build(),
    ...keys.map(([key, label]) =>
      new LineBuilder(width).add(padEnd(ascii(key), keyWidth, theme.glyphs.ellipsis), "key").add(ascii(label), "dim").build(),
    ),
  ];
}

/**
 * The keys for the current tab and for everywhere, side by side when there is
 * room so all of it fits on an 80×24 screen without scrolling.
 */
export function renderHelp(context: ViewContext): ScreenLine[] {
  const { state, theme, width, height } = context;
  const inner = boxInner(width);
  const content: ScreenLine[] = [];
  const twoColumns = inner >= 66;
  const half = Math.floor(inner / 2);
  const keyWidth = theme.unicode ? 12 : 14;
  const left = [...block(tabSection(state.tab), half - 2, keyWidth, theme), { spans: [] }, ...block(READING, half - 2, keyWidth, theme)];
  const right = [...block(EVERYWHERE, inner - half, keyWidth, theme), ...(state.tab === "Explore" ? [{ spans: [] }, ...block(FILTER, inner - half, keyWidth, theme)] : [])];
  if (twoColumns) {
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const line = new LineBuilder(inner);
      for (const span of left[index]?.spans ?? []) line.add(span.text, span.style);
      line.padTo(half);
      for (const span of right[index]?.spans ?? []) line.add(span.text, span.style);
      content.push(line.build());
    }
  } else {
    content.push(...block(tabSection(state.tab), inner, keyWidth, theme), { spans: [] }, ...block(EVERYWHERE, inner, keyWidth, theme));
  }
  const promise = "Nothing on disk changes without a reviewed plan you confirm; Trash is the default.";
  const note = new LineBuilder(inner).add(cellWidth(promise) <= inner ? promise : "Nothing changes without a reviewed plan.", "muted");
  return boxed("Keys", content, width, height, theme, "accent", note.build());
}
