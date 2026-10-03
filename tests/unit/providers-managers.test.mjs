import assert from "node:assert/strict";
import { test } from "node:test";
import { createManagerProvider } from "../../dist/providers/managers/index.js";
import { createManagerInventory } from "../../dist/platform/linux/managers/index.js";

const ID = "c".repeat(64);

function proposal(overrides = {}) {
  return {
    action: "docker.remove-stopped-containers",
    title: "Stopped Docker containers",
    evidence: ["1 container(s) have exited."],
    items: [{ id: ID }],
    count: { kind: "exact", value: 1n },
    bytesBasis: "unknown",
    preview: "listed",
    offered: true,
    parameters: {},
    ...overrides,
  };
}

function inventory(discoveries) {
  return {
    async discover() {
      return discoveries;
    },
    async preview() {
      throw new Error("not used");
    },
  };
}

const environment = {};
const SIGNAL = new AbortController().signal;

test("an offered proposal becomes a finding that offers a manager action and shows its command", async () => {
  const provider = createManagerProvider(
    inventory([{ adapter: "docker", capability: { status: "available", explanation: "ok" }, proposals: [proposal()], warnings: [] }]),
  );
  const result = await provider.discover(environment, SIGNAL);
  const [finding] = result.findings;
  assert.equal(finding.id, "managers:docker.remove-stopped-containers");
  assert.equal(finding.managerAction, "docker.remove-stopped-containers");
  assert.equal(finding.category, "container-data");
  assert.deepEqual(finding.availableActionIds, ["manager"]);
  assert.deepEqual(finding.paths, []);
  assert.equal(finding.managerScope, `docker container rm -- ${ID}`);
  assert.equal(finding.size.basis, "unknown");
  assert.equal(result.complete, true);
});

test("a reported proposal offers nothing and keeps its own id", async () => {
  const provider = createManagerProvider(
    inventory([
      {
        adapter: "docker",
        capability: { status: "available", explanation: "ok" },
        proposals: [proposal({ slug: "docker.named-volumes", action: "docker.remove-anonymous-volumes", items: [], offered: false, title: "Named volumes" })],
        warnings: [],
      },
    ]),
  );
  const [finding] = (await provider.discover(environment, SIGNAL)).findings;
  assert.equal(finding.id, "managers:docker.named-volumes");
  assert.deepEqual(finding.availableActionIds, []);
});

test("a root action says it needs administrator rights, and a size has the basis it came with", async () => {
  const provider = createManagerProvider(
    inventory([
      {
        adapter: "apt",
        capability: { status: "available", explanation: "ok" },
        proposals: [proposal({ action: "apt.clean", title: "apt cache", items: [{ id: "a_1_all.deb", bytes: 10n }], estimatedBytes: 10n, bytesBasis: "stat" })],
        warnings: [],
      },
    ]),
  );
  const [finding] = (await provider.discover(environment, SIGNAL)).findings;
  assert.equal(finding.category, "package-cache");
  assert.equal(finding.size.bytes, 10n);
  assert.equal(finding.size.basis, "stat");
  assert.ok(finding.evidence.some((line) => /administrator rights/.test(line)));
  assert.equal(finding.managerScope, "sudo apt-get clean");
});

test("a denied manager makes the result incomplete; a missing one does not", async () => {
  const provider = createManagerProvider(
    inventory([
      { adapter: "docker", capability: { status: "permission-denied", explanation: "Join the docker group." }, proposals: [], warnings: [] },
      { adapter: "snap", capability: { status: "missing-tool", explanation: "snap is not installed." }, proposals: [], warnings: [] },
    ]),
  );
  const result = await provider.discover(environment, SIGNAL);
  assert.equal(result.complete, false);
  assert.ok(result.warnings.some((warning) => warning.code === "manager-denied" && /docker group/.test(warning.message)));
  const missingOnly = createManagerProvider(
    inventory([{ adapter: "snap", capability: { status: "missing-tool", explanation: "snap is not installed." }, proposals: [], warnings: [] }]),
  );
  assert.equal((await missingOnly.discover(environment, SIGNAL)).complete, true);
});

test("the inventory asks each adapter once per process and survives one that throws", async () => {
  let asked = 0;
  const steady = { id: "snap", async discover() { asked += 1; return { adapter: "snap", capability: { status: "available", explanation: "ok" }, proposals: [], warnings: [] }; } };
  const broken = { id: "docker", async discover() { throw new Error("boom"); } };
  const managers = createManagerInventory([steady, broken]);
  const first = await managers.discover();
  await managers.discover();
  assert.equal(asked, 1);
  assert.equal(first.find((discovery) => discovery.adapter === "docker").capability.status, "missing-tool");
});
