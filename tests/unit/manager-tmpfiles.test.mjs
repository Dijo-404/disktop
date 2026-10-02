import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { managerScope } from "../../dist/domain/managers.js";
import { createTmpfilesAdapter } from "../../dist/platform/linux/managers/tmpfiles.js";

const DRY = readFileSync(new URL("../fixtures/managers/tmpfiles-dry-run.txt", import.meta.url), "utf8");

function tools(answers) {
  return {
    async run(name, commandArguments) {
      const key = [name, ...commandArguments].join(" ");
      const answer = answers[key];
      if (answer === undefined) {
        return { capability: { status: "missing-tool", explanation: `${key} failed: unrecognized option '--dry-run'` }, stdout: "", stderr: "unrecognized option '--dry-run'", exitCode: 1 };
      }
      return { capability: { status: "available", explanation: "ran" }, stdout: "", stderr: answer, exitCode: 0 };
    },
  };
}

const CRASH = "systemd-tmpfiles --clean --dry-run --prefix=/var/crash --prefix=/var/lib/systemd/coredump";
const SYSTEM = "systemd-tmpfiles --clean --dry-run";
const USER = "systemd-tmpfiles --user --clean --dry-run";

const proposals = async (answers, installed = true) =>
  (await createTmpfilesAdapter({ tools: tools(answers), installed: async () => installed }).discover()).proposals;

test("a dry run's 'Would remove' lines are what the preview counts", async () => {
  const crash = (await proposals({ [CRASH]: DRY, [SYSTEM]: DRY, [USER]: "" })).find((proposal) => proposal.action === "tmpfiles.clean-crash");
  assert.deepEqual(crash.count, { kind: "estimated", value: 2n });
  assert.equal(crash.preview, "simulated");
  assert.equal(crash.offered, true);
  assert.ok(crash.evidence.some((line) => /tmpfiles\.d/.test(line)));
});

test("a dry run that could not read everything says its count is a floor", async () => {
  const system = (await proposals({ [CRASH]: DRY, [SYSTEM]: DRY, [USER]: "" })).find((proposal) => proposal.action === "tmpfiles.clean-system");
  assert.ok(system.evidence.some((line) => /could not be read/.test(line)));
});

test("a policy that would remove nothing is not offered", async () => {
  const user = (await proposals({ [CRASH]: "", [SYSTEM]: "", [USER]: "" })).find((proposal) => proposal.action === "tmpfiles.clean-user");
  assert.equal(user.offered, false);
});

test("a systemd without --dry-run still offers the policy, with no preview and no count", async () => {
  const all = await proposals({});
  assert.equal(all.length, 3);
  for (const proposal of all) {
    assert.equal(proposal.preview, "none");
    assert.deepEqual(proposal.count, { kind: "unknown" });
    assert.equal(proposal.offered, true);
  }
});

test("systemd-tmpfiles that is absent is a missing manager", async () => {
  const discovery = await createTmpfilesAdapter({ tools: tools({}), installed: async () => false }).discover();
  assert.equal(discovery.capability.status, "missing-tool");
});

test("after a clean, a dry run that would remove nothing more is a passed check", async () => {
  const adapter = createTmpfilesAdapter({ tools: tools({ [CRASH]: "" }), installed: async () => true });
  const scope = managerScope({ action: "tmpfiles.clean-crash", items: [], parameters: {}, count: { kind: "estimated", value: 2n }, preview: "simulated" });
  const verification = await adapter.verify(scope, new Set(), []);
  assert.equal(verification.checks[0].outcome, "passed");
});
