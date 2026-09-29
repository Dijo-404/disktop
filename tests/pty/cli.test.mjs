import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/;
const ENTER_ALTERNATE_SCREEN = /\u001b\[\?1049h/;
const LEAVE_ALTERNATE_SCREEN = /\u001b\[\?1049l/;
/** terminal-kit restores the cursor with the terminal's own sequence, so accept either form. */
const SHOW_CURSOR = /\u001b\[\?(25h|0c)/;

function haveScript(context) {
  const availability = spawnSync("script", ["--version"], { encoding: "utf8" });
  if (availability.error?.code === "ENOENT") {
    context.skip("util-linux script is not installed");
    return false;
  }
  assert.equal(availability.status, 0);
  return true;
}

function ptyCommand(command) {
  return ["-q", "-e", "-c", `stty rows 24 cols 80; ${command}`, "/dev/null"];
}

/** Run a command in a real 80x24 pseudo-terminal with no keys sent to it. */
function inPty(command, environment = {}) {
  return spawnSync("script", ptyCommand(command), {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ...environment },
  });
}

/**
 * Drive a pseudo-terminal, sending keys only once the program has had time to
 * take the keyboard. Sending them sooner would be handled by the line
 * discipline instead, which tests the kernel rather than Disktop.
 */
function drivePty(command, keys, environment = {}, settleMilliseconds = 1_500) {
  return new Promise((resolve, reject) => {
    const child = spawn("script", ptyCommand(command), { env: { ...process.env, ...environment } });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", () => {});
    child.on("error", reject);

    const giveUp = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the program never exited; captured ${stdout.length} bytes`));
    }, 30_000);

    setTimeout(() => child.stdin.write(keys), settleMilliseconds);
    child.on("close", (status, signal) => {
      clearTimeout(giveUp);
      resolve({ status, signal, stdout });
    });
  });
}

test("help renders and exits cleanly in an 80 by 24 PTY", (context) => {
  if (!haveScript(context)) {
    return;
  }
  const result = inPty("node dist/bin/disktop.js --help", { NO_COLOR: "1", TERM: "dumb" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Disktop: Linux terminal storage manager/);
  assert.doesNotMatch(result.stdout, ANSI);
});

test("--json on a terminal still writes only the envelope, with no escape sequences", (context) => {
  if (!haveScript(context)) {
    return;
  }
  const result = inPty("node dist/bin/disktop.js --json", { NO_COLOR: "1", TERM: "xterm-256color" });
  assert.ok([0, 3].includes(result.status), `unexpected exit ${result.status}: ${result.stderr}`);
  const envelope = JSON.parse(result.stdout.replace(/\r/g, ""));
  assert.equal(envelope.command, "dashboard");
  assert.doesNotMatch(result.stdout, ANSI);
});

test("a piped stdin gets the text dashboard, not a terminal it cannot be driven from", (context) => {
  if (!haveScript(context)) {
    return;
  }
  const result = inPty("printf 'q' | node dist/bin/disktop.js", { TERM: "xterm-256color" });
  assert.ok([0, 3].includes(result.status), result.stderr);
  assert.doesNotMatch(result.stdout, ENTER_ALTERNATE_SCREEN);
  assert.match(result.stdout, /Mount\s+Type/);
});

test("the TUI opens on a terminal, quits on q, and hands the terminal back", async (context) => {
  if (!haveScript(context)) {
    return;
  }
  const result = await drivePty("node dist/bin/disktop.js", "q", { TERM: "xterm-256color" });
  assert.ok([0, 3].includes(result.status), `unexpected exit ${result.status}`);
  assert.match(result.stdout, ENTER_ALTERNATE_SCREEN, "the TUI must use the alternate screen");
  assert.match(result.stdout, /Disktop {2}\//, "the dashboard must be drawn");
  assert.match(result.stdout, LEAVE_ALTERNATE_SCREEN, "the alternate screen must be left on the way out");
  assert.match(result.stdout, SHOW_CURSOR, "the cursor must be shown again");
});

test("Ctrl+C after the TUI has the keyboard restores the terminal and reports 130", async (context) => {
  if (!haveScript(context)) {
    return;
  }
  const result = await drivePty("node dist/bin/disktop.js", "\u0003", { TERM: "xterm-256color" });
  assert.equal(result.status, 130, `Ctrl+C must report 130, got ${result.status}`);
  assert.match(result.stdout, ENTER_ALTERNATE_SCREEN);
  assert.match(result.stdout, LEAVE_ALTERNATE_SCREEN, "an interrupted run still leaves the alternate screen");
  assert.match(result.stdout, SHOW_CURSOR, "an interrupted run still shows the cursor again");
});

test("vim keys move the selection inside a real terminal", async (context) => {
  if (!haveScript(context)) {
    return;
  }
  const result = await drivePty("node dist/bin/disktop.js", "j?q", { TERM: "xterm-256color" });
  assert.ok([0, 3].includes(result.status), `unexpected exit ${result.status}`);
  assert.match(result.stdout, /q or Ctrl\+C/, "? must open the help screen");
  assert.match(result.stdout, LEAVE_ALTERNATE_SCREEN);
});

test("NO_COLOR is honoured inside the TUI", async (context) => {
  if (!haveScript(context)) {
    return;
  }
  const result = await drivePty("node dist/bin/disktop.js", "q", { TERM: "xterm-256color", NO_COLOR: "1" });
  assert.ok([0, 3].includes(result.status), `unexpected exit ${result.status}`);
  assert.match(result.stdout, ENTER_ALTERNATE_SCREEN);
  // Screen control is still needed; colour and style changes are not.
  const styling = result.stdout.match(/\u001b\[[0-9;]*m/g) ?? [];
  assert.deepEqual(new Set(styling), new Set(["\u001b[0m"]), `only a reset may be written, saw ${JSON.stringify(styling)}`);
});
