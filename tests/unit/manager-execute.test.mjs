import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlan } from "../../dist/domain/actions.js";
import { managerScope } from "../../dist/domain/managers.js";
import { createManagerExecutor } from "../../dist/platform/linux/managers/execute.js";

const NOW = new Date("2026-10-02T09:00:00.000Z");
const IDS = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];

function containersPlan(count = 2) {
  return buildPlan({
    operation: "manager",
    providerId: "managers",
    findingId: "managers:docker.remove-stopped-containers",
    scopeSummary: `${count} stopped containers`,
    createdAt: NOW,
    expiryMinutes: 60,
    entries: [],
    manager: managerScope({
      action: "docker.remove-stopped-containers",
      items: IDS.slice(0, count).map((id) => ({ id, bytes: 10n })),
      parameters: {},
      count: { kind: "exact", value: BigInt(count) },
      estimatedBytes: BigInt(10 * count),
      preview: "listed",
    }),
    warnings: [],
  });
}

function harness({ preflight = { skipped: new Map() }, runs = [], gone = IDS, observed = [], onRun } = {}) {
  const calls = [];
  let actionId = 0;
  const client = {
    async request(operation, operationArguments) {
      calls.push({ operation, arguments: operationArguments });
      if (operation === "manager-begin") {
        actionId += 1;
        return { event: "complete", result: { actionId: `act-${actionId}` } };
      }
      if (operation === "manager-append") {
        return { event: "complete", result: { recorded: true } };
      }
      const completed = operationArguments.items.filter((item) => item.outcome === "completed").length + operationArguments.observed.length;
      const skipped = operationArguments.items.filter((item) => item.outcome === "skipped").length;
      const failed = operationArguments.items.filter((item) => item.outcome === "failed").length;
      return {
        event: "complete",
        result: {
          journalId: "act-1",
          state: skipped + failed === 0 ? "complete" : "partial",
          completed: String(completed),
          skipped: String(skipped),
          failed: String(failed),
          selectedBytes: "20",
          bytesMovedToTrash: "0",
          undoAvailable: false,
        },
      };
    },
    diagnostics: () => "",
    async close() {
      calls.push({ operation: "close" });
    },
  };
  const ran = [];
  const runner = {
    async run(command, privilege, options) {
      calls.push({ operation: "run", command });
      ran.push({ command, privilege, options });
      onRun?.();
      return runs[ran.length - 1] ?? { status: "ran", exitCode: 0, output: "", explanation: "docker finished." };
    },
  };
  const adapter = {
    id: "docker",
    async discover() {
      throw new Error("not used");
    },
    async preview() {
      throw new Error("not used");
    },
    async preflight() {
      return preflight;
    },
    async verify(scope, attempted) {
      const verdicts = new Map();
      for (const position of attempted) {
        verdicts.set(position, gone.includes(scope.items[position].id) ? { outcome: "completed" } : { outcome: "failed", message: "still listed" });
      }
      return { verdicts, observed, checks: [{ check: "manager-verified", outcome: "passed", detail: "listed again" }] };
    },
    async spacePath() {
      return "/var/lib/docker";
    },
  };
  const executor = createManagerExecutor({
    adapters: [adapter],
    runner,
    journalDirectory: "/home/example/.local/state/disktop",
    start: async () => ({ started: true, client }),
    statfs: async () => 1000n,
  });
  return { calls, ran, executor };
}

const SIGNAL = new AbortController().signal;
const operations = (calls) => calls.map((call) => (call.operation === "manager-append" ? `append:${call.arguments.phase}` : call.operation));

test("a manager action is journalled before it runs, around each command, and closed after", async () => {
  const { calls, executor } = harness();
  const plan = containersPlan();
  const result = await executor.apply(plan, SIGNAL, { interactive: false });
  assert.deepEqual(operations(calls), [
    "manager-begin",
    "append:started",
    "run",
    "append:finished",
    "append:started",
    "run",
    "append:finished",
    "manager-finish",
    "close",
  ]);
  assert.equal(result.state, "complete");
  assert.equal(result.planId, plan.id);
  const begin = calls[0].arguments;
  assert.deepEqual(begin.commands[0], { tool: "docker", arguments: ["container", "rm", "--", IDS[0]] });
  assert.equal(begin.privilege, "user");
  assert.equal(begin.freeBytesBefore, "1000");
  assert.ok(result.verification.some((check) => check.check === "manager-command" && check.outcome === "passed"));
});

test("a preflight refusal runs nothing and journals nothing", async () => {
  const { calls, executor } = harness({ preflight: { refusal: "The running kernel is in the set.", skipped: new Map() } });
  await assert.rejects(executor.apply(containersPlan(), SIGNAL), (error) => error.failure?.code === "changed-target");
  assert.deepEqual(calls, []);
});

test("an item the preflight dropped is not run and is finished skipped with its reason", async () => {
  const { calls, ran, executor } = harness({ preflight: { skipped: new Map([[0, "It is running again."]]) } });
  const result = await executor.apply(containersPlan(), SIGNAL);
  assert.equal(ran.length, 1);
  assert.deepEqual(ran[0].command.arguments.at(-1), IDS[1]);
  const finish = calls.find((call) => call.operation === "manager-finish").arguments;
  assert.deepEqual(finish.items[0], { position: "0", outcome: "skipped", message: "It is running again." });
  assert.equal(result.state, "partial");
});

test("a refused password stops the action, and what was never run is skipped", async () => {
  const { ran, calls, executor } = harness({
    runs: [{ status: "denied", exitCode: 1, output: "", explanation: "sudo: a password is required" }],
  });
  const result = await executor.apply(containersPlan(), SIGNAL);
  assert.equal(ran.length, 1, "nothing after the refusal was attempted");
  const finish = calls.find((call) => call.operation === "manager-finish").arguments;
  assert.ok(finish.items.every((item) => item.outcome === "skipped"));
  assert.match(finish.items[1].message, /Administrator rights were refused/);
  assert.equal(result.state, "partial");
  assert.ok(result.verification.some((check) => check.check === "manager-command" && check.outcome === "failed"));
});

test("Ctrl+C between two commands leaves the rest unrun", async () => {
  const controller = new AbortController();
  const { ran, calls, executor } = harness({ onRun: () => controller.abort() });
  const result = await executor.apply(containersPlan(3), controller.signal);
  assert.equal(ran.length, 1);
  const finish = calls.find((call) => call.operation === "manager-finish").arguments;
  assert.equal(finish.items.filter((item) => item.outcome === "skipped").length, 2);
  assert.match(finish.items[2].message, /Stopped before this command/);
  assert.equal(result.state, "partial");
});

test("an item the manager left in place is finished failed with what the adapter saw", async () => {
  const { calls, executor } = harness({ gone: [IDS[0]] });
  const result = await executor.apply(containersPlan(), SIGNAL);
  const finish = calls.find((call) => call.operation === "manager-finish").arguments;
  assert.deepEqual(finish.items[1], { position: "1", outcome: "failed", message: "still listed" });
  assert.equal(result.state, "partial");
});

test("the runner is told whether somebody can answer a password prompt", async () => {
  const { ran, executor } = harness();
  await executor.apply(containersPlan(1), SIGNAL, { interactive: true });
  assert.equal(ran[0].options.interactive, true);
});

test("a manager this machine has no adapter for is a missing capability", async () => {
  const { executor } = harness();
  const plan = buildPlan({
    operation: "manager",
    providerId: "managers",
    scopeSummary: "apt cache",
    createdAt: NOW,
    expiryMinutes: 60,
    entries: [],
    manager: managerScope({ action: "apt.clean", items: [], parameters: {}, count: { kind: "unknown" }, preview: "none" }),
    warnings: [],
  });
  await assert.rejects(executor.apply(plan, SIGNAL), (error) => error.capability?.status === "missing-tool");
});
