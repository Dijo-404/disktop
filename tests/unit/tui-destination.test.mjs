import assert from "node:assert/strict";
import { test } from "node:test";
import { TuiController } from "../../dist/tui/controller.js";
import { lineText } from "../../dist/tui/frame.js";
import { renderScreen } from "../../dist/tui/screen.js";
import { initialState } from "../../dist/tui/state.js";
import { ASCII_THEME } from "../../dist/tui/themes.js";
import { FIXTURE_VIEW, rawPath } from "../support/cli-context.mjs";
import { CHILDREN, HOME, NOW, PLAN, fakeHooks, fakeServices, finding } from "../support/tui-fixtures.mjs";

/** Planning a move or a compression from the TUI, which needs a destination first. */

/** Services whose planner answers as the real one would about reversibility. */
function planning(overrides = {}) {
  const requests = [];
  const services = fakeServices({
    ...overrides,
    plan: async (request) => {
      requests.push(request);
      const reversible = request.sourceDisposition === undefined ? request.operation === "trash" : request.sourceDisposition === "trash";
      return {
        kind: "planned",
        plan: {
          ...PLAN,
          id: `plan-20261003100000-${String(requests.length).padStart(8, "0")}`,
          operation: request.operation,
          reversibility: reversible ? "undo-from-trash" : "irreversible",
          ...(request.destination === undefined ? {} : { destination: request.destination }),
          ...(request.sourceDisposition === undefined ? {} : { sourceDisposition: request.sourceDisposition }),
        },
      };
    },
  });
  return { services, requests };
}

async function setup(overrides = {}) {
  const { services, requests } = planning(overrides);
  const controller = new TuiController(services, initialState(FIXTURE_VIEW, "iec"), fakeHooks());
  controller.start();
  await controller.idle();
  return { services, requests, controller };
}

async function press(controller, ...keys) {
  for (const key of keys) {
    controller.handleKey(key);
    await controller.idle();
  }
}

const type = (controller, text) => press(controller, ...Array.from(text));

const screen = (state, size = { columns: 80, rows: 24 }) =>
  renderScreen(state, size, { theme: ASCII_THEME, now: NOW, threshold: 90, home: HOME }).lines.map(lineText);

/** Explore, the first entry selected, its Trash review open, and `o` pressed once. */
async function moveDialog(overrides) {
  const opened = await setup(overrides);
  await press(opened.controller, "2", "c");
  assert.equal(opened.controller.state.dialog?.kind, "review");
  assert.equal(opened.controller.state.dialog.plan.operation, "trash");
  await press(opened.controller, "o");
  return opened;
}

test("o on an Explore entry's Trash review asks where a move should go, before any plan is made", async () => {
  const { controller, requests } = await moveDialog();
  const dialog = controller.state.dialog;
  assert.equal(dialog?.kind, "destination");
  assert.equal(dialog.operation, "move");
  assert.equal(dialog.disposition, "trash", "the source goes to Trash unless somebody says otherwise");
  assert.equal(requests.length, 1, "only the Trash review was planned");
  assert.ok(screen(controller.state).some((line) => /Move to another disk/.test(line)));
});

test("typing a destination, Tab, and Enter plans a move to exactly that path with the source removed permanently", async () => {
  const { controller, requests } = await moveDialog();
  await type(controller, "/mnt/backup");
  await press(controller, "TAB", "ENTER");
  const request = requests.at(-1);
  assert.equal(request.operation, "move");
  assert.equal(request.path.display, CHILDREN[0].path.display);
  assert.deepEqual(request.destination, rawPath("/mnt/backup"));
  assert.equal(request.sourceDisposition, "permanent");
  assert.equal(controller.state.dialog?.kind, "review");
  assert.equal(controller.state.dialog.plan.reversibility, "irreversible", "the review comes from the plan, which says it cannot be undone");
  assert.ok(screen(controller.state).some((line) => /Destination\s+\/mnt\/backup/.test(line)), screen(controller.state).join("\n"));
});

test("Tab toggles the disposition back, Backspace and Ctrl+U edit, and Esc plans nothing", async () => {
  const { controller, requests } = await moveDialog();
  await type(controller, "/mnt/x");
  await press(controller, "TAB", "TAB", "BACKSPACE");
  assert.equal(controller.state.dialog.text, "/mnt/");
  assert.equal(controller.state.dialog.disposition, "trash");
  await press(controller, "CTRL_U");
  assert.equal(controller.state.dialog.text, "");
  await type(controller, "/srv");
  await press(controller, "ESCAPE");
  assert.equal(controller.state.dialog, undefined);
  assert.equal(requests.length, 1, "nothing beyond the first Trash review was planned");
});

test("a move with no destination is refused on the dialog, and a relative path is refused rather than guessed at", async () => {
  const { controller, requests } = await moveDialog();
  await press(controller, "ENTER");
  assert.equal(controller.state.dialog?.kind, "destination", "the dialog stays open to be filled in");
  assert.match(controller.state.dialog.error ?? "", /directory/i);
  await type(controller, "backups");
  await press(controller, "ENTER");
  assert.equal(controller.state.dialog?.kind, "destination");
  assert.match(controller.state.dialog.error ?? "", /absolute|~\//);
  assert.ok(screen(controller.state).some((line) => line.includes(controller.state.dialog.error.slice(0, 20))), "the reason is on screen");
  assert.equal(requests.length, 1);
});

test("~/ means the home directory", async () => {
  const { controller, requests } = await moveDialog();
  await type(controller, "~/archive");
  await press(controller, "ENTER");
  assert.deepEqual(requests.at(-1).destination, rawPath(`${HOME}/archive`));
  assert.equal(requests.at(-1).sourceDisposition, "trash");
});

test("o on a reversible move review asks again for a compression, with the same destination and disposition", async () => {
  const { controller, requests } = await moveDialog();
  await type(controller, "/mnt/backup");
  await press(controller, "ENTER");
  assert.equal(controller.state.dialog.plan.operation, "move");
  await press(controller, "o");
  const dialog = controller.state.dialog;
  assert.equal(dialog?.kind, "destination");
  assert.equal(dialog.operation, "compress");
  assert.equal(dialog.text, "/mnt/backup");
  assert.equal(dialog.disposition, "trash");
  assert.equal(requests.length, 2, "the compression is not planned until it is confirmed");
});

test("a compression with no destination is planned beside its source", async () => {
  const { controller, requests } = await moveDialog();
  await type(controller, "/mnt/backup");
  await press(controller, "ENTER", "o");
  await press(controller, "CTRL_U", "ENTER");
  const request = requests.at(-1);
  assert.equal(request.operation, "compress");
  assert.equal(request.destination, undefined, "the planner puts it beside the source");
  assert.equal(request.sourceDisposition, "trash");
});

test("the last destination is offered again for the next move", async () => {
  const { controller } = await moveDialog();
  await type(controller, "/mnt/backup");
  await press(controller, "ENTER", "ESCAPE", "c", "o");
  assert.equal(controller.state.dialog?.kind, "destination");
  assert.equal(controller.state.dialog.text, "/mnt/backup");
});

test("a finding whose only operation is a move asks for a destination instead of sending you to the CLI", async () => {
  const movable = finding("storage.images:vm", "language-cache", "Disk images", 40_000_000_000n, { availableActionIds: ["move"] });
  const { controller, requests } = await setup({ summary: { findings: [movable], providers: [], warnings: [], complete: true, categoryTotals: [], measured: true, capability: { status: "available", explanation: "ok" } } });
  await press(controller, "3", "c");
  assert.equal(controller.state.dialog?.kind, "destination", controller.state.notice?.text);
  await type(controller, "/mnt/cold");
  await press(controller, "ENTER");
  assert.equal(requests.at(-1).findingId, "storage.images:vm");
  assert.deepEqual(requests.at(-1).destination, rawPath("/mnt/cold"));
});

test("the destination dialog fits 80x24 and 40x10 exactly, and a long path keeps its end in view", () => {
  const long = `/mnt/${"very-long-directory-name/".repeat(8)}end`;
  const state = {
    ...initialState(FIXTURE_VIEW, "iec"),
    tab: "Explore",
    dialog: { kind: "destination", operation: "move", text: long, disposition: "permanent", alternatives: ["trash", "move", "compress", "permanent"], origin: "path", path: CHILDREN[0].path },
  };
  for (const size of [
    { columns: 80, rows: 24 },
    { columns: 40, rows: 10 },
  ]) {
    const rendered = renderScreen(state, size, { theme: ASCII_THEME, now: NOW, threshold: 90, home: HOME });
    assert.equal(rendered.lines.length, size.rows);
    const lines = rendered.lines.map(lineText);
    assert.ok(lines.every((line) => line.length <= size.columns), lines.join("\n"));
    assert.ok(lines.some((line) => line.includes("name/end")), `the end of the path is shown at ${size.columns}x${size.rows}:\n${lines.join("\n")}`);
  }
  const lines = screen(state);
  assert.ok(lines.some((line) => /permanent/i.test(line)), lines.join("\n"));
});
