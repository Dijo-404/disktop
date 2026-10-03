import assert from "node:assert/strict";
import { test } from "node:test";
import { TuiController } from "../../dist/tui/controller.js";
import { lineText, MINIMUM_SIZE } from "../../dist/tui/frame.js";
import { renderScreen } from "../../dist/tui/screen.js";
import { initialState } from "../../dist/tui/state.js";
import { ASCII_THEME } from "../../dist/tui/themes.js";
import { FIXTURE_VIEW } from "../support/cli-context.mjs";
import { HOME, NOW, PLAN, RECORDS, fakeHooks, fakeServices } from "../support/tui-fixtures.mjs";

/** Regressions for an independent review of the TUI controller. */

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function setup(services, hooks = fakeHooks()) {
  const controller = new TuiController(services, initialState(FIXTURE_VIEW, "iec"), hooks);
  controller.start();
  return { controller, hooks };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const applies = (services) => services.calls.filter((call) => call[0] === "apply").map((call) => call[1]);
const screen = (controller, size = MINIMUM_SIZE) =>
  renderScreen(controller.state, size, { theme: ASCII_THEME, now: NOW, threshold: 90, home: HOME }).lines.map(lineText);

test("a review that lands while another dialog is open never replaces it, so its y cannot apply an unread plan", async () => {
  const applyGate = deferred();
  const planGate = deferred();
  let plans = 0;
  const services = fakeServices({
    plan: async (request) => {
      plans += 1;
      if (plans === 2) await planGate.promise;
      return { kind: "planned", plan: { ...PLAN, id: `plan-${plans}`, scopeSummary: request.path.display } };
    },
  });
  const original = services.apply;
  services.apply = async (request, signal) => {
    if (request.planId === "plan-1") await applyGate.promise;
    return original(request, signal);
  };
  const { controller } = setup(services);
  await controller.idle();
  for (const key of ["2"]) controller.handleKey(key);
  await controller.idle();
  controller.handleKey("c");
  await controller.idle();
  controller.handleKey("y");
  await tick();
  controller.handleKey("j");
  controller.handleKey("c");
  await tick();
  applyGate.resolve();
  await tick();
  assert.equal(controller.state.dialog?.kind, "applied");
  planGate.resolve();
  await controller.idle();
  assert.equal(controller.state.dialog?.kind, "applied", "the late review did not replace the result");
  controller.handleKey("y");
  await controller.idle();
  assert.deepEqual(applies(services), ["plan-1"]);
});

test("a plan stopped with Esc never opens its review, even if the answer comes", async () => {
  const gate = deferred();
  const services = fakeServices({
    plan: async () => {
      await gate.promise;
      return { kind: "planned", plan: PLAN };
    },
  });
  const { controller } = setup(services);
  await controller.idle();
  controller.handleKey("3");
  await controller.idle();
  controller.handleKey("c");
  await tick();
  controller.handleKey("ESCAPE");
  gate.resolve();
  await controller.idle();
  assert.equal(controller.state.dialog, undefined);
});

test("a confirmation typed ahead of a dialog that just appeared is not taken as reading it", async () => {
  const services = fakeServices();
  const hooks = { ...fakeHooks(), confirmDelayMilliseconds: 10_000 };
  const { controller } = setup(services, hooks);
  await controller.idle();
  controller.handleKey("3");
  await controller.idle();
  controller.handleKey("c");
  await controller.idle();
  controller.handleKey("y");
  await controller.idle();
  assert.deepEqual(applies(services), [], "y within the guard after the review appeared did nothing");
  assert.equal(controller.state.dialog?.kind, "review");
});

test("an undo is refused while an apply is running, and the other way round", async () => {
  const gate = deferred();
  const services = fakeServices();
  const original = services.apply;
  services.apply = async (request, signal) => {
    await gate.promise;
    return original(request, signal);
  };
  const { controller } = setup(services);
  await controller.idle();
  controller.handleKey("3");
  await controller.idle();
  controller.handleKey("c");
  await controller.idle();
  controller.handleKey("y");
  await tick();
  controller.handleKey("6");
  await tick();
  controller.handleKey("u");
  controller.handleKey("y");
  await tick();
  assert.equal(services.calls.filter((call) => call[0] === "restore").length, 0);
  gate.resolve();
  await controller.idle();
});

test("History reloads by itself when an action finishes while it is open", async () => {
  const gate = deferred();
  const services = fakeServices();
  const original = services.apply;
  services.apply = async (request, signal) => {
    await gate.promise;
    return original(request, signal);
  };
  const { controller } = setup(services);
  await controller.idle();
  controller.handleKey("3");
  await controller.idle();
  controller.handleKey("c");
  await controller.idle();
  controller.handleKey("y");
  await tick();
  controller.handleKey("6");
  await tick();
  const before = services.calls.filter((call) => call[0] === "history").length;
  gate.resolve();
  await controller.idle();
  assert.ok(services.calls.filter((call) => call[0] === "history").length > before);
  assert.equal(controller.state.history.loaded, true);
});

test("a dialog that arrives while the filter prompt is open takes the keyboard from it", async () => {
  const gate = deferred();
  const services = fakeServices({
    plan: async () => {
      await gate.promise;
      return { kind: "planned", plan: PLAN };
    },
  });
  const { controller } = setup(services);
  await controller.idle();
  controller.handleKey("2");
  await controller.idle();
  controller.handleKey("c");
  await tick();
  controller.handleKey("/");
  gate.resolve();
  await controller.idle();
  assert.equal(controller.state.prompt, undefined);
  assert.equal(controller.state.dialog?.kind, "review");
});

test("c and Enter do nothing while the detectors list hides the findings", async () => {
  const services = fakeServices();
  const { controller } = setup(services);
  await controller.idle();
  controller.handleKey("3");
  await controller.idle();
  controller.handleKey("p");
  controller.handleKey("c");
  controller.handleKey("ENTER");
  await controller.idle();
  assert.equal(services.calls.filter((call) => call[0] === "plan").length, 0);
  assert.equal(controller.state.dialog, undefined);
});

test("Enter pressed twice before a directory loads records the parent once", async () => {
  const services = fakeServices();
  const { controller } = setup(services);
  await controller.idle();
  controller.handleKey("2");
  await controller.idle();
  controller.handleKey("ENTER");
  controller.handleKey("ENTER");
  await controller.idle();
  assert.equal(controller.state.explore.trail.length, 1);
});

test("moving in the duplicates finder never restarts the search", async () => {
  const services = fakeServices({
    explorePage: (request) => {
      if (request.filter.atPath !== undefined) {
        return { kind: "page", page: { entries: [{ ...FIXTURE_ROOT, path: request.filter.atPath }] } };
      }
      return { kind: "page", page: { entries: [FIXTURE_ROOT], nextCursor: "more" } };
    },
  });
  // The search takes a while; somebody moves while it runs.
  const gate = deferred();
  const find = services.find.find;
  services.find.find = async (request, signal) => {
    if (request.kind === "duplicates") {
      services.calls.push(["find", "duplicates"]);
      await gate.promise;
      return { kind: "duplicates", result: { kind: "found", groups: [], reclaimableBytes: 0n, complete: true, warnings: [], candidatesRead: 0n, filesHashed: 0n } };
    }
    return find(request, signal);
  };
  const { controller } = setup(services);
  await controller.idle();
  for (const key of ["2", "f"]) {
    controller.handleKey(key);
    await controller.idle();
  }
  assert.ok(controller.state.explore.nextCursor !== undefined, "the largest-files page left a cursor");
  controller.handleKey("f");
  await tick();
  assert.equal(controller.state.explore.mode, "duplicates");
  const searches = () => services.calls.filter((call) => call[0] === "find" && call[1] === "duplicates").length;
  const started = searches();
  for (const key of ["j", "j", "PAGE_DOWN", "n"]) {
    controller.handleKey(key);
    await tick();
  }
  assert.equal(searches(), started, "the search was not restarted");
  gate.resolve();
  await controller.idle();
});

const FIXTURE_ROOT = {
  id: "41",
  path: { bytesBase64: Buffer.from("/home/example/projects").toString("base64"), display: "/home/example/projects", utf8: "/home/example/projects" },
  kind: "directory",
  device: 1n,
  inode: 1n,
  mountId: "1",
  linkCount: 1n,
  apparentBytes: 10n,
  allocatedBytes: 10n,
  ownerId: 1000n,
  modifiedNanoseconds: 1n,
  shared: false,
  childEntries: 1n,
};

test("a scan that fails takes its progress panel with it", async () => {
  const services = fakeServices();
  services.scan.run = async () => {
    throw new Error("The scan ended without a result.");
  };
  const { controller } = setup(services);
  await controller.idle();
  controller.handleKey("2");
  await controller.idle();
  controller.handleKey("S");
  controller.handleKey("y");
  await controller.idle();
  assert.equal(controller.state.explore.scan, undefined);
  assert.match(controller.state.notice.text, /without a result/);
});

test("a stopped scan finishing late does not take over a newer scan's screen", async () => {
  const services = fakeServices();
  const first = deferred();
  const second = deferred();
  let scans = 0;
  services.scan.run = async (roots, _overrides, signal, onProgress) => {
    scans += 1;
    const gate = scans === 1 ? first : second;
    onProgress?.({ scannedEntries: BigInt(scans * 100), processedBytes: 1n, inaccessibleDirectories: 0n });
    await gate.promise;
    return {
      kind: "scanned",
      summary: {
        scanId: `scan-${scans}`,
        accounting: "allocated",
        roots,
        completeness: { complete: false, scannedEntries: 1n, inaccessibleDirectories: 0n, excludedMounts: [], warnings: [{ code: "cancelled", message: "cancelled" }] },
        totals: { allocatedBytes: 1n, apparentBytes: 1n, sharedBytes: 0n },
        filesystems: [],
        crossFilesystems: false,
      },
    };
  };
  const { controller } = setup(services);
  await controller.idle();
  controller.handleKey("2");
  await controller.idle();
  controller.handleKey("S");
  controller.handleKey("y");
  await tick();
  controller.handleKey("ESCAPE");
  controller.handleKey("S");
  controller.handleKey("y");
  await tick();
  first.resolve();
  await tick();
  await tick();
  assert.equal(controller.state.explore.scan?.entries, 200n, "the newer scan's progress is still on screen");
  second.resolve();
  await controller.idle();
  assert.equal(services.calls.filter((call) => call[0] === "record").length, 2, "both scans' snapshots were kept");
});

test("the undo confirmation counts the items a shortened history page left out", () => {
  const record = { ...RECORDS[0], completed: 5000n, itemsOmitted: 4999n };
  const state = { ...initialState(FIXTURE_VIEW, "iec"), tab: "History", dialog: { kind: "undo-confirm", record } };
  const lines = renderScreen(state, MINIMUM_SIZE, { theme: ASCII_THEME, now: NOW, threshold: 90, home: HOME }).lines.map(lineText);
  assert.ok(lines.some((line) => line.includes("5,000")), lines.join("\n"));
});

test("an irreversible review does not offer an o its typed field would swallow", () => {
  const state = {
    ...initialState(FIXTURE_VIEW, "iec"),
    tab: "Clean",
    dialog: { kind: "review", plan: { ...PLAN, operation: "permanent", reversibility: "irreversible" }, alternatives: ["trash", "permanent"], typed: "", origin: "finding", findingId: "x" },
  };
  const lines = renderScreen(state, MINIMUM_SIZE, { theme: ASCII_THEME, now: NOW, threshold: 90, home: HOME }).lines.map(lineText);
  assert.ok(!lines.some((line) => /\bo other operation/.test(line)), lines.join("\n"));
});

test("a filter the parser refuses says why on the prompt row itself", async () => {
  const services = fakeServices();
  const { controller } = setup(services);
  await controller.idle();
  controller.handleKey("2");
  await controller.idle();
  for (const key of ["/", "t", "y", "p", "e", ":", "x", "ENTER"]) controller.handleKey(key);
  await controller.idle();
  assert.ok(controller.state.prompt !== undefined, "the prompt stays open to be corrected");
  assert.ok(screen(controller).some((line) => line.includes("not a kind")), screen(controller).join("\n"));
});
