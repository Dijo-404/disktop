import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

/**
 * Signals that reach the TUI from outside the keyboard: a `kill`, a shutdown,
 * or Ctrl+C typed while the terminal is lent to a sudo password prompt (the
 * tty is in cooked mode then, so Ctrl+C is a real SIGINT).
 *
 * Each case runs the real `runTui` in a child process with a recording
 * renderer and service fakes, because the behaviour under test is what the
 * process does with a signal.
 */
function runScenario(body) {
  const script = `
    const { runTui } = await import(${JSON.stringify(`${process.cwd()}/dist/tui/app.js`)});
    const { ASCII_THEME } = await import(${JSON.stringify(`${process.cwd()}/dist/tui/themes.js`)});
    const F = await import(${JSON.stringify(`${process.cwd()}/tests/support/tui-fixtures.mjs`)});
    const log = (message) => process.stdout.write(message + "\\n");
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    let keys;
    const renderer = {
      size: () => ({ columns: 80, rows: 24 }),
      async start() {}, draw() {}, onKey(handler) { keys = handler; }, onMouse() {}, onResize() {},
      suspend() { log("suspended"); }, resume() { log("resumed"); }, stop() { log("restored"); },
    };
    ${body}
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd() });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const limit = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`no exit: ${stdout} ${stderr}`)); }, 30_000);
    child.on("close", (code, signal) => { clearTimeout(limit); resolve({ code, signal, stdout, stderr }); });
  });
}

test("a signal during an action waits for it to journal its item, however long that takes", async () => {
  const result = await runScenario(`
    const services = F.fakeServices();
    const original = services.apply;
    services.apply = async (request, signal) => {
      log("item started");
      signal.addEventListener("abort", () => log("asked to stop"));
      await wait(4500);
      log("item journalled");
      return original(request, signal);
    };
    setTimeout(async () => {
      // The review is read for longer than the type-ahead guard before y.
      keys("2"); await wait(100); keys("c"); await wait(600); keys("y"); await wait(200);
      process.kill(process.pid, "SIGTERM");
    }, 200);
    await runTui({ services, units: "iec", theme: ASCII_THEME, createRenderer: async () => renderer });
  `);
  assert.match(result.stdout, /item started[\s\S]*restored[\s\S]*asked to stop[\s\S]*item journalled/, result.stdout);
  assert.equal(result.signal, "SIGTERM", "and then the signal takes its course");
});

test("Ctrl+C at a sudo password prompt cancels the action and the TUI carries on", async () => {
  const result = await runScenario(`
    const services = F.fakeServices({
      plan: () => ({ kind: "planned", plan: { ...F.PLAN, operation: "manager", permission: "manager-privilege", reversibility: "irreversible" } }),
    });
    const original = services.apply;
    services.apply = async (request, signal) => {
      log("prompting");
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      log("action cancelled");
      return original(request, signal);
    };
    setTimeout(async () => {
      keys("3"); await wait(100); keys("c"); await wait(600);
      for (const key of ["y", "e", "s", "ENTER"]) keys(key);
      await wait(300);
      process.kill(process.pid, "SIGINT");
      await wait(500);
      log("still running");
      keys("ESCAPE"); await wait(50); keys("q");
    }, 200);
    const code = await runTui({ services, units: "iec", theme: ASCII_THEME, createRenderer: async () => renderer });
    log("exit " + code);
  `);
  assert.match(result.stdout, /suspended[\s\S]*prompting[\s\S]*action cancelled[\s\S]*resumed[\s\S]*still running[\s\S]*exit 0/, result.stdout);
  assert.equal(result.code, 0);
});
