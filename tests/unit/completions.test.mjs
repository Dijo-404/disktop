import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { COMMANDS } from "../../dist/cli/parser.js";
import { SHELLS, commandOptions, completionScript, completionTree, operandCompletion, optionCompletion } from "../../dist/cli/completions.js";
import { runCli } from "../../dist/cli/run.js";
import { fakeContext } from "../support/cli-context.mjs";

const scratch = await mkdtemp(join(tmpdir(), "disktop-completion-"));
after(() => rm(scratch, { recursive: true, force: true }));

const scripts = new Map();
for (const shell of SHELLS) {
  const path = join(scratch, `disktop.${shell}`);
  await writeFile(path, completionScript(shell));
  scripts.set(shell, path);
}

function shellAvailable(shell) {
  const probe = spawnSync(shell, ["-c", "exit 0"], { encoding: "utf8" });
  return probe.error === undefined && probe.status === 0;
}

test("every shell's script parses without running", (context) => {
  const checks = { bash: ["-n"], zsh: ["-n"], fish: ["--no-execute"] };
  for (const shell of SHELLS) {
    if (!shellAvailable(shell)) {
      context.diagnostic(`${shell} is not installed; its syntax was not checked`);
      continue;
    }
    const result = spawnSync(shell, [...checks[shell], scripts.get(shell)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${shell} rejected its script: ${result.stderr}`);
  }
  assert.ok(shellAvailable("bash"), "bash is required to check the bash script at all");
});

test("every command, subcommand word, and option in the table is in every script", () => {
  for (const shell of SHELLS) {
    const script = completionScript(shell);
    for (const command of COMMANDS) {
      for (const word of command.path) {
        assert.ok(script.includes(word), `${shell} is missing the command word '${word}'`);
      }
      for (const option of commandOptions(command)) {
        const needle = shell === "fish" ? `-l ${option.name} ` : `--${option.name}`;
        assert.ok(script.includes(needle), `${shell} is missing '--${option.name}' for '${command.path.join(" ") || "disktop"}'`);
        for (const choice of option.choices ?? []) {
          assert.ok(script.includes(choice), `${shell} is missing '${choice}' for '--${option.name}'`);
        }
      }
      for (const choice of command.operand?.choices ?? []) {
        assert.ok(script.includes(choice), `${shell} is missing the operand word '${choice}'`);
      }
    }
  }
});

test("operands and options that name a file complete file names, and nothing else does", () => {
  const pathOptions = COMMANDS.flatMap((command) => command.options)
    .filter((option) => option.kind === "value" && optionCompletion(option).kind === "path")
    .map((option) => option.name);
  for (const name of ["output", "path", "destination", "keep-under", "keep-path", "replace"]) {
    assert.ok(pathOptions.includes(name), `--${name} should complete file names`);
  }
  for (const name of ["limit", "cursor", "threshold", "min-size", "category"]) {
    assert.ok(!pathOptions.includes(name), `--${name} takes no file name`);
  }

  const byPath = new Map(COMMANDS.map((command) => [command.path.join(" "), command]));
  assert.equal(operandCompletion(byPath.get("scan")).kind, "path");
  assert.equal(operandCompletion(byPath.get("explore")).kind, "path");
  assert.deepEqual(operandCompletion(byPath.get("find")).words, ["duplicates", "stale", "empty", "broken"]);
  assert.deepEqual(operandCompletion(byPath.get("snapshots")).words, ["list", "diff"]);
  assert.deepEqual(operandCompletion(byPath.get("timer")).words, ["install", "uninstall"]);
  assert.deepEqual(operandCompletion(byPath.get("completion")).words, ["bash", "zsh", "fish"]);
  assert.equal(operandCompletion(byPath.get("clean apply")).kind, "none", "a plan ID is not a file");
});

test("the tree has a node for each word that only leads to commands", () => {
  const tree = completionTree();
  const alerts = tree.find((node) => node.words.join(" ") === "alerts");
  assert.ok(alerts, "'alerts' leads to 'alerts check'");
  assert.equal(alerts.command, undefined);
  assert.deepEqual(alerts.children.map((child) => child.word), ["check"]);
  const clean = tree.find((node) => node.words.join(" ") === "clean");
  assert.deepEqual(clean.children.map((child) => child.word), ["plan", "apply"]);
  assert.ok(clean.command, "'clean' is a command as well as a prefix");
});

/**
 * Ask the bash script for completions exactly as readline would: with the
 * words split and the cursor on the last one.
 */
function bashComplete(words, cwd = scratch) {
  const driver = [
    'source "$1"',
    "shift",
    'COMP_WORDS=("$@")',
    "COMP_CWORD=$((${#COMP_WORDS[@]} - 1))",
    'COMP_LINE="${COMP_WORDS[*]}"',
    "COMP_POINT=${#COMP_LINE}",
    "_disktop",
    "printf '%s\\n' \"${COMPREPLY[@]}\"",
  ].join("\n");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", driver, "driver", scripts.get("bash"), "disktop", ...words], {
    encoding: "utf8",
    cwd,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n").filter((line) => line !== "");
}

test("bash completes command words, operand keywords, options, and their values", (context) => {
  if (!shellAvailable("bash")) {
    context.skip("bash is not installed");
    return;
  }
  const root = bashComplete([""]);
  for (const word of ["devices", "alerts", "scan", "explore", "find", "snapshots", "clean", "history", "undo", "report", "timer", "completion"]) {
    assert.ok(root.includes(word), `the root offers '${word}'`);
  }

  assert.deepEqual(bashComplete(["alerts", ""]), ["check"]);
  assert.deepEqual(bashComplete(["clean", ""]).sort(), ["apply", "plan"]);
  assert.deepEqual(bashComplete(["find", ""]), ["duplicates", "stale", "empty", "broken"]);
  assert.deepEqual(bashComplete(["find", "st"]), ["stale"]);
  assert.deepEqual(bashComplete(["snapshots", ""]), ["list", "diff"]);
  assert.deepEqual(bashComplete(["timer", ""]), ["install", "uninstall"]);
  assert.deepEqual(bashComplete(["completion", ""]), ["bash", "zsh", "fish"]);
  // The operand is given; a command takes one, so nothing more is offered.
  assert.deepEqual(bashComplete(["find", "stale", ""]), []);

  assert.deepEqual(bashComplete(["report", "--format", ""]), ["json", "csv", "html"]);
  assert.deepEqual(bashComplete(["report", "--f"]).sort(), ["--findings", "--format"]);
  assert.deepEqual(bashComplete(["clean", "plan", "--operation", "h"]), ["hardlink"]);
  assert.ok(bashComplete(["clean", "plan", "--"]).includes("--destination"));
  assert.ok(!bashComplete(["clean", "--"]).includes("--destination"), "'clean' alone has no --destination");
  assert.deepEqual(bashComplete(["--"]).sort(), ["--help", "--json", "--units", "--version"]);

  // An option's value is never read as a command word, wherever it sits.
  assert.deepEqual(bashComplete(["--units", "si", "find", "du"]), ["duplicates"]);
  // --option=value, split at '=' by readline, and not split.
  assert.deepEqual(bashComplete(["devices", "--units", "=", "s"]), ["si"]);
  assert.deepEqual(bashComplete(["devices", "--units", "="]).sort(), ["iec", "si"]);
  assert.deepEqual(bashComplete(["devices", "--units=s"]), ["--units=si"]);
  // A value with no fixed words offers nothing rather than guessing.
  assert.deepEqual(bashComplete(["report", "--limit", ""]), []);
  assert.deepEqual(bashComplete(["bogus", ""]), []);
});

test("bash completes file names where a path belongs", async (context) => {
  if (!shellAvailable("bash")) {
    context.skip("bash is not installed");
    return;
  }
  const directory = join(scratch, "files");
  await mkdir(join(directory, "reports-dir"), { recursive: true });
  await writeFile(join(directory, "report one.html"), "");

  assert.deepEqual(bashComplete(["report", "--output", "report"], directory).sort(), ["report one.html", "reports-dir"]);
  assert.deepEqual(bashComplete(["scan", "reports"], directory), ["reports-dir"]);
  assert.deepEqual(bashComplete(["clean", "plan", "--path", "rep"], directory).sort(), ["report one.html", "reports-dir"]);
});

/**
 * Ask the zsh script for candidates. Outside a completion widget zsh has no
 * `compadd` or `_describe`, so they are stood in for by functions that print
 * what they were offered; a function shadows a builtin of the same name.
 */
function zshComplete(words) {
  const driver = [
    "compdef() { :; }",
    "compset() { :; }",
    'compadd() { [[ $1 == -- ]] && shift; print -l -- "$@"; }',
    '_describe() { local -a items; items=("${(@P)4}"); print -l -- "${items[@]%%:*}"; }',
    '_files() { print -- "<files>"; }',
    'source "$1"',
    "shift",
    'words=(disktop "$@")',
    "CURRENT=${#words}",
    "_disktop",
  ].join("\n");
  const result = spawnSync("zsh", ["-f", "-c", driver, "driver", scripts.get("zsh"), ...words], { encoding: "utf8" });
  assert.equal(result.stderr, "", result.stderr);
  return result.stdout.split("\n").filter((line) => line !== "");
}

test("zsh offers the same words, with the command table's summaries", (context) => {
  if (!shellAvailable("zsh")) {
    context.skip("zsh is not installed");
    return;
  }
  assert.ok(zshComplete([""]).includes("report"));
  assert.deepEqual(zshComplete(["alerts", ""]), ["check"]);
  assert.deepEqual(zshComplete(["find", ""]), ["duplicates", "stale", "empty", "broken"]);
  assert.deepEqual(zshComplete(["completion", ""]), ["bash", "zsh", "fish"]);
  assert.deepEqual(zshComplete(["report", "--format", ""]), ["json", "csv", "html"]);
  assert.deepEqual(zshComplete(["report", "--output", ""]), ["<files>"]);
  assert.deepEqual(zshComplete(["scan", ""]), ["<files>"]);
  assert.deepEqual(zshComplete(["--units", "si", "find", ""]), ["duplicates", "stale", "empty", "broken"]);
  assert.deepEqual(zshComplete(["devices", "--units=s"]), ["iec", "si"]);
  assert.ok(zshComplete(["report", "-"]).includes("--findings"));
  assert.deepEqual(zshComplete(["find", "stale", ""]), []);

  const script = completionScript("zsh");
  assert.ok(script.includes("'report:Export a JSON, CSV, or HTML report'"), "commands carry their summaries");
});

test("completion writes the script to stdout and refuses an unknown shell", async () => {
  for (const shell of SHELLS) {
    const context = fakeContext();
    assert.equal(await runCli(["completion", shell], context), 0);
    assert.equal(context.captured.stdout, completionScript(shell));
    assert.equal(context.captured.stderr, "");
  }

  const unknown = fakeContext();
  assert.equal(await runCli(["completion", "tcsh"], unknown), 2);
  assert.equal(unknown.captured.stdout, "");
  assert.match(unknown.captured.stderr, /bash, zsh, fish; 'tcsh' is not one of them/);

  const hostile = fakeContext();
  assert.equal(await runCli(["completion", "\u001b[2Jzsh"], hostile), 2);
  assert.doesNotMatch(hostile.captured.stderr, /\u001b/);

  const missing = fakeContext();
  assert.equal(await runCli(["completion"], missing), 2);
  assert.match(missing.captured.stderr, /needs a SHELL/);
});
