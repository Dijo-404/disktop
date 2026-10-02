/**
 * Manager actions end to end against the real helper journal. The command
 * runner is a fake: nothing here asks a real manager to change anything.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildPlan } from "../../dist/domain/actions.js";
import { managerScope } from "../../dist/domain/managers.js";
import { NativeHelperClient } from "../../dist/native/client.js";
import { createNativeActions } from "../../dist/platform/linux/actions/index.js";
import { createManagerExecutor } from "../../dist/platform/linux/managers/execute.js";
import { compileBundle } from "../support/schemas.mjs";

const validators = compileBundle("schemas/cli/v1");
const homes = [];
after(async () => {
  for (const home of homes) {
    await rm(home, { recursive: true, force: true });
  }
});

async function home() {
  const path = await mkdtemp(join(tmpdir(), "disktop-managers-"));
  homes.push(path);
  return path;
}

function disktop(root, args) {
  return spawnSync(process.execPath, ["dist/bin/disktop.js", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
    },
  });
}

test("a manager action applied through the executor leaves a complete record in the real journal", async () => {
  const root = await home();
  const ids = ["a".repeat(64), "b".repeat(64)];
  const plan = buildPlan({
    operation: "manager",
    providerId: "managers",
    findingId: "managers:docker.remove-stopped-containers",
    scopeSummary: "2 stopped containers",
    createdAt: new Date(),
    expiryMinutes: 60,
    entries: [],
    manager: managerScope({ action: "docker.remove-stopped-containers", items: ids.map((id) => ({ id })), parameters: {}, count: { kind: "exact", value: 2n }, preview: "listed" }),
    warnings: [],
  });
  const ran = [];
  const executor = createManagerExecutor({
    adapters: [
      {
        id: "docker",
        discover: async () => { throw new Error("unused"); },
        preview: async () => { throw new Error("unused"); },
        preflight: async () => ({ skipped: new Map() }),
        verify: async (_scope, attempted) => ({
          verdicts: new Map([...attempted].map((position) => [position, { outcome: "completed" }])),
          observed: [],
          checks: [{ check: "manager-verified", outcome: "passed", detail: "listed again" }],
        }),
        spacePath: async () => root,
      },
    ],
    runner: {
      async run(command) {
        ran.push(command);
        return { status: "ran", exitCode: 0, output: "removed", explanation: "docker finished." };
      },
    },
    journalDirectory: join(root, "state"),
    start: () => NativeHelperClient.start(),
  });

  const result = await executor.apply(plan, new AbortController().signal);
  assert.equal(result.state, "complete");
  assert.equal(ran.length, 2);
  assert.ok(result.freeBytesBefore !== undefined && result.freeBytesAfter !== undefined);

  const journal = createNativeActions({ journalDirectory: join(root, "state"), homeTrashDirectory: join(root, "trash"), start: () => NativeHelperClient.start() });
  const record = await journal.get(result.journalId);
  assert.equal(record.operation, "manager");
  assert.equal(record.state, "complete");
  assert.deepEqual(record.manager.commands.map((command) => command.state), ["finished", "finished"]);
  assert.deepEqual(record.items.map((item) => item.path.display), ids);

  const history = disktop(root, ["history", "--json"]);
  const envelope = JSON.parse(history.stdout);
  assert.ok(validators.get("history")(envelope), JSON.stringify(validators.get("history").errors));
});

test("disktop clean lists manager findings on this host, and every one validates", async () => {
  const root = await home();
  const run = disktop(root, ["clean", "--no-sizes", "--json"]);
  const envelope = JSON.parse(run.stdout);
  assert.ok(validators.get("clean")(envelope), JSON.stringify(validators.get("clean").errors));
  assert.ok(envelope.data.providers.some((provider) => provider.providerId === "managers"));
  for (const finding of envelope.data.findings.filter((entry) => entry.providerId === "managers")) {
    assert.deepEqual(finding.paths, []);
    assert.ok(finding.managerAction);
  }
});

test("planning a manager finding on this host shows the exact commands and runs none of them", async (t) => {
  const root = await home();
  const listing = JSON.parse(disktop(root, ["clean", "--no-sizes", "--json"]).stdout);
  const offered = listing.data.findings.find((entry) => entry.providerId === "managers" && entry.availableActionIds.includes("manager"));
  if (offered === undefined) {
    t.skip("no manager on this host has anything to offer");
    return;
  }
  const planned = disktop(root, ["clean", "plan", offered.id, "--json"]);
  const envelope = JSON.parse(planned.stdout);
  assert.ok(validators.get("plan")(envelope), JSON.stringify(validators.get("plan").errors));
  const plan = envelope.data.plan;
  assert.equal(plan.operation, "manager");
  assert.equal(plan.reversibility, "irreversible");
  assert.ok(plan.manager.commands.length >= 1);
  const history = JSON.parse(disktop(root, ["history", "--json"]).stdout);
  assert.deepEqual(history.data.records, [], "planning journalled nothing because nothing ran");
});
