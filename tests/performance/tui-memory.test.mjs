import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("repeated frames over a full bounded TUI listing do not retain render allocations", { timeout: 40_000 }, (context) => {
  const moduleUrl = (relative) => JSON.stringify(new URL(relative, import.meta.url).href);
  const script = `
    import { renderScreen } from ${moduleUrl("../../dist/tui/screen.js")};
    import { serializeLine } from ${moduleUrl("../../dist/tui/render.js")};
    import { initialState } from ${moduleUrl("../../dist/tui/state.js")};
    import { buildTheme } from ${moduleUrl("../../dist/tui/themes.js")};
    import { FIXTURE_VIEW } from ${moduleUrl("../support/cli-context.mjs")};
    import { entry, ROOT_ENTRY, SNAPSHOT, NOW, HOME, TYPE_TOTALS } from ${moduleUrl("../support/tui-fixtures.mjs")};
    const rows = Array.from({ length: 10000 }, (_, index) => ({ kind: "entry", entry: entry(HOME + "/projects/日本語-🎉-" + index, "file", BigInt(index + 1) * 4096n) }));
    const base = initialState(FIXTURE_VIEW, "iec");
    let state = { ...base, tab: "Explore", explore: { ...base.explore, snapshot: SNAPSHOT, root: ROOT_ENTRY.path, directory: { path: ROOT_ENTRY.path, id: ROOT_ENTRY.id, entry: ROOT_ENTRY }, rows, typeTotals: TYPE_TOTALS } };
    const options = { theme: buildTheme("truecolor", true), now: NOW, threshold: 90, home: HOME };
    const draw = (index) => {
      state = { ...state, tick: index, explore: { ...state.explore, selected: index % rows.length } };
      const frame = renderScreen(state, { columns: 132, rows: 43 }, options);
      if (frame.lines.length !== 43) throw new Error("incomplete frame");
      for (const line of frame.lines) serializeLine(line, 132, options.theme);
    };
    for (let index = 0; index < 200; index += 1) draw(index);
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const started = performance.now();
    for (let index = 0; index < 1000; index += 1) draw(index);
    global.gc();
    process.stdout.write(JSON.stringify({ before, after: process.memoryUsage().heapUsed, millisecondsPerFrame: (performance.now() - started) / 1000 }));
  `;
  const result = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 35_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const reading = JSON.parse(result.stdout);
  const retained = reading.after - reading.before;
  assert.ok(retained < 4 * 1024 * 1024, `1000 frames retained ${retained} bytes`);
  context.diagnostic(`10,000 rows, 1,000 frames: ${Math.max(0, retained)} retained bytes; ${reading.millisecondsPerFrame.toFixed(2)} ms/frame`);
});

test("a blocked refresh retains one pending task across twenty thousand repeated keys", { timeout: 40_000 }, (context) => {
  const moduleUrl = (relative) => JSON.stringify(new URL(relative, import.meta.url).href);
  const script = `
    import { TuiController } from ${moduleUrl("../../dist/tui/controller.js")};
    import { initialState } from ${moduleUrl("../../dist/tui/state.js")};
    import { FIXTURE_VIEW } from ${moduleUrl("../support/cli-context.mjs")};
    import { fakeServices, fakeHooks } from ${moduleUrl("../support/tui-fixtures.mjs")};
    let release;
    let started = 0;
    const blocked = new Promise((resolve) => { release = resolve; });
    const services = fakeServices();
    services.dashboard.inventory = async () => {
      started += 1;
      if (started === 1) await blocked;
      return FIXTURE_VIEW;
    };
    const controller = new TuiController(services, initialState(FIXTURE_VIEW, "iec"), fakeHooks());
    controller.start();
    await new Promise((resolve) => setImmediate(resolve));
    for (let index = 0; index < 200; index += 1) controller.handleKey("r");
    global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let index = 0; index < 20000; index += 1) controller.handleKey("r");
    global.gc();
    const retained = process.memoryUsage().heapUsed - before;
    release();
    await controller.idle();
    process.stdout.write(JSON.stringify({ retained, started, active: controller.active }));
  `;
  const result = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 35_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const reading = JSON.parse(result.stdout);
  assert.ok(reading.retained < 4 * 1024 * 1024, `queued refreshes retained ${reading.retained} bytes`);
  assert.equal(reading.started, 2);
  assert.equal(reading.active, false);
  context.diagnostic(`20,000 queued refresh keys: ${Math.max(0, reading.retained)} retained bytes, two requests executed`);
});
