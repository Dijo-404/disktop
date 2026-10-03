import assert from "node:assert/strict";
import { test } from "node:test";
import { TuiController } from "../../dist/tui/controller.js";
import { renderScreen } from "../../dist/tui/screen.js";
import { initialState } from "../../dist/tui/state.js";
import { ASCII_THEME } from "../../dist/tui/themes.js";
import { FIXTURE_VIEW } from "../support/cli-context.mjs";
import { CHILDREN, HOME, NOW, PLAN, RECORDS, ROOT_ENTRY, fakeHooks, fakeServices } from "../support/tui-fixtures.mjs";

async function setup(overrides = {}) {
  const services = fakeServices(overrides);
  const hooks = fakeHooks();
  const controller = new TuiController(services, initialState(FIXTURE_VIEW, "iec"), hooks);
  controller.start();
  await controller.idle();
  return { services, hooks, controller };
}

async function press(controller, ...keys) {
  for (const key of keys) {
    controller.handleKey(key);
    await controller.idle();
  }
}

function calls(services, name) {
  return services.calls.filter((call) => call[0] === name);
}

test("vim keys and arrows move the selection, and it never passes either end", async () => {
  const { controller } = await setup();
  await press(controller, "j", "j", "j", "DOWN", "j");
  assert.equal(controller.state.disks.selected, FIXTURE_VIEW.filesystems.length - 1);
  await press(controller, "k", "UP", "k", "k");
  assert.equal(controller.state.disks.selected, 0);
  await press(controller, "G");
  assert.equal(controller.state.disks.selected, FIXTURE_VIEW.filesystems.length - 1);
  await press(controller, "g");
  assert.equal(controller.state.disks.selected, 0);
});

test("tabs switch by number, by Tab, and by h and l outside Explore", async () => {
  const { controller } = await setup();
  await press(controller, "6");
  assert.equal(controller.state.tab, "History");
  await press(controller, "TAB");
  assert.equal(controller.state.tab, "Disks");
  await press(controller, "l");
  assert.equal(controller.state.tab, "Explore");
  await press(controller, "SHIFT_TAB");
  assert.equal(controller.state.tab, "Disks");
});

test("Explore opens the newest scan by asking the index for exactly the root, then its children", async () => {
  const { controller, services } = await setup();
  await press(controller, "2");
  const pages = calls(services, "page").map((call) => call[1]);
  assert.equal(pages[0].atPath.display, ROOT_ENTRY.path.display, "the directory is looked up by its exact path");
  assert.ok(pages.some((filter) => filter.parentId === ROOT_ENTRY.id), "and listed by its children, a page at a time");
  assert.equal(controller.state.explore.rows.length, CHILDREN.length);
  assert.equal(controller.state.explore.directory.id, ROOT_ENTRY.id);
});

test("opening a directory and going back up restores where the cursor was", async () => {
  const { controller, services } = await setup();
  await press(controller, "2", "j", "ENTER");
  const opened = calls(services, "page").map((call) => call[1]).filter((filter) => filter.atPath !== undefined);
  assert.equal(opened.at(-1).atPath.display, CHILDREN[1].path.display);
  assert.equal(controller.state.explore.trail.length, 1);
  await press(controller, "h");
  assert.equal(controller.state.explore.trail.length, 0);
  assert.equal(controller.state.explore.selected, 1, "the cursor is back on the directory that was opened");
});

test("an index that answers with a different row than the path asked for is not taken as that directory", async () => {
  const { controller } = await setup({
    explorePage: (request) =>
      request.filter.atPath !== undefined ? { kind: "page", page: { entries: [CHILDREN[0]] } } : { kind: "page", page: { entries: [] } },
  });
  await press(controller, "2");
  assert.equal(controller.state.explore.rows.length, 0);
  assert.match(controller.state.explore.empty, /not in this scan/);
});

test("sort, finders, and the filter all become index queries the CLI could also make", async () => {
  const { controller, services } = await setup();
  await press(controller, "2", "s");
  assert.equal(controller.state.explore.sort, "apparent");
  await press(controller, "f");
  assert.equal(controller.state.explore.mode, "largest");
  const largest = calls(services, "page").at(-1)[1];
  assert.deepEqual(largest.kinds, ["file"]);
  assert.ok(largest.underPath !== undefined);
  await press(controller, "f");
  assert.equal(controller.state.explore.mode, "duplicates");
  assert.ok(calls(services, "find").some((call) => call[1] === "duplicates"));
  await press(controller, "ESCAPE");
  assert.equal(controller.state.explore.mode, "browse", "Esc returns from a finder to browsing");
  await press(controller, "/", "l", "o", "g", " ", ">", "1", "M", "i", "B", "ENTER");
  assert.equal(controller.state.explore.mode, "search");
  const search = calls(services, "page").at(-1)[1];
  assert.equal(search.nameContains, "log");
  assert.equal(search.minAllocatedBytes, 1024n * 1024n);
});

test("a filter that means nothing is refused on the prompt row and searches nothing", async () => {
  const { controller, services } = await setup();
  await press(controller, "2");
  const before = calls(services, "page").length;
  await press(controller, "/", "t", "y", "p", "e", ":", "x", "ENTER");
  assert.match(controller.state.prompt.error, /not a kind/);
  assert.equal(calls(services, "page").length, before);
  await press(controller, "ESCAPE");
  assert.equal(controller.state.prompt, undefined);
});

test("no single key, in any tab, applies or restores anything", async () => {
  const keys = ["j", "k", "h", "l", "g", "G", "ENTER", "BACKSPACE", "DELETE", "d", "D", "x", "X", "c", "u", "s", "S", "f", "t", "r", "p", "n", "o", "U", "ESCAPE", "SPACE", "TAB", "1", "2", "3", "4", "5", "6"];
  for (const tab of ["1", "2", "3", "4", "5", "6"]) {
    for (const key of keys) {
      const { controller, services } = await setup();
      await press(controller, tab, key);
      assert.equal(calls(services, "apply").length, 0, `${key} in tab ${tab} applied something`);
      assert.equal(calls(services, "restore").length, 0, `${key} in tab ${tab} restored something`);
    }
  }
});

test("c reviews a plan and only y applies it; Enter does not", async () => {
  const { controller, services } = await setup();
  await press(controller, "3", "c");
  assert.equal(controller.state.dialog.kind, "review");
  assert.deepEqual(calls(services, "plan")[0], ["plan", "trash", "dev.artifacts:node-modules"]);
  await press(controller, "ENTER", "n");
  assert.equal(calls(services, "apply").length, 0);
  assert.equal(controller.state.dialog, undefined, "n closes the review without applying");
  await press(controller, "c", "y");
  assert.equal(calls(services, "apply").length, 1);
  const [, planId, acknowledged] = calls(services, "apply")[0];
  assert.equal(planId, PLAN.id);
  assert.equal(acknowledged, false, "a Trash plan is never acknowledged as permanent");
  assert.equal(controller.state.dialog.kind, "applied");
});

test("an irreversible plan needs yes typed out; y alone and other words do nothing", async () => {
  const { controller, services } = await setup();
  await press(controller, "3", "c", "o");
  assert.equal(controller.state.dialog.plan.operation, "permanent");
  await press(controller, "y", "ENTER");
  assert.equal(calls(services, "apply").length, 0);
  await press(controller, "BACKSPACE", "y", "e", "p", "ENTER");
  assert.equal(calls(services, "apply").length, 0);
  await press(controller, "CTRL_U", "y", "e", "s", "ENTER");
  assert.equal(calls(services, "apply").length, 1);
  assert.equal(calls(services, "apply")[0][2], true, "the irreversible plan is acknowledged as such");
});

test("Esc during an apply asks it to stop after the current item, and q cannot leave mid-apply", async () => {
  const { controller, services, hooks } = await setup({ applyWaits: true });
  await press(controller, "3", "c");
  controller.handleKey("y");
  await new Promise((resolve) => setImmediate(resolve));
  controller.handleKey("q");
  assert.equal(hooks.exits.length, 0, "q is refused while an action runs");
  assert.match(controller.state.notice.text, /action is running/);
  controller.handleKey("ESCAPE");
  await controller.idle();
  assert.ok(calls(services, "apply-stopped").length === 1, "the apply saw the stop request");
  assert.equal(controller.state.dialog.kind, "applied", "and still reported what it did");
});

test("Ctrl+C stops everything, leaves with 130, and shutdown waits for a running action to report", async () => {
  const { controller, services, hooks } = await setup({ applyWaits: true });
  await press(controller, "3", "c");
  controller.handleKey("y");
  await new Promise((resolve) => setImmediate(resolve));
  controller.handleKey("CTRL_C");
  assert.deepEqual(hooks.exits, [130]);
  await controller.shutdown(50);
  assert.equal(calls(services, "apply-stopped").length, 1);
  assert.equal(controller.exitCode, 130);
});

test("a privileged manager plan hands the terminal to the password prompt and takes it back", async () => {
  const { controller, hooks } = await setup({
    plan: () => ({ kind: "planned", plan: { ...PLAN, operation: "manager", permission: "manager-privilege", reversibility: "irreversible" } }),
  });
  await press(controller, "3", "c", "y", "e", "s", "ENTER");
  assert.equal(hooks.suspended.length, 1);
  assert.match(hooks.suspended[0], /password/);
  assert.equal(hooks.resumed, 1);
});

test("a refused plan is shown with its reason and nothing is applied", async () => {
  const { controller, services } = await setup({
    plan: () => ({ kind: "refused", failure: { code: "protected-path", message: "/etc is a protected root." } }),
  });
  await press(controller, "3", "c");
  assert.equal(controller.state.dialog.kind, "refused");
  await press(controller, "y");
  assert.equal(calls(services, "apply").length, 0);
});

test("undo needs its own confirmation, and an uncertain record is refused before any dialog", async () => {
  const { controller, services } = await setup();
  await press(controller, "6", "u");
  assert.equal(controller.state.dialog.kind, "undo-confirm");
  await press(controller, "ESCAPE");
  assert.equal(calls(services, "restore").length, 0);
  await press(controller, "u", "y");
  assert.deepEqual(calls(services, "restore")[0], ["restore", RECORDS[0].id]);
  await press(controller, "ESCAPE", "j", "u");
  assert.equal(controller.state.dialog, undefined);
  assert.match(controller.state.notice.text, /interrupted/);
});

test("a scan is confirmed first, records its snapshot, and a stopped scan still keeps what it read", async () => {
  const { controller, services } = await setup({ scanWaits: true });
  await press(controller, "2", "S");
  assert.equal(controller.state.dialog.kind, "confirm-scan");
  controller.handleKey("y");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.state.explore.scan.entries, 1000n, "progress reaches the screen");
  controller.handleKey("ESCAPE");
  await controller.idle();
  assert.equal(calls(services, "scan").length, 1);
  assert.equal(calls(services, "record").length, 1, "the partial scan is recorded, not thrown away");
  assert.match(controller.state.notice.text, /stopped/);
  assert.equal(controller.state.explore.scan, undefined);
});

test("a slow answer to an old question never overwrites the answer to a new one", async () => {
  let release;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  let first = true;
  const { controller } = await setup({
    explorePage: async (request) => {
      if (request.filter.atPath !== undefined) {
        return { kind: "page", page: { entries: [{ ...ROOT_ENTRY, path: request.filter.atPath }] } };
      }
      if (request.filter.parentId !== undefined && first) {
        first = false;
        await slow;
        return { kind: "page", page: { entries: [CHILDREN[0]] } };
      }
      return { kind: "page", page: { entries: CHILDREN } };
    },
  });
  controller.handleKey("2");
  await new Promise((resolve) => setImmediate(resolve));
  controller.handleKey("r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  await controller.idle();
  assert.equal(controller.state.explore.rows.length, CHILDREN.length, "the newer listing stands");
});

test("findings are discovered once on first visit and shared by Clean, Dev, and Apps", async () => {
  const { controller, services } = await setup();
  await press(controller, "3", "4", "5", "3");
  assert.equal(calls(services, "discover").length, 1);
  await press(controller, "r");
  assert.equal(calls(services, "discover").length, 2);
});

test("Esc stops a discovery that is taking too long", async () => {
  const { controller } = await setup({ discoverWaits: true });
  controller.handleKey("3");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(controller.state.busy !== undefined);
  controller.handleKey("ESCAPE");
  await controller.idle();
  assert.equal(controller.state.busy, undefined);
});

test("the mouse selects rows, switches tabs, scrolls, and never reaches behind a dialog", async () => {
  const { controller } = await setup();
  const size = { columns: 80, rows: 24 };
  const frame = () => renderScreen(controller.state, size, { theme: ASCII_THEME, now: NOW, threshold: 90, home: HOME });
  controller.setHits(frame().hits);
  const historyTab = frame().hits.find((hit) => hit.action.kind === "tab" && hit.action.index === 5);
  controller.handleMouse({ kind: "click", column: historyTab.from, row: historyTab.row });
  await controller.idle();
  assert.equal(controller.state.tab, "History");
  controller.setHits(frame().hits);
  controller.handleMouse({ kind: "wheel-down", column: 1, row: 5 });
  assert.equal(controller.state.history.selected, 1);
  controller.handleKey("1");
  await controller.idle();
  controller.setHits(frame().hits);
  const row = frame().hits.find((hit) => hit.action.kind === "row" && hit.action.index === 1);
  controller.handleMouse({ kind: "click", column: 5, row: row.row });
  assert.equal(controller.state.disks.selected, 1);
  await press(controller, "?");
  controller.handleMouse({ kind: "click", column: historyTab.from, row: historyTab.row });
  assert.equal(controller.state.tab, "Disks", "a click behind help does nothing");
});

test("quitting reports an incomplete inventory as 3 and a complete one as 0", async () => {
  const { controller, hooks } = await setup();
  await press(controller, "q");
  assert.deepEqual(hooks.exits, [0]);
  const services = fakeServices({ view: { ...FIXTURE_VIEW, complete: false, warnings: [{ code: "x", message: "y" }] } });
  const partialHooks = fakeHooks();
  const partial = new TuiController(services, initialState({ ...FIXTURE_VIEW, complete: false }, "iec"), partialHooks);
  partial.handleKey("q");
  assert.deepEqual(partialHooks.exits, [3]);
});

test("paging a directory asks for the same directory's children from the cursor, and stops at the memory bound", async () => {
  const { MAX_ROWS } = await import("../../dist/tui/controller.js");
  let served = 0;
  const { controller, services } = await setup({
    explorePage: (request) => {
      if (request.filter.atPath !== undefined) {
        return { kind: "page", page: { entries: [ROOT_ENTRY] } };
      }
      if (request.includeTypeTotals) {
        return { kind: "page", page: { entries: [] } };
      }
      served += 1;
      const entries = Array.from({ length: 200 }, (_, index) => ({ ...CHILDREN[3], id: `${served}-${index}`, path: { ...CHILDREN[3].path, bytesBase64: `${served}-${index}` } }));
      return { kind: "page", page: { entries, nextCursor: `cursor-${served}` } };
    },
  });
  await press(controller, "2", "n");
  const more = calls(services, "page").at(-1)[1];
  assert.equal(more.parentId, ROOT_ENTRY.id, "the next page is the same directory's children");
  assert.equal(more.underPath, undefined);
  assert.equal(controller.state.explore.rows.length, 400);
  while (controller.state.explore.rows.length < MAX_ROWS) {
    await press(controller, "n");
  }
  const pages = served;
  await press(controller, "n");
  assert.equal(served, pages, "nothing more is fetched past the bound");
  assert.match(controller.state.notice.text, /Press \/ to narrow/);
});
