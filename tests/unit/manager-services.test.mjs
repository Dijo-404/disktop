import assert from "node:assert/strict";
import { test } from "node:test";
import { managerScope } from "../../dist/domain/managers.js";
import { createFlatpakAdapter } from "../../dist/platform/linux/managers/flatpak.js";
import { createJournaldAdapter } from "../../dist/platform/linux/managers/journald.js";
import { createSnapAdapter } from "../../dist/platform/linux/managers/snap.js";

function tools(answers) {
  const calls = [];
  return {
    calls,
    port: {
      async run(name, commandArguments) {
        const key = [name, ...commandArguments].join(" ");
        calls.push(key);
        const answer = typeof answers === "function" ? answers(key, calls.length) : answers[key];
        if (answer === undefined) {
          return { capability: { status: "missing-tool", explanation: `${name} is not installed` }, stdout: "", stderr: "", exitCode: null };
        }
        return { capability: { status: "available", explanation: "ran" }, stdout: answer, stderr: "", exitCode: 0 };
      },
    },
  };
}

const paths = (sizes = {}) => ({
  async facts(path) {
    const bytes = sizes[path.display];
    return bytes === undefined
      ? undefined
      : { kind: "file", apparentBytes: bytes, allocatedBytes: bytes, ownerId: 0n, modifiedNanoseconds: 1n, device: 1n, inode: 1n, mountId: "1" };
  },
  async list() {
    return [];
  },
  async readText() {
    return undefined;
  },
});

const USAGE = (size) => `Archived and active journals take up ${size} in the file system.\n`;

test("a journal larger than what is kept is offered a vacuum with an estimate", async () => {
  const journald = createJournaldAdapter({ tools: tools({ "journalctl --disk-usage": USAGE("4.0G") }).port, keepBytes: 536_870_912n });
  const [proposal] = (await journald.discover()).proposals;
  assert.equal(proposal.action, "journald.vacuum");
  assert.deepEqual(proposal.parameters, { keepBytes: "536870912" });
  assert.equal(proposal.estimatedBytes, 4_294_967_296n - 536_870_912n);
  assert.deepEqual(proposal.count, { kind: "unknown" });
  assert.equal(proposal.bytesBasis, "manager-reported");
  assert.equal(proposal.offered, true);
});

test("a journal already below what is kept is not offered", async () => {
  const journald = createJournaldAdapter({ tools: tools({ "journalctl --disk-usage": USAGE("199.9M") }).port, keepBytes: 536_870_912n });
  const [proposal] = (await journald.discover()).proposals;
  assert.equal(proposal.offered, false);
  assert.equal(proposal.estimatedBytes, 0n);
});

test("a vacuum is verified by the journal's own size afterwards", async () => {
  const answers = ["4.0G", "600.0M"];
  const journald = createJournaldAdapter({
    tools: tools((key, call) => (key === "journalctl --disk-usage" ? USAGE(answers[Math.min(call, 2) - 1]) : undefined)).port,
    keepBytes: 536_870_912n,
  });
  const scope = managerScope({ action: "journald.vacuum", items: [], parameters: { keepBytes: "536870912" }, count: { kind: "unknown" }, preview: "none" });
  await journald.preflight(scope);
  const verification = await journald.verify(scope, new Set(), [{ status: "ran", exitCode: 0, output: "", explanation: "" }]);
  const check = verification.checks.find((entry) => entry.check === "manager-verified");
  assert.equal(check.outcome, "passed");
  assert.match(check.detail, /smaller/);
});

test("journalctl that is absent is a missing manager", async () => {
  const journald = createJournaldAdapter({ tools: tools({}).port, keepBytes: 536_870_912n });
  assert.equal((await journald.discover()).capability.status, "missing-tool");
});

const SNAPS = `Name    Version    Rev    Tracking       Publisher   Notes
core20  20240416   2318   latest/stable  canonical✓  base,disabled
core20  20240705   2379   latest/stable  canonical✓  base
firefox 129.0      4757   latest/stable  mozilla✓    disabled
firefox 130.0      4793   latest/stable  mozilla✓    -
Bad_Name 1.0       12     latest/stable  someone     disabled
`;

test("only disabled snap revisions are proposed, one item per revision", async () => {
  const snap = createSnapAdapter({
    tools: tools({ "snap list --all": SNAPS }).port,
    paths: paths({ "/var/lib/snapd/snaps/core20_2318.snap": 65_536_000n, "/var/lib/snapd/snaps/firefox_4757.snap": 250_000_000n }),
  });
  const discovery = await snap.discover();
  const [proposal] = discovery.proposals;
  assert.deepEqual(proposal.items, [
    { id: "core20=2318", bytes: 65_536_000n },
    { id: "firefox=4757", bytes: 250_000_000n },
  ]);
  assert.deepEqual(proposal.count, { kind: "exact", value: 2n });
  assert.ok(discovery.warnings.some((warning) => warning.code === "manager-item-skipped"), "a name snap would not have printed is reported");
});

test("a revision that is no longer disabled is skipped at apply time", async () => {
  const later = SNAPS.replace("base,disabled", "base");
  const snap = createSnapAdapter({ tools: tools({ "snap list --all": later }).port, paths: paths() });
  const scope = managerScope({ action: "snap.remove-disabled", items: [{ id: "core20=2318" }, { id: "firefox=4757" }], parameters: {}, count: { kind: "exact", value: 2n }, preview: "listed" });
  const preflight = await snap.preflight(scope);
  assert.deepEqual([...preflight.skipped.keys()], [0]);
});

test("a removed revision is verified gone, and one still listed is a failure", async () => {
  const after = SNAPS.split("\n").filter((line) => !line.includes("2318")).join("\n");
  const snap = createSnapAdapter({ tools: tools({ "snap list --all": after }).port, paths: paths() });
  const scope = managerScope({ action: "snap.remove-disabled", items: [{ id: "core20=2318" }, { id: "firefox=4757" }], parameters: {}, count: { kind: "exact", value: 2n }, preview: "listed" });
  const verification = await snap.verify(scope, new Set([0, 1]), []);
  assert.equal(verification.verdicts.get(0).outcome, "completed");
  assert.equal(verification.verdicts.get(1).outcome, "failed");
});

test("Flatpak decides what is unused, and what it removed is reported as observed", async () => {
  const lists = ["runtime/org.gnome.Platform/x86_64/45\nruntime/org.gnome.Platform/x86_64/46\napp/org.example.App/x86_64/stable\n", "runtime/org.gnome.Platform/x86_64/46\napp/org.example.App/x86_64/stable\n"];
  let listed = 0;
  const flatpak = createFlatpakAdapter({
    tools: tools((key) => (key === "flatpak list --user --columns=ref" ? lists[Math.min(listed++, 1)] : key === "flatpak list --system --columns=ref" ? "" : undefined)).port,
    home: "/home/example",
  });
  const discovery = await flatpak.discover();
  const user = discovery.proposals.find((proposal) => proposal.action === "flatpak.remove-unused-user");
  assert.deepEqual(user.count, { kind: "unknown" });
  assert.equal(user.preview, "none");
  const scope = managerScope({ action: "flatpak.remove-unused-user", items: [], parameters: {}, count: { kind: "unknown" }, preview: "none" });
  listed = 0;
  await flatpak.preflight(scope);
  const verification = await flatpak.verify(scope, new Set(), [{ status: "ran", exitCode: 0, output: "", explanation: "" }]);
  assert.deepEqual(verification.observed, [{ id: "runtime/org.gnome.Platform/x86_64/45" }]);
  assert.equal(await flatpak.spacePath(scope), "/home/example/.local/share/flatpak");
});

test("Flatpak that is absent is a missing manager", async () => {
  const flatpak = createFlatpakAdapter({ tools: tools({}).port, home: "/home/example" });
  assert.equal((await flatpak.discover()).capability.status, "missing-tool");
});
