import { COMMANDS, type CommandSpec, type OptionSpec } from "./parser.js";

export const SHELLS = ["bash", "zsh", "fish"] as const;
export type Shell = (typeof SHELLS)[number];

export function isShell(value: string): value is Shell {
  return (SHELLS as readonly string[]).includes(value);
}

/**
 * How the value after an option, or a command's operand, completes.
 *
 * A placeholder of `PATH` or `FILE` names something on disk, so it completes
 * file names; a fixed list of choices completes those words; anything else —
 * a count, a size, an ID Disktop printed — completes nothing rather than
 * offering file names that would be wrong.
 */
export type ValueCompletion =
  | { readonly kind: "words"; readonly words: readonly string[] }
  | { readonly kind: "path" }
  | { readonly kind: "none" };

const PATH_PLACEHOLDERS: ReadonlySet<string> = new Set(["PATH", "FILE"]);

export function optionCompletion(option: OptionSpec): ValueCompletion {
  if (option.choices !== undefined) {
    return { kind: "words", words: option.choices };
  }
  return option.placeholder !== undefined && PATH_PLACEHOLDERS.has(option.placeholder) ? { kind: "path" } : { kind: "none" };
}

export function operandCompletion(command: CommandSpec): ValueCompletion {
  if (command.operand === undefined) {
    return { kind: "none" };
  }
  if (command.operand.choices !== undefined) {
    return { kind: "words", words: command.operand.choices };
  }
  return PATH_PLACEHOLDERS.has(command.operand.name) ? { kind: "path" } : { kind: "none" };
}

/**
 * A point in the command tree: the root, a command, or a word that only
 * leads to commands, like `alerts` before `check`. The words typed so far
 * select one by the longest match, exactly as the parser does.
 */
export interface CompletionNode {
  readonly words: readonly string[];
  readonly children: readonly { readonly word: string; readonly summary: string }[];
  readonly command?: CommandSpec;
}

export function completionTree(commands: readonly CommandSpec[] = COMMANDS): readonly CompletionNode[] {
  const nodes = new Map<string, { words: readonly string[]; children: { word: string; summary: string }[]; command?: CommandSpec }>();
  const node = (words: readonly string[]) => {
    const key = words.join(" ");
    let found = nodes.get(key);
    if (found === undefined) {
      found = { words, children: [] };
      nodes.set(key, found);
    }
    return found;
  };

  for (const command of commands) {
    for (let depth = 0; depth < command.path.length; depth += 1) {
      const parent = node(command.path.slice(0, depth));
      const word = command.path[depth] as string;
      if (!parent.children.some((child) => child.word === word)) {
        // A word that is a command describes itself; one that only leads to
        // commands, like `alerts`, borrows the summary of the first it leads to.
        const prefix = command.path.slice(0, depth + 1);
        const exact = commands.find((candidate) => candidate.path.join(" ") === prefix.join(" "));
        parent.children.push({ word, summary: (exact ?? command).summary });
      }
    }
    node(command.path).command = command;
  }
  return [...nodes.values()];
}

/** Every option a command accepts, including the `--help` and `--version` the parser adds. */
export function commandOptions(command: CommandSpec): readonly OptionSpec[] {
  const help: OptionSpec = { name: "help", alias: "h", summary: "Show this help", kind: "flag" };
  const version: OptionSpec = { name: "version", alias: "v", summary: "Show the package version", kind: "flag" };
  return command.path.length === 0 ? [...command.options, help, version] : [...command.options, help];
}

/** Generate the completion script for one shell from the command table. */
export function completionScript(shell: Shell, commands: readonly CommandSpec[] = COMMANDS): string {
  const tree = completionTree(commands);
  switch (shell) {
    case "bash":
      return bashScript(tree);
    case "zsh":
      return zshScript(tree);
    default:
      return fishScript(tree);
  }
}

/** Every option that takes a value, under any command, so its value is never read as a command word. */
function valueOptionNames(tree: readonly CompletionNode[]): readonly string[] {
  const names = new Set<string>();
  for (const node of tree) {
    for (const option of node.command === undefined ? [] : commandOptions(node.command)) {
      if (option.kind === "value") {
        names.add(`--${option.name}`);
        if (option.alias !== undefined) {
          names.add(`-${option.alias}`);
        }
      }
    }
  }
  return [...names].sort();
}

function optionFlags(option: OptionSpec): readonly string[] {
  return option.alias === undefined ? [`--${option.name}`] : [`--${option.name}`, `-${option.alias}`];
}

/** A word list as one single-quoted POSIX shell word. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function generated(shell: Shell): readonly string[] {
  return [
    `Generated by 'disktop completion ${shell}' from the command table Disktop`,
    "parses its own arguments with, so it offers exactly the commands and options",
    "this version accepts. Regenerate it after upgrading rather than editing it.",
  ];
}

function bashScript(tree: readonly CompletionNode[]): string {
  const key = (node: CompletionNode): string => shellQuote(node.words.join(" "));
  const lines: string[] = [
    "# bash completion for disktop",
    ...generated("bash").map((line) => `# ${line}`),
    "#",
    "# Install: disktop completion bash > ~/.local/share/bash-completion/completions/disktop",
    "# or, for this shell only: source <(disktop completion bash)",
    "",
    "_disktop_takes_value() {",
    '    case "$1" in',
    `        ${valueOptionNames(tree).join("|")}) return 0 ;;`,
    "    esac",
    "    return 1",
    "}",
    "",
    "_disktop_children() {",
    '    case "$1" in',
  ];
  for (const node of tree) {
    if (node.children.length > 0) {
      lines.push(`        ${key(node)}) echo ${shellQuote(node.children.map((child) => child.word).join(" "))} ;;`);
    }
  }
  lines.push("    esac", "}", "", "_disktop_options() {", '    case "$1" in');
  for (const node of tree) {
    if (node.command !== undefined) {
      lines.push(`        ${key(node)}) echo ${shellQuote(commandOptions(node.command).flatMap(optionFlags).join(" "))} ;;`);
    }
  }
  lines.push(
    "    esac",
    "}",
    "",
    "# How a command's operand completes: 'words ...', 'path', or nothing.",
    "_disktop_operand() {",
    '    case "$1" in',
  );
  for (const node of tree) {
    const completion = node.command === undefined ? { kind: "none" as const } : operandCompletion(node.command);
    const spec = bashSpec(completion);
    if (spec !== undefined) {
      lines.push(`        ${key(node)}) echo ${shellQuote(spec)} ;;`);
    }
  }
  lines.push(
    "    esac",
    "}",
    "",
    "# How the value of one command's option completes: 'words ...', 'path', or nothing.",
    "_disktop_option_value() {",
    '    case "$1|$2" in',
  );
  for (const node of tree) {
    for (const option of node.command === undefined ? [] : commandOptions(node.command)) {
      const spec = option.kind === "value" ? bashSpec(optionCompletion(option)) : undefined;
      if (spec !== undefined) {
        const labels = optionFlags(option).map((flag) => shellQuote(`${node.words.join(" ")}|${flag}`));
        lines.push(`        ${labels.join("|")}) echo ${shellQuote(spec)} ;;`);
      }
    }
  }
  lines.push(
    "    esac",
    "}",
    "",
    "_disktop_reply() {",
    '    local spec="$1" cur="$2"',
    '    case "$spec" in',
    "        path)",
    "            compopt -o filenames 2>/dev/null",
    '            mapfile -t COMPREPLY < <(compgen -f -- "$cur")',
    "            ;;",
    "        words\\ *)",
    '            mapfile -t COMPREPLY < <(compgen -W "${spec#words }" -- "$cur")',
    "            ;;",
    "        *)",
    "            COMPREPLY=()",
    "            ;;",
    "    esac",
    "}",
    "",
    "_disktop() {",
    '    local cur="${COMP_WORDS[COMP_CWORD]}"',
    '    local node="" option="" prefix="" word i',
    "    local operands=0",
    "    COMPREPLY=()",
    "",
    "    # Walk the words before the cursor the way the parser does: an option's",
    "    # value is never a command word, and the longest run of command words",
    "    # selects the command. Anything after that is its operand.",
    "    for ((i = 1; i < COMP_CWORD; i++)); do",
    '        word="${COMP_WORDS[i]}"',
    '        if [[ "$word" == -* ]]; then',
    '            if [[ "$word" != *=* ]] && _disktop_takes_value "$word"; then',
    "                # readline splits --option=value at '=' when COMP_WORDBREAKS holds it.",
    '                if [[ "${COMP_WORDS[i+1]}" == "=" ]]; then',
    "                    i=$((i + 1))",
    "                fi",
    "                i=$((i + 1))",
    "            fi",
    "            continue",
    "        fi",
    '        if ((operands == 0)) && [[ " $(_disktop_children "$node") " == *" $word "* ]]; then',
    '            node="${node:+$node }$word"',
    "        else",
    "            operands=$((operands + 1))",
    "        fi",
    "    done",
    "",
    '    if [[ "$cur" == "=" ]] && ((COMP_CWORD > 1)); then',
    '        option="${COMP_WORDS[COMP_CWORD-1]}"',
    '        cur=""',
    '    elif [[ "${COMP_WORDS[COMP_CWORD-1]}" == "=" ]] && ((COMP_CWORD > 2)); then',
    '        option="${COMP_WORDS[COMP_CWORD-2]}"',
    '    elif [[ "$cur" == --*=* ]]; then',
    '        option="${cur%%=*}"',
    '        prefix="$option="',
    '        cur="${cur#*=}"',
    '    elif ((COMP_CWORD > 1)) && [[ "${COMP_WORDS[COMP_CWORD-1]}" == -* && "${COMP_WORDS[COMP_CWORD-1]}" != *=* ]] \\',
    '        && _disktop_takes_value "${COMP_WORDS[COMP_CWORD-1]}"; then',
    '        option="${COMP_WORDS[COMP_CWORD-1]}"',
    "    fi",
    "",
    '    if [[ -n "$option" ]]; then',
    '        _disktop_takes_value "$option" || return 0',
    '        _disktop_reply "$(_disktop_option_value "$node" "$option")" "$cur"',
    '        if [[ -n "$prefix" ]]; then',
    '            COMPREPLY=("${COMPREPLY[@]/#/$prefix}")',
    "        fi",
    "        return 0",
    "    fi",
    '    if [[ "$cur" == -* ]]; then',
    '        _disktop_reply "words $(_disktop_options "$node")" "$cur"',
    "        return 0",
    "    fi",
    "    if ((operands == 0)); then",
    "        local operand",
    '        operand="$(_disktop_operand "$node")"',
    '        if [[ "$operand" == path ]]; then',
    '            _disktop_reply path "$cur"',
    "        else",
    '            _disktop_reply "words $(_disktop_children "$node") ${operand#words}" "$cur"',
    "        fi",
    "    fi",
    "    return 0",
    "}",
    "",
    "complete -F _disktop disktop",
    "",
  );
  return lines.join("\n");
}

function bashSpec(completion: ValueCompletion): string | undefined {
  switch (completion.kind) {
    case "words":
      return `words ${completion.words.join(" ")}`;
    case "path":
      return "path";
    default:
      return undefined;
  }
}

/** A `name:description` pair for zsh's `_describe`, whose separator is a colon. */
function describeEntry(name: string, summary: string): string {
  return shellQuote(`${name.replace(/:/g, "\\:")}:${summary}`);
}

function zshScript(tree: readonly CompletionNode[]): string {
  const label = (node: CompletionNode): string => shellQuote(node.words.join(" "));
  const lines: string[] = [
    "#compdef disktop",
    "# zsh completion for disktop",
    ...generated("zsh").map((line) => `# ${line}`),
    "#",
    "# Install: mkdir -p ~/.zfunc && disktop completion zsh > ~/.zfunc/_disktop, with",
    "# fpath=(~/.zfunc $fpath) before compinit in ~/.zshrc; or, after compinit, for",
    "# this shell only: source <(disktop completion zsh)",
    "",
    "_disktop_takes_value() {",
    "  case $1 in",
    `    (${valueOptionNames(tree).join("|")}) return 0 ;;`,
    "  esac",
    "  return 1",
    "}",
    "",
    "_disktop_is_child() {",
    '  case "$1|$2" in',
  ];
  const childLabels = tree.flatMap((node) => node.children.map((child) => shellQuote(`${node.words.join(" ")}|${child.word}`)));
  lines.push(`    (${childLabels.join("|")}) return 0 ;;`, "  esac", "  return 1", "}", "");

  lines.push(
    "_disktop() {",
    "  local node='' word option='' cur=${words[CURRENT]}",
    "  local -i i operands=0",
    "  local -a candidates",
    "",
    "  # Walk the words before the cursor the way the parser does: an option's",
    "  # value is never a command word, and the longest run of command words",
    "  # selects the command. Anything after that is its operand.",
    "  for (( i = 2; i < CURRENT; i++ )); do",
    "    word=${words[i]}",
    "    if [[ $word == -* ]]; then",
    "      if [[ $word != *=* ]] && _disktop_takes_value $word; then",
    "        (( i++ ))",
    "      fi",
    "      continue",
    "    fi",
    '    if (( operands == 0 )) && _disktop_is_child "$node" "$word"; then',
    "      node=${node:+$node }$word",
    "    else",
    "      (( operands++ ))",
    "    fi",
    "  done",
    "",
    "  if [[ $cur == --*=* ]]; then",
    "    option=${cur%%=*}",
    "    compset -P '*='",
    "  elif (( CURRENT > 2 )) && [[ ${words[CURRENT-1]} == -* && ${words[CURRENT-1]} != *=* ]] && _disktop_takes_value ${words[CURRENT-1]}; then",
    "    option=${words[CURRENT-1]}",
    "  fi",
    "",
    "  if [[ -n $option ]]; then",
    "    _disktop_takes_value $option || return 1",
    '    case "$node|$option" in',
  );
  for (const node of tree) {
    for (const option of node.command === undefined ? [] : commandOptions(node.command)) {
      if (option.kind !== "value") {
        continue;
      }
      const completion = optionCompletion(option);
      const labels = optionFlags(option).map((flag) => shellQuote(`${node.words.join(" ")}|${flag}`)).join("|");
      if (completion.kind === "words") {
        lines.push(`      (${labels}) compadd -- ${completion.words.map(shellQuote).join(" ")} ;;`);
      } else if (completion.kind === "path") {
        lines.push(`      (${labels}) _files ;;`);
      }
    }
  }
  lines.push("    esac", "    return", "  fi", "", "  if [[ $cur == -* ]]; then", "    case $node in");
  for (const node of tree) {
    if (node.command === undefined) {
      continue;
    }
    const entries = commandOptions(node.command).flatMap((option) => optionFlags(option).map((flag) => describeEntry(flag, option.summary)));
    lines.push(`      (${label(node)}) candidates=(${entries.join(" ")}) ;;`);
  }
  lines.push(
    "    esac",
    "    (( ${#candidates} )) && _describe -t options 'disktop option' candidates",
    "    return",
    "  fi",
    "",
    "  (( operands == 0 )) || return 1",
    "  case $node in",
  );
  for (const node of tree) {
    if (node.children.length > 0) {
      const entries = node.children.map((child) => describeEntry(child.word, child.summary));
      lines.push(`    (${label(node)}) candidates=(${entries.join(" ")}) ;;`);
    }
  }
  lines.push("  esac", "  (( ${#candidates} )) && _describe -t commands 'disktop command' candidates", "  case $node in");
  for (const node of tree) {
    const completion = node.command === undefined ? { kind: "none" as const } : operandCompletion(node.command);
    if (completion.kind === "words") {
      lines.push(`    (${label(node)}) compadd -- ${completion.words.map(shellQuote).join(" ")} ;;`);
    } else if (completion.kind === "path") {
      lines.push(`    (${label(node)}) _files ;;`);
    }
  }
  lines.push(
    "  esac",
    "}",
    "",
    "# Loaded from $fpath, this file is the completion function itself and runs",
    "# it; sourced into a shell, it registers the function instead.",
    'if [[ $funcstack[1] == _disktop ]]; then',
    '  _disktop "$@"',
    "else",
    "  compdef _disktop disktop",
    "fi",
    "",
  );
  return lines.join("\n");
}

/** A fish single-quoted string, where only the backslash and the quote are special. */
function fishQuote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** A node as one word fish can test without quoting: `disktop.clean.plan`. */
function fishKey(node: CompletionNode): string {
  return ["disktop", ...node.words].join(".");
}

function fishScript(tree: readonly CompletionNode[]): string {
  const lines: string[] = [
    "# fish completion for disktop",
    ...generated("fish").map((line) => `# ${line}`),
    "#",
    "# Install: disktop completion fish > ~/.config/fish/completions/disktop.fish",
    "",
    "function __disktop_takes_value",
    `    contains -- $argv[1] ${valueOptionNames(tree).join(" ")}`,
    "end",
    "",
    "function __disktop_has_child",
    '    switch "$argv[1] $argv[2]"',
  ];
  const childLabels = tree.flatMap((node) => node.children.map((child) => fishQuote(`${fishKey(node)} ${child.word}`)));
  lines.push(
    `        case ${childLabels.join(" ")}`,
    "            return 0",
    "    end",
    "    return 1",
    "end",
    "",
    "# The command the words before the cursor select, and how many operands",
    "# follow it, found the way the parser finds them: an option's value is never",
    "# a command word, and the longest run of command words selects the command.",
    "function __disktop_state",
    "    set -l tokens (commandline -opc)",
    "    set -e tokens[1]",
    "    set -l node disktop",
    "    set -l operands 0",
    "    set -l skip 0",
    "    for token in $tokens",
    "        if test $skip -eq 1",
    "            set skip 0",
    "            continue",
    "        end",
    "        if string match -q -- '-*' $token",
    "            if not string match -q -- '*=*' $token; and __disktop_takes_value $token",
    "                set skip 1",
    "            end",
    "            continue",
    "        end",
    "        if test $operands -eq 0; and __disktop_has_child $node $token",
    "            set node $node.$token",
    "        else",
    "            set operands (math $operands + 1)",
    "        end",
    "    end",
    "    printf '%s\\n' $node $operands",
    "end",
    "",
    "function __disktop_at",
    "    set -l state (__disktop_state)",
    '    test "$state[1]" = "$argv[1]"',
    "end",
    "",
    "function __disktop_operand_at",
    "    set -l state (__disktop_state)",
    '    test "$state[1]" = "$argv[1]"; and test "$state[2]" -eq 0',
    "end",
    "",
    "complete -c disktop -f",
  );

  for (const node of tree) {
    const key = fishKey(node);
    for (const child of node.children) {
      lines.push(`complete -c disktop -n ${fishQuote(`__disktop_operand_at ${key}`)} -a ${fishQuote(child.word)} -d ${fishQuote(child.summary)}`);
    }
    if (node.command === undefined) {
      continue;
    }
    const operand = operandCompletion(node.command);
    if (operand.kind === "words") {
      lines.push(`complete -c disktop -n ${fishQuote(`__disktop_operand_at ${key}`)} -a ${fishQuote(operand.words.join(" "))}`);
    } else if (operand.kind === "path") {
      lines.push(`complete -c disktop -n ${fishQuote(`__disktop_operand_at ${key}`)} -F`);
    }
    for (const option of commandOptions(node.command)) {
      const parts = [`complete -c disktop -n ${fishQuote(`__disktop_at ${key}`)}`];
      if (option.alias !== undefined) {
        parts.push(`-s ${option.alias}`);
      }
      parts.push(`-l ${option.name}`);
      if (option.kind === "value") {
        const completion = optionCompletion(option);
        if (completion.kind === "words") {
          parts.push(`-x -a ${fishQuote(completion.words.join(" "))}`);
        } else if (completion.kind === "path") {
          parts.push("-r -F");
        } else {
          parts.push("-x");
        }
      }
      parts.push(`-d ${fishQuote(option.summary)}`);
      lines.push(parts.join(" "));
    }
  }
  lines.push("");
  return lines.join("\n");
}
