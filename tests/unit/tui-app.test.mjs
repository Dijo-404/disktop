import assert from "node:assert/strict";
import { test } from "node:test";
import { runTui } from "../../dist/tui/app.js";
import { ASCII_THEME } from "../../dist/tui/themes.js";
import { fakeServices } from "../support/tui-fixtures.mjs";

const EVENTS = ["exit", "SIGINT", "SIGTERM", "SIGHUP", "uncaughtException", "unhandledRejection"];
const counts = () => EVENTS.map((event) => process.listenerCount(event));

function recordingRenderer(failStart = false) {
  const calls = { stops: 0, draws: 0, afterStop: 0 };
  return {
    calls,
    size: () => ({ columns: 80, rows: 24 }),
    async start() { if (failStart) throw new Error("Terminal input unavailable."); },
    draw() { calls.draws += 1; if (calls.stops > 0) calls.afterStop += 1; },
    onKey(handler) { setImmediate(() => handler("q")); },
    onMouse() {}, onResize() {}, suspend() {}, resume() {},
    stop() { calls.stops += 1; },
  };
}

test("repeated TUI sessions release process listeners and scheduled paints", async () => {
  const before = counts();
  const renderers = [];
  for (let index = 0; index < 25; index += 1) {
    const renderer = recordingRenderer();
    renderers.push(renderer);
    const code = await runTui({ services: fakeServices(), units: "iec", theme: ASCII_THEME, createRenderer: async () => renderer });
    assert.equal(code, 0);
    assert.deepEqual(counts(), before);
    assert.equal(renderer.calls.stops, 1);
  }
  await new Promise((resolve) => setTimeout(resolve, 160));
  for (const renderer of renderers) {
    assert.equal(renderer.calls.afterStop, 0);
    assert.equal(renderer.calls.draws, 1, "queued paints were cleared on exit");
  }
});

test("a renderer startup failure restores the terminal and releases every process listener", async () => {
  const before = counts();
  const renderer = recordingRenderer(true);
  await assert.rejects(runTui({ services: fakeServices(), units: "iec", theme: ASCII_THEME, createRenderer: async () => renderer }), /Terminal input unavailable/);
  assert.equal(renderer.calls.stops, 1);
  assert.deepEqual(counts(), before);
});
