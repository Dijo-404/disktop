import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/;
const ENTER_ALTERNATE_SCREEN = /\u001b\[\?1049h/;
const LEAVE_ALTERNATE_SCREEN = /\u001b\[\?1049l/;
/** terminal-kit restores the cursor with the terminal's own sequence, so accept either form. */
const SHOW_CURSOR = /\u001b\[\?(25h|0c)/;
/** What a person would read: every escape sequence removed. */
const visible = (output) => output.replace(/\u001b\[[0-9;?<>]*[A-Za-z]/g, "").replace(/\u001b[()][0-9A-Za-z]/g, "");

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

    // A list of keys is typed with a pause between each, so every key is
    // drawn before the next arrives, the way a person types.
    const sequence = Array.isArray(keys) ? keys : [keys];
    sequence.forEach((key, index) => {
      setTimeout(() => child.stdin.write(key), settleMilliseconds + index * 400);
    });
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
  assert.match(visible(result.stdout), /Disktop/, "the dashboard must be drawn");
  assert.match(visible(result.stdout), /MOUNT/, "with its filesystem table");
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
  const result = await drivePty("node dist/bin/disktop.js", ["j", "?", "q"], { TERM: "xterm-256color" });
  assert.ok([0, 3].includes(result.status), `unexpected exit ${result.status}`);
  assert.match(visible(result.stdout), /Everywhere/, "? must open the help screen");
  assert.match(visible(result.stdout), /quit/);
  assert.match(result.stdout, LEAVE_ALTERNATE_SCREEN);
});

test("NO_COLOR is honoured inside the TUI: attributes, but never a colour", async (context) => {
  if (!haveScript(context)) {
    return;
  }
  const result = await drivePty("node dist/bin/disktop.js", "q", { TERM: "xterm-256color", NO_COLOR: "1" });
  assert.ok([0, 3].includes(result.status), `unexpected exit ${result.status}`);
  assert.match(result.stdout, ENTER_ALTERNATE_SCREEN);
  for (const [, parameters] of result.stdout.matchAll(/\u001b\[([0-9;]*)m/g)) {
    for (const parameter of parameters.split(";").filter((part) => part !== "")) {
      const code = Number(parameter);
      assert.ok(!((code >= 30 && code <= 49) || (code >= 90 && code <= 107)), `colour parameter ${code} written under NO_COLOR`);
    }
  }
});

test("a dumb terminal gets the text dashboard, not a screen it cannot address", (context) => {
  if (!haveScript(context)) {
    return;
  }
  const result = inPty("node dist/bin/disktop.js", { TERM: "dumb" });
  assert.ok([0, 3].includes(result.status), result.stderr);
  assert.doesNotMatch(result.stdout, ENTER_ALTERNATE_SCREEN);
  assert.match(result.stdout, /Mount\s+Type/);
});

test("a non-UTF-8 locale draws ASCII glyphs only", async (context) => {
  if (!haveScript(context)) {
    return;
  }
  const result = await drivePty("node dist/bin/disktop.js", "q", { TERM: "xterm-256color", LANG: "C", LC_ALL: "C", LC_CTYPE: "" });
  assert.ok([0, 3].includes(result.status), `unexpected exit ${result.status}`);
  assert.doesNotMatch(visible(result.stdout), /[█░▒◆▌─│╭]/u, "no block or box-drawing glyph reaches a terminal that cannot decode it");
});

test("every tab draws inside a real terminal and the keyboard reaches each one", async (context) => {
  if (!haveScript(context)) {
    return;
  }
  // History reads the journal, which in this sandbox is empty; the others say
  // what they have or what to do, and none of them may crash on the way.
  const home = mkdtempSync(join(tmpdir(), "disktop-pty-"));
  try {
    const environment = {
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_CACHE_HOME: join(home, "cache"),
    };
    const result = await drivePty("node dist/bin/disktop.js", ["2", "6", "?", "\u001b", "q"], environment);
    assert.ok([0, 3].includes(result.status), `unexpected exit ${result.status}`);
    const screen = visible(result.stdout);
    assert.match(screen, /Nothing has been scanned here yet/, "Explore explains how to get a scan");
    assert.match(screen, /No action has been applied yet/, "History says it is empty rather than showing nothing");
    assert.match(screen, /Everywhere/, "help opened on the History tab");
    assert.match(result.stdout, LEAVE_ALTERNATE_SCREEN);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a mouse click on a tab switches to it, and mouse reporting is switched off on the way out", async (context) => {
  if (!haveScript(context)) {
    return;
  }
  // The tab bar is row 2. Tabs are drawn as " N Name " separated by one
  // space from column 2, so the History tab's first cell is found by adding up
  // the labels before it.
  const labels = ["Disks", "Explore", "Clean", "Dev", "Apps"].map((name, index) => ` ${index + 1} ${name} `.length + 1);
  const historyColumn = 2 + labels.reduce((sum, width) => sum + width, 0) + 2;
  const click = `\u001b[<0;${historyColumn};2M\u001b[<0;${historyColumn};2m`;
  const home = mkdtempSync(join(tmpdir(), "disktop-pty-"));
  try {
    const result = await drivePty("node dist/bin/disktop.js", [click, "q"], {
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      HOME: home,
      XDG_STATE_HOME: join(home, "state"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_CONFIG_HOME: join(home, "config"),
    });
    assert.ok([0, 3].includes(result.status), `unexpected exit ${result.status}`);
    assert.match(visible(result.stdout), /No action has been applied yet/, "the click opened History");
    assert.match(result.stdout, /\u001b\[\?1006h/, "SGR mouse reporting was requested");
    assert.match(result.stdout, /\u001b\[\?1000l/, "and turned off again on exit");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an exception thrown while the TUI runs restores the terminal before the report and exits 2", async () => {
  // A renderer that records what was done to the terminal, and a dashboard
  // whose second reading throws from a timer — outside any promise chain the
  // app awaits — which is the case only the process-level handler can catch.
  const script = `
    import { runTui } from "./dist/tui/app.js";
    import { buildTheme } from "./dist/tui/themes.js";
    const view = { capability: { status: "available", explanation: "" }, devices: [], filesystems: [], alerts: [], warnings: [], complete: true };
    const renderer = {
      size: () => ({ columns: 80, rows: 24 }),
      async start() { process.stdout.write("START\\n"); setTimeout(() => { throw new Error("boom"); }, 50); },
      draw() {}, onKey() {}, onMouse() {}, onResize() {}, suspend() {}, resume() {},
      stop() { process.stdout.write("RESTORED\\n"); },
    };
    const services = {
      dashboard: { inventory: async () => view, dashboard: async () => view },
      defaults: { excludes: [], retention: { keepLatest: 1 }, staleAfterDays: 1 },
      home: { bytesBase64: "Lw==", display: "/" },
      now: () => new Date(),
    };
    await runTui({ services, units: "iec", theme: buildTheme("none", false), createRenderer: async () => renderer });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd() });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(status, 2);
  assert.match(stdout, /START\nRESTORED/, "the terminal is restored");
  assert.match(stderr, /boom/, "and the reason is reported where it can be read");
});

test("Ctrl+C typed at a terminal stops a scan through the helper, which survives to report it", async (context) => {
  if (!haveScript(context)) {
    return;
  }
  // A real Ctrl+C is a SIGINT to the terminal's whole foreground process
  // group. The helper must not be in it: killed outright, it could not finish
  // and report the scan, and in an apply it could not journal the item it was
  // on. A throttled fixture keeps the scan running even in a small container
  // with a release helper; /usr there can finish before the key is typed.
  const home = mkdtempSync(join(tmpdir(), "disktop-pty-"));
  try {
    const root = join(home, "scan");
    mkdirSync(root);
    for (let index = 0; index < 8; index += 1) {
      const directory = join(root, `directory-${index}`);
      mkdirSync(directory);
      writeFileSync(join(directory, "data"), Buffer.alloc(4096));
    }
    const result = await drivePty(
      `node dist/bin/disktop.js scan '${root.replaceAll("'", "'\\''")}' --throttle 1 --json`,
      "\u0003",
      {
        TERM: "xterm-256color",
        HOME: home,
        XDG_CACHE_HOME: join(home, "cache"),
        XDG_DATA_HOME: join(home, "data"),
        XDG_STATE_HOME: join(home, "state"),
        XDG_CONFIG_HOME: join(home, "config"),
      },
      700,
    );
    const output = result.stdout.replace(/\r/g, "");
    const envelope = JSON.parse(output.slice(output.indexOf("{")));
    assert.equal(result.status, 130, `exit ${result.status}: ${JSON.stringify(envelope.error ?? envelope.warnings)}`);
    assert.equal(envelope.command, "scan");
    assert.equal(envelope.status, "incomplete");
    assert.ok(envelope.warnings.some((warning) => warning.code === "cancelled"), "the helper stopped the walk and said so");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
