export interface CliOutput {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface OptionSpec {
  readonly name: string;
  readonly alias?: string;
  readonly summary: string;
  /** A flag stands alone; a value option takes the next argument. */
  readonly kind: "flag" | "value";
  readonly placeholder?: string;
  readonly choices?: readonly string[];
}

export interface CommandSpec {
  /** Words that select this command, empty for the root command. */
  readonly path: readonly string[];
  readonly summary: string;
  readonly operand?: { readonly name: string; readonly required: boolean };
  readonly options: readonly OptionSpec[];
  readonly implemented: boolean;
}

const JSON_OPTION: OptionSpec = { name: "json", summary: "Write one JSON object to stdout instead of text", kind: "flag" };

const UNITS_OPTION: OptionSpec = {
  name: "units",
  summary: "Human-readable unit base",
  kind: "value",
  placeholder: "iec|si",
  choices: ["iec", "si"],
};

/**
 * The single definition of the command surface. Help is rendered from it, the
 * parser validates against it, and shell completions are generated from it, so
 * a command cannot exist in one of those three and not the others.
 */
export const COMMANDS: readonly CommandSpec[] = [
  { path: [], summary: "Open the dashboard, or print it as JSON without a terminal", options: [JSON_OPTION, UNITS_OPTION], implemented: true },
  { path: ["devices"], summary: "List devices, filesystems, free space, and mounts", options: [JSON_OPTION, UNITS_OPTION], implemented: true },
  {
    path: ["alerts", "check"],
    summary: "Check space and inode thresholds; exit 1 when reached",
    options: [
      JSON_OPTION,
      UNITS_OPTION,
      { name: "threshold", summary: "Used percentage that raises an alert", kind: "value", placeholder: "PERCENT" },
      { name: "notify", summary: "Also notify the desktop when one is reached", kind: "flag" },
    ],
    implemented: true,
  },
  {
    path: ["scan"],
    summary: "Scan a path, index it, and save a snapshot",
    operand: { name: "PATH", required: false },
    options: [
      JSON_OPTION,
      UNITS_OPTION,
      { name: "accounting", summary: "Count bytes on disk or the size files claim", kind: "value", placeholder: "allocated|apparent", choices: ["allocated", "apparent"] },
      { name: "cross-filesystems", summary: "Descend into nested mounts instead of stopping at them", kind: "flag" },
      { name: "throttle", summary: "Hold the scan to a byte rate, for example 50MiB", kind: "value", placeholder: "RATE" },
      { name: "max-depth", summary: "Stop descending below this depth", kind: "value", placeholder: "DEPTH" },
    ],
    implemented: true,
  },
  {
    path: ["explore"],
    summary: "Sort and filter what the last scan of a path found",
    operand: { name: "PATH", required: false },
    options: [
      JSON_OPTION,
      UNITS_OPTION,
      { name: "sort", summary: "Ranking column", kind: "value", placeholder: "allocated|apparent|modified|name", choices: ["allocated", "apparent", "modified", "name"] },
      { name: "order", summary: "Ranking direction", kind: "value", placeholder: "ascending|descending", choices: ["ascending", "descending"] },
      { name: "kind", summary: "Show only entries of one kind", kind: "value", placeholder: "file|directory|symlink|other", choices: ["file", "directory", "symlink", "other"] },
      { name: "min-size", summary: "Only entries at least this large, for example 1GiB", kind: "value", placeholder: "SIZE" },
      { name: "max-size", summary: "Only entries at most this large", kind: "value", placeholder: "SIZE" },
      { name: "ext", summary: "Only files with this extension", kind: "value", placeholder: "EXTENSION" },
      { name: "name", summary: "Only entries whose name contains this text", kind: "value", placeholder: "TEXT" },
      { name: "older-than", summary: "Only entries not modified for this many days", kind: "value", placeholder: "DAYS" },
      { name: "limit", summary: "Entries per page, up to 1000", kind: "value", placeholder: "COUNT" },
      { name: "cursor", summary: "Continue from a previous page", kind: "value", placeholder: "CURSOR" },
      { name: "type-totals", summary: "Also report bytes per file extension", kind: "flag" },
      { name: "owners", summary: "Also report bytes per owning user", kind: "flag" },
    ],
    implemented: true,
  },
  {
    path: ["find"],
    summary: "Find duplicates, stale files, empty dirs, broken links",
    operand: { name: "KIND", required: true },
    options: [
      JSON_OPTION,
      UNITS_OPTION,
      { name: "path", summary: "The directory to search within", kind: "value", placeholder: "PATH" },
      { name: "limit", summary: "Entries or groups to list, up to 1000", kind: "value", placeholder: "COUNT" },
      {
        name: "keep",
        summary: "Duplicates: which copy of each group survives",
        kind: "value",
        placeholder: "oldest|newest|in-path",
        choices: ["oldest", "newest", "in-path"],
      },
      { name: "keep-under", summary: "Duplicates: the directory '--keep in-path' keeps from", kind: "value", placeholder: "PATH" },
      { name: "min-size", summary: "Duplicates: ignore files below this size", kind: "value", placeholder: "SIZE" },
      { name: "older-than", summary: "Stale: not modified for this many days", kind: "value", placeholder: "DAYS" },
    ],
    implemented: true,
  },
  {
    path: ["snapshots"],
    summary: "List saved snapshots or compare two of them",
    operand: { name: "ACTION", required: true },
    options: [
      JSON_OPTION,
      UNITS_OPTION,
      { name: "from", summary: "The earlier snapshot ID to compare", kind: "value", placeholder: "SNAPSHOT_ID" },
      { name: "to", summary: "The later snapshot ID to compare", kind: "value", placeholder: "SNAPSHOT_ID" },
    ],
    implemented: true,
  },
  {
    path: ["clean"],
    summary: "List what the detectors found, changing nothing",
    options: [
      JSON_OPTION,
      UNITS_OPTION,
      { name: "dry-run", summary: "Accepted and redundant: listing changes nothing", kind: "flag" },
      { name: "category", summary: "Show only one category of finding", kind: "value", placeholder: "CATEGORY" },
      { name: "no-sizes", summary: "Skip measuring footprints; sizes stay unknown", kind: "flag" },
      { name: "limit", summary: "Findings to list, up to 1000", kind: "value", placeholder: "COUNT" },
    ],
    implemented: true,
  },
  {
    path: ["clean", "plan"],
    summary: "Review a finding or path as a plan, changing nothing",
    operand: { name: "FINDING_ID", required: false },
    options: [
      JSON_OPTION,
      UNITS_OPTION,
      { name: "path", summary: "Review this path instead of a finding", kind: "value", placeholder: "PATH" },
      {
        name: "operation",
        summary: "The operation the plan fixes",
        kind: "value",
        placeholder: "OPERATION",
        choices: ["trash", "permanent", "empty-trash", "move", "compress", "hardlink", "manager"],
      },
      { name: "destination", summary: "Move or compress: the directory to publish into", kind: "value", placeholder: "PATH" },
      { name: "keep-path", summary: "Hardlink: which copy of a group survives", kind: "value", placeholder: "PATH" },
      { name: "replace", summary: "Hardlink: the copy that becomes a link", kind: "value", placeholder: "PATH" },
      {
        name: "source",
        summary: "Move or compress: what becomes of the source",
        kind: "value",
        placeholder: "trash|permanent",
        choices: ["trash", "permanent"],
      },
    ],
    implemented: true,
  },
  {
    path: ["clean", "apply"],
    summary: "Apply a reviewed plan, revalidating each item",
    operand: { name: "PLAN_ID", required: true },
    options: [
      JSON_OPTION,
      UNITS_OPTION,
      { name: "yes", summary: "Confirm a reviewed plan without a terminal", kind: "flag" },
      { name: "permanent", summary: "Acknowledge a plan that is already irreversible", kind: "flag" },
    ],
    implemented: true,
  },
  {
    path: ["history"],
    summary: "Inspect the action journal",
    options: [
      JSON_OPTION,
      UNITS_OPTION,
      { name: "cursor", summary: "Continue from a previous page", kind: "value", placeholder: "CURSOR" },
      { name: "limit", summary: "Records per page, up to 200", kind: "value", placeholder: "COUNT" },
    ],
    implemented: true,
  },
  {
    path: ["undo"],
    summary: "Put back what a Trash action moved",
    operand: { name: "ACTION_ID", required: true },
    options: [JSON_OPTION, UNITS_OPTION, { name: "yes", summary: "Confirm the restore without a terminal", kind: "flag" }],
    implemented: true,
  },
  { path: ["report"], summary: "Export JSON, CSV, or HTML", options: [JSON_OPTION], implemented: false },
  { path: ["timer"], summary: "Install or remove the opt-in alert timer", operand: { name: "ACTION", required: true }, options: [JSON_OPTION], implemented: true },
  { path: ["completion"], summary: "Generate a shell completion script", operand: { name: "SHELL", required: true }, options: [], implemented: false },
];

export interface ParsedCommand {
  readonly command: CommandSpec;
  readonly operand?: string;
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
}

export type ParseResult =
  | { readonly kind: "command"; readonly parsed: ParsedCommand }
  | { readonly kind: "help"; readonly command: CommandSpec }
  | { readonly kind: "version" }
  | { readonly kind: "error"; readonly message: string };

/** Every option that takes a value, so its value is never read as a command word. */
const VALUE_OPTION_NAMES: ReadonlySet<string> = new Set(
  COMMANDS.flatMap((command) =>
    command.options
      .filter((option) => option.kind === "value")
      .flatMap((option) => (option.alias === undefined ? [option.name] : [option.name, option.alias])),
  ),
);

/** Resolve the argument list against the command table without performing any work. */
export function parseArguments(args: readonly string[]): ParseResult {
  // Node decodes arguments as UTF-8 and puts U+FFFD wherever it could not, so
  // an argument holding one no longer names what was typed. A path built from
  // it would be a different path, so it is refused rather than guessed at.
  if (args.some((argument) => argument.includes("�"))) {
    return {
      kind: "error",
      message: "An argument held bytes that are not valid UTF-8, so Disktop cannot tell what it named. A path like that is reached through a finding, never typed.",
    };
  }
  const words = commandWords(args);
  const command = selectCommand(words.map((word) => word.value));
  if (command === undefined) {
    return { kind: "error", message: `Unknown Disktop command '${words.map((word) => word.value).join(" ")}'. Run disktop --help.` };
  }

  // Drop only the words that named the command; an option may sit anywhere.
  const consumed = new Set(words.slice(0, command.path.length).map((word) => word.index));
  const remaining = args.filter((_argument, index) => !consumed.has(index));
  const flags = new Set<string>();
  const values = new Map<string, string>();
  let operand: string | undefined;

  for (let index = 0; index < remaining.length; index += 1) {
    const argument = remaining[index] as string;

    if (argument === "--help" || argument === "-h") {
      return { kind: "help", command };
    }
    if ((argument === "--version" || argument === "-v") && command.path.length === 0) {
      return { kind: "version" };
    }

    if (!argument.startsWith("-")) {
      if (command.operand === undefined) {
        return { kind: "error", message: `'${command.path.join(" ") || "disktop"}' takes no argument, but received '${argument}'.` };
      }
      if (operand !== undefined) {
        return { kind: "error", message: `'${command.path.join(" ")}' takes one ${command.operand.name}, but received more than one.` };
      }
      if (argument === "") {
        // An unset variable in a script arrives as an empty argument, and an
        // empty path resolves to wherever the command happened to run.
        return { kind: "error", message: `'${command.path.join(" ")}' received an empty ${command.operand.name}, which names nothing.` };
      }
      operand = argument;
      continue;
    }

    const separator = argument.indexOf("=");
    const name = (separator < 0 ? argument : argument.slice(0, separator)).replace(/^--?/, "");
    const inlineValue = separator < 0 ? undefined : argument.slice(separator + 1);
    const option = command.options.find((candidate) => candidate.name === name || candidate.alias === name);

    if (option === undefined) {
      return { kind: "error", message: `'${command.path.join(" ") || "disktop"}' does not accept the option '${argument}'.` };
    }

    if (option.kind === "flag") {
      if (inlineValue !== undefined) {
        return { kind: "error", message: `'--${option.name}' is a flag and takes no value.` };
      }
      flags.add(option.name);
      continue;
    }

    const value = inlineValue ?? remaining[index + 1];
    if (value === undefined || (inlineValue === undefined && value.startsWith("-"))) {
      return { kind: "error", message: `'--${option.name}' needs a ${option.placeholder ?? "value"}.` };
    }
    if (value === "") {
      return { kind: "error", message: `'--${option.name}' received an empty ${option.placeholder ?? "value"}, which names nothing.` };
    }
    if (option.choices !== undefined && !option.choices.includes(value)) {
      return { kind: "error", message: `'--${option.name}' accepts ${option.choices.join(" or ")}, not '${value}'.` };
    }
    if (values.has(option.name)) {
      return { kind: "error", message: `'--${option.name}' was given more than once; give it once.` };
    }
    values.set(option.name, value);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  if (command.operand?.required === true && operand === undefined) {
    return { kind: "error", message: `'${command.path.join(" ")}' needs a ${command.operand.name}.` };
  }

  return { kind: "command", parsed: { command, ...(operand === undefined ? {} : { operand }), flags, values } };
}

/** The longest command path the leading words match, so `alerts check` beats `alerts`. */
function selectCommand(words: readonly string[]): CommandSpec | undefined {
  let best: CommandSpec | undefined;
  for (const command of COMMANDS) {
    if (command.path.every((word, index) => words[index] === word)) {
      if (best === undefined || command.path.length > best.path.length) {
        best = command;
      }
    }
  }
  if (best !== undefined && best.path.length === 0 && words.length > 0) {
    return undefined;
  }
  return best;
}

/**
 * The arguments that could name a command, with their original positions.
 *
 * A value option consumes the argument after it, so `--units si devices` selects
 * `devices` rather than treating `si` as a command name.
 */
function commandWords(args: readonly string[]): { value: string; index: number }[] {
  const words: { value: string; index: number }[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (!argument.startsWith("-")) {
      words.push({ value: argument, index });
      continue;
    }
    const name = argument.replace(/^--?/, "");
    if (!argument.includes("=") && VALUE_OPTION_NAMES.has(name)) {
      index += 1;
    }
  }
  return words;
}

export function renderHelp(command: CommandSpec = COMMANDS[0] as CommandSpec): string {
  const lines: string[] = [];

  if (command.path.length === 0) {
    lines.push("Disktop: Linux terminal storage manager and analyzer", "");
    lines.push("Usage:", "  disktop [COMMAND] [OPTIONS]", "");
    lines.push("Commands:");
    for (const entry of COMMANDS) {
      if (entry.path.length === 0) {
        continue;
      }
      const name = [...entry.path, entry.operand === undefined ? "" : entry.operand.name].join(" ").trim();
      const note = entry.implemented ? "" : " [planned]";
      lines.push(`  ${name.padEnd(22)} ${entry.summary}${note}`);
    }
    lines.push(
      "",
      "[planned] commands parse and validate their options, then report that they",
      "are not implemented. With no command Disktop opens the dashboard; with --json",
      "it prints the dashboard instead.",
    );
  } else {
    lines.push(command.summary, "");
    const operand = command.operand === undefined ? "" : ` ${command.operand.required ? command.operand.name : `[${command.operand.name}]`}`;
    lines.push("Usage:", `  disktop ${command.path.join(" ")}${operand} [OPTIONS]`);
    if (!command.implemented) {
      lines.push("", "This command is declared but not implemented yet.");
    }
  }

  lines.push("", "Options:");
  for (const option of [...command.options, ...HELP_OPTIONS(command)]) {
    const placeholder = option.kind === "value" ? ` ${option.placeholder ?? "VALUE"}` : "";
    lines.push(`  --${option.name}${placeholder}`.padEnd(24) + ` ${option.summary}`);
  }

  lines.push(
    "",
    "Exit status: 0 complete, 1 alert threshold reached, 2 input or operational",
    "error, 3 incomplete result, 130 interrupted.",
    "",
  );
  return lines.join("\n");
}

function HELP_OPTIONS(command: CommandSpec): readonly OptionSpec[] {
  const help: OptionSpec = { name: "help", alias: "h", summary: "Show this help", kind: "flag" };
  if (command.path.length > 0) {
    return [help];
  }
  return [help, { name: "version", alias: "v", summary: "Show the package version", kind: "flag" }];
}
