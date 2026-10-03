import assert from "node:assert/strict";
import { test } from "node:test";
import { managerScope } from "../../dist/domain/managers.js";
import { createContainerAdapter } from "../../dist/platform/linux/managers/containers.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

const IMAGES = "docker image ls --filter dangling=true --no-trunc --format {{.ID}}\t{{.Size}}";
const CONTAINERS = "docker container ls --all --filter status=exited --filter status=created --no-trunc --format {{.ID}}\t{{.State}}";
const VOLUMES = "docker volume ls --filter dangling=true --format {{.Name}}";
const ANONYMOUS = "docker volume ls --filter dangling=true --filter label=com.docker.volume.anonymous --format {{.Name}}";
const DF = "docker system df --format {{json .}}";

function tools(answers) {
  return {
    async run(name, commandArguments) {
      const key = [name, ...commandArguments].join(" ");
      const answer = answers[key];
      if (answer === undefined) {
        return { capability: { status: "missing-tool", explanation: `${key} unanswered` }, stdout: "", stderr: "", exitCode: null };
      }
      if (typeof answer === "object") {
        return answer;
      }
      return { capability: { status: "available", explanation: "ran" }, stdout: answer, stderr: "", exitCode: 0 };
    },
  };
}

const HOST = {
  [IMAGES]: `sha256:${A}\t1.2GB\n${B}\t300MB\n`,
  [CONTAINERS]: `${A}\texited\n${B}\tcreated\n`,
  [VOLUMES]: `${A}\npostgres-data\n${C}\n`,
  [ANONYMOUS]: `${A}\n`,
  [DF]: '{"Active":"18","Reclaimable":"2.912GB (29%)","Size":"9.745GB","TotalCount":"30","Type":"Images"}\n{"Active":"0","Reclaimable":"9.456GB","Size":"11.87GB","TotalCount":"182","Type":"Build Cache"}\n',
};

const byAction = (discovery, key) => discovery.proposals.find((proposal) => (proposal.slug ?? proposal.action) === key);

test("dangling images are proposed by full id with the size Docker reports", async () => {
  const discovery = await createContainerAdapter("docker", { tools: tools(HOST) }).discover();
  const images = byAction(discovery, "docker.remove-dangling-images");
  assert.deepEqual(images.items, [
    { id: `sha256:${A}`, bytes: 1_200_000_000n },
    { id: `sha256:${B}`, bytes: 300_000_000n },
  ]);
  assert.equal(images.bytesBasis, "manager-reported");
  assert.equal(images.offered, true);
});

test("only an anonymous volume is offered; a named one is reported and never selectable", async () => {
  const discovery = await createContainerAdapter("docker", { tools: tools(HOST) }).discover();
  const anonymous = byAction(discovery, "docker.remove-anonymous-volumes");
  assert.deepEqual(anonymous.items.map((item) => item.id), [A]);
  assert.equal(anonymous.offered, true);
  const named = byAction(discovery, "docker.named-volumes");
  assert.equal(named.offered, false);
  assert.deepEqual(named.items, []);
  assert.ok(named.evidence.some((line) => /postgres-data/.test(line)));
  assert.ok(named.evidence.some((line) => /only copy/.test(line)));
  for (const proposal of discovery.proposals) {
    for (const item of proposal.items) {
      assert.notEqual(item.id, "postgres-data", "a named volume never reaches a command");
    }
  }
});

test("a volume with no label is not assumed anonymous", async () => {
  const discovery = await createContainerAdapter("docker", { tools: tools(HOST) }).discover();
  const anonymous = byAction(discovery, "docker.remove-anonymous-volumes");
  assert.equal(anonymous.items.some((item) => item.id === C), false);
});

test("the build cache is offered with Docker's own reclaimable figure", async () => {
  const discovery = await createContainerAdapter("docker", { tools: tools(HOST) }).discover();
  const cache = byAction(discovery, "docker.prune-build-cache");
  assert.equal(cache.estimatedBytes, 9_456_000_000n);
  assert.deepEqual(cache.count, { kind: "unknown" });
  assert.equal(cache.offered, true);
});

test("an id that is not one Docker prints is dropped and said so", async () => {
  const discovery = await createContainerAdapter("docker", {
    tools: tools({ ...HOST, [CONTAINERS]: `--all\texited\n${A}\texited\n` }),
  }).discover();
  const containers = byAction(discovery, "docker.remove-stopped-containers");
  assert.deepEqual(containers.items.map((item) => item.id), [A]);
  assert.ok(discovery.warnings.some((warning) => warning.code === "manager-item-skipped"));
});

test("a socket this user may not open is a permission state that names the fix", async () => {
  const denied = { capability: { status: "permission-denied", explanation: "docker could not be run by this user." }, stdout: "", stderr: "permission denied while trying to connect to the Docker daemon socket", exitCode: 1 };
  const discovery = await createContainerAdapter("docker", { tools: tools({ [IMAGES]: denied, [CONTAINERS]: denied, [VOLUMES]: denied, [ANONYMOUS]: denied, [DF]: denied }) }).discover();
  assert.equal(discovery.capability.status, "permission-denied");
  assert.match(discovery.capability.explanation, /docker group|rootless/);
  assert.deepEqual(discovery.proposals, []);
});

test("an engine that is not installed is a missing manager", async () => {
  const discovery = await createContainerAdapter("podman", { tools: tools({}) }).discover();
  assert.equal(discovery.capability.status, "missing-tool");
});

test("podman's anonymous volumes are read from its own flag, and it has no build cache to prune", async () => {
  const podman = createContainerAdapter("podman", {
    tools: tools({
      "podman image ls --filter dangling=true --no-trunc --format {{.ID}}\t{{.Size}}": "",
      "podman container ls --all --filter status=exited --filter status=created --no-trunc --format {{.ID}}\t{{.State}}": "",
      "podman volume ls --filter dangling=true --format {{.Name}}\t{{.Anonymous}}": `${A}\ttrue\nmydata\tfalse\n`,
    }),
  });
  const discovery = await podman.discover();
  assert.deepEqual(byAction(discovery, "podman.remove-anonymous-volumes").items.map((item) => item.id), [A]);
  assert.equal(discovery.proposals.some((proposal) => proposal.action.endsWith("build-cache")), false);
  assert.ok(discovery.warnings.some((warning) => /build/.test(warning.message)));
});

test("a container that is running again is skipped at apply time", async () => {
  const docker = createContainerAdapter("docker", { tools: tools({ ...HOST, [CONTAINERS]: `${B}\tcreated\n` }) });
  const scope = managerScope({ action: "docker.remove-stopped-containers", items: [{ id: A }, { id: B }], parameters: {}, count: { kind: "exact", value: 2n }, preview: "listed" });
  const preflight = await docker.preflight(scope);
  assert.deepEqual([...preflight.skipped.keys()], [0]);
});

test("an image still listed after its removal is a failure", async () => {
  const docker = createContainerAdapter("docker", { tools: tools({ ...HOST, [IMAGES]: `sha256:${B}\t300MB\n` }) });
  const scope = managerScope({ action: "docker.remove-dangling-images", items: [{ id: `sha256:${A}` }, { id: `sha256:${B}` }], parameters: {}, count: { kind: "exact", value: 2n }, preview: "listed" });
  const verification = await docker.verify(scope, new Set([0, 1]), []);
  assert.equal(verification.verdicts.get(0).outcome, "completed");
  assert.equal(verification.verdicts.get(1).outcome, "failed");
});

test("a named volume whose label text imitates the anonymous marker is never offered", async () => {
  const spoof = "d".repeat(64);
  const docker = createContainerAdapter("docker", {
    tools: tools({
      [IMAGES]: "",
      [CONTAINERS]: "",
      "docker volume ls --filter dangling=true --format {{.Name}}": `${A}\n${spoof}\n`,
      "docker volume ls --filter dangling=true --filter label=com.docker.volume.anonymous --format {{.Name}}": `${A}\n`,
      [DF]: "",
    }),
  });
  const discovery = await docker.discover();
  const anonymous = discovery.proposals.find((proposal) => proposal.action === "docker.remove-anonymous-volumes" && proposal.slug === undefined);
  assert.deepEqual(anonymous.items.map((item) => item.id), [A]);
  const named = discovery.proposals.find((proposal) => proposal.slug === "docker.named-volumes");
  assert.equal(named.offered, false);
  assert.ok(named.evidence.some((line) => line.includes(spoof.slice(0, 16))));
});
