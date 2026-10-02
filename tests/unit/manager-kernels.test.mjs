import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { managerScope } from "../../dist/domain/managers.js";
import { createKernelAdapter } from "../../dist/platform/linux/managers/kernels.js";

const fixture = (name) => readFileSync(new URL(`../fixtures/managers/${name}`, import.meta.url), "utf8");
const DPKG = "dpkg-query -W -f=${Package}\t${Status}\t${Installed-Size}\n";
const RPM = "rpm -qa --qf %{NAME}\t%{VERSION}-%{RELEASE}.%{ARCH}\t%{SIZE}\n";

function tools(answers) {
  const calls = [];
  return {
    calls,
    port: {
      async run(name, commandArguments) {
        const key = [name, ...commandArguments].join(" ");
        calls.push(key);
        const answer = typeof answers === "function" ? answers(key) : answers[key];
        if (answer === undefined) {
          return { capability: { status: "missing-tool", explanation: `${key} unanswered` }, stdout: "", stderr: "", exitCode: null };
        }
        if (typeof answer === "object") return answer;
        return { capability: { status: "available", explanation: "ran" }, stdout: answer, stderr: "", exitCode: 0 };
      },
    },
  };
}

function debian({ running = "6.8.0-45-generic", simulation = fixture("apt-get-s-purge.txt") } = {}) {
  const harness = tools((key) => (key === DPKG ? fixture("dpkg-packages.txt") : key.startsWith("apt-get -s purge") ? simulation : undefined));
  return {
    ...harness,
    adapter: createKernelAdapter({ tools: harness.port, runningRelease: () => running, installed: async (tool) => ["dpkg-query", "dpkg", "apt-get"].includes(tool) }),
  };
}

const OLD = ["linux-headers-6.8.0-40", "linux-headers-6.8.0-40-generic", "linux-image-6.8.0-40-generic", "linux-modules-6.8.0-40-generic"];

test("the running kernel and the newest are kept; every package of the others is proposed", async () => {
  const { adapter } = debian();
  const [proposal] = (await adapter.discover()).proposals;
  assert.equal(proposal.action, "kernels.dpkg-purge");
  assert.deepEqual(proposal.items.map((item) => item.id), OLD);
  assert.deepEqual(proposal.count, { kind: "exact", value: 4n });
  assert.equal(proposal.preview, "simulated");
  assert.equal(proposal.offered, true);
  assert.equal(proposal.items.find((item) => item.id === "linux-image-6.8.0-40-generic").bytes, 14660n * 1024n);
});

test("a kernel the system is running is kept even when it is the oldest", async () => {
  const { adapter } = debian({ running: "6.8.0-40-generic", simulation: "Purg linux-image-6.8.0-45-generic [6.8.0-45.45]\nPurg linux-modules-6.8.0-45-generic [6.8.0-45.45]\nPurg linux-headers-6.8.0-45-generic [6.8.0-45.45]\nPurg linux-headers-6.8.0-45 [6.8.0-45.45]\n" });
  const [proposal] = (await adapter.discover()).proposals;
  const ids = proposal.items.map((item) => item.id);
  assert.ok(ids.every((id) => id.includes("6.8.0-45")), JSON.stringify(ids));
  assert.equal(ids.some((id) => id.includes("6.8.0-40") || id.includes("6.8.0-47")), false);
});

test("a purge that would take anything else with it is not offered, and says what", async () => {
  const { adapter } = debian({ simulation: `${fixture("apt-get-s-purge.txt")}Remv linux-image-generic [6.8.0-47.47]\n` });
  const [proposal] = (await adapter.discover()).proposals;
  assert.equal(proposal.offered, false);
  assert.ok(proposal.evidence.some((line) => /linux-image-generic/.test(line)));
});

test("a removed package that only left its configuration behind is not proposed", async () => {
  const { adapter } = debian();
  const [proposal] = (await adapter.discover()).proposals;
  assert.equal(proposal.items.some((item) => item.id.includes("6.8.0-31")), false);
});

test("one kernel installed is nothing to propose", async () => {
  const harness = tools({ [DPKG]: "linux-image-6.8.0-45-generic\tinstall ok installed\t14660\n" });
  const adapter = createKernelAdapter({ tools: harness.port, runningRelease: () => "6.8.0-45-generic", installed: async (tool) => ["dpkg-query", "dpkg", "apt-get"].includes(tool) });
  assert.deepEqual((await adapter.discover()).proposals, []);
});

function purge(ids = OLD) {
  return managerScope({ action: "kernels.dpkg-purge", items: ids.map((id) => ({ id })), parameters: {}, count: { kind: "exact", value: BigInt(ids.length) }, preview: "simulated" });
}

test("preflight refuses the whole action when the running kernel has become one of the reviewed", async () => {
  const { adapter } = debian({ running: "6.8.0-40-generic" });
  const preflight = await adapter.preflight(purge());
  assert.match(preflight.refusal, /running/);
});

test("preflight refuses when what purging would remove has changed since review", async () => {
  const { adapter } = debian({ simulation: `${fixture("apt-get-s-purge.txt")}Remv linux-image-generic [6.8.0-47.47]\n` });
  const preflight = await adapter.preflight(purge());
  assert.match(preflight.refusal, /changed/);
});

test("Fedora keeps the running and the newest kernel and proposes rpm names for the rest", async () => {
  const harness = tools((key) => (key === RPM ? fixture("rpm-packages.txt") : key.startsWith("rpm -e --test") ? "" : undefined));
  const adapter = createKernelAdapter({ tools: harness.port, runningRelease: () => "6.10.9-200.fc40.x86_64", installed: async (tool) => tool === "rpm" });
  const [proposal] = (await adapter.discover()).proposals;
  assert.equal(proposal.action, "kernels.rpm-erase");
  assert.deepEqual(proposal.items.map((item) => item.id), [
    "kernel-6.10.6-200.fc40.x86_64",
    "kernel-core-6.10.6-200.fc40.x86_64",
    "kernel-modules-6.10.6-200.fc40.x86_64",
    "kernel-modules-core-6.10.6-200.fc40.x86_64",
  ]);
  assert.equal(proposal.offered, true);
});

test("an rpm erase that would break a dependency is not offered", async () => {
  const harness = tools((key) =>
    key === RPM
      ? fixture("rpm-packages.txt")
      : key.startsWith("rpm -e --test")
        ? { capability: { status: "missing-tool", explanation: "failed" }, stdout: "", stderr: "error: Failed dependencies:\n\tkernel-modules-core is needed by foo\n", exitCode: 1 }
        : undefined,
  );
  const adapter = createKernelAdapter({ tools: harness.port, runningRelease: () => "6.10.12-200.fc40.x86_64", installed: async (tool) => tool === "rpm" });
  const [proposal] = (await adapter.discover()).proposals;
  assert.equal(proposal.offered, false);
});

test("on a pacman system there is nothing to propose, and the reason is said", async () => {
  const adapter = createKernelAdapter({ tools: tools({}).port, runningRelease: () => "6.18.54-1-lts", installed: async (tool) => tool === "pacman" });
  const discovery = await adapter.discover();
  assert.equal(discovery.capability.status, "missing-tool");
  assert.match(discovery.capability.explanation, /pacman keeps one version/);
});

test("a package that is no longer installed after the purge is verified gone", async () => {
  const after = fixture("dpkg-packages.txt").split("\n").filter((line) => !line.includes("6.8.0-40")).join("\n");
  const harness = tools({ [DPKG]: after });
  const adapter = createKernelAdapter({ tools: harness.port, runningRelease: () => "6.8.0-45-generic", installed: async () => true });
  const verification = await adapter.verify(purge(), new Set([0, 1, 2, 3]), []);
  assert.ok([...verification.verdicts.values()].every((verdict) => verdict.outcome === "completed"));
});
