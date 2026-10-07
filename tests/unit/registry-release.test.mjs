/** Release recovery remains read-only and binds bytes, source and signer. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registryMetadata, validateInputs, validateMetadata, validateVerifiedProvenance, verifyProvenanceCertificate } from "../../scripts/verify-registry-release.mjs";

const COMMIT = "3d6448560d19d75b27fce75765819d89f36be09e";
const SHA256 = "a2deddd76c137e349370fb839b887baff14b3ec27c649f1ce809616bf8b39acd";
const REPOSITORY = "https://github.com/Dijo-404/disktop";
const PROVENANCE = "https://slsa.dev/provenance/v1";
const INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
const INVOCATION = `${REPOSITORY}/actions/runs/37661525351/attempts/1`;
const metadata = () => ({ name: "disktop", version: "1.0.0", dist: {
  tarball: "https://registry.npmjs.org/disktop/-/disktop-1.0.0.tgz", integrity: INTEGRITY,
  signatures: [{ keyid: "registry-key", sig: "signature" }],
  attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/disktop@1.0.0", provenance: { predicateType: PROVENANCE } },
} });
const response = () => new Response(JSON.stringify(metadata()));
const statement = () => ({ _type: "https://in-toto.io/Statement/v1", predicateType: PROVENANCE,
  subject: [{ name: "pkg:npm/disktop@1.0.0", digest: { sha512: Buffer.alloc(64, 7).toString("hex") } }],
  predicate: { buildDefinition: {
    buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
    externalParameters: { workflow: { ref: "refs/heads/main", repository: REPOSITORY, path: ".github/workflows/publish.yml" } },
    resolvedDependencies: [{ uri: `git+${REPOSITORY}@refs/heads/main`, digest: { gitCommit: COMMIT } }],
    internalParameters: { github: { event_name: "workflow_dispatch" } },
  }, runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" }, metadata: { invocationId: INVOCATION } } },
});
function audit(document = statement()) {
  return { invalid: [], missing: [], verified: [{ name: "disktop", version: "1.0.0", registry: "https://registry.npmjs.org/",
    attestationBundles: [{ predicateType: PROVENANCE, bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(document)).toString("base64") } } }],
  }] };
}

test("release verification accepts only full exact source and artifact digests", () => {
  validateInputs(COMMIT, SHA256);
  for (const [commit, digest] of [[COMMIT.slice(0, 8), SHA256], [COMMIT.toUpperCase(), SHA256], [`${COMMIT}\n`, SHA256],
    [COMMIT, SHA256.slice(0, 63)], [COMMIT, `${SHA256}\n`], [COMMIT, "$(publish)"]]) {
    assert.throws(() => validateInputs(commit, digest));
  }
});

test("registry metadata requires the fixed package, endpoint, integrity and provenance", () => {
  validateMetadata(metadata());
  for (const mutate of [
    (value) => { value.name = "another-package"; },
    (value) => { value.dist.tarball = "https://another-registry.invalid/package.tgz"; },
    (value) => { value.dist.integrity = "sha1-not-the-approved-artifact"; },
    (value) => { value.dist.integrity += "\n"; },
    (value) => { value.dist.integrity = value.dist.integrity.replace(/.==$/, "x=="); },
    (value) => { value.dist.signatures = []; },
    (value) => { delete value.dist.attestations; },
  ]) {
    const value = metadata(); mutate(value);
    assert.throws(() => validateMetadata(value));
  }
});

test("temporary registry failures retry until public metadata is available", async () => {
  const attempts = [() => Promise.reject(new TypeError("network interrupted")), () => new Response("not found", { status: 404 }),
    () => new Response("busy", { status: 429 }), () => new Response("unavailable", { status: 503 }), response];
  let calls = 0;
  const waits = [];
  assert.deepEqual(await registryMetadata({ fetchImpl: async () => attempts[calls++](), wait: async (delay) => { waits.push(delay); } }), metadata());
  assert.equal(calls, 5);
  assert.deepEqual(waits, [10_000, 10_000, 10_000, 10_000]);
});

test("the registry availability retry remains bounded after persistent 404 responses", async () => {
  let calls = 0;
  let waits = 0;
  await assert.rejects(registryMetadata({ fetchImpl: async () => { calls += 1; return new Response("not found", { status: 404 }); }, wait: async () => { waits += 1; } }), /unavailable after 32 attempts/);
  assert.equal(calls, 32);
  assert.equal(waits, 31);
});

test("authentication failures and malformed successful metadata fail immediately", async () => {
  for (const make of [() => new Response("forbidden", { status: 403 }), () => new Response("not JSON")]) {
    let calls = 0;
    await assert.rejects(registryMetadata({ fetchImpl: async () => { calls += 1; return make(); }, wait: async () => assert.fail("a hard failure must never retry") }));
    assert.equal(calls, 1);
  }
});

test("a timeout while reading successful metadata can recover on the next bounded attempt", async () => {
  let calls = 0;
  const timedOut = new Response(new ReadableStream({ start(controller) { controller.error(new DOMException("metadata body timed out", "TimeoutError")); } }));
  assert.deepEqual(await registryMetadata({ fetchImpl: async () => ++calls === 1 ? timedOut : response(), wait: async () => {} }), metadata());
  assert.equal(calls, 2);
});

test("oversized metadata fails immediately and cancels the response stream", async () => {
  let closed = false;
  const oversized = new Response(new ReadableStream({ cancel() { closed = true; } }), { headers: { "content-length": String(1024 * 1024 + 1) } });
  await assert.rejects(registryMetadata({ fetchImpl: async () => oversized, wait: async () => assert.fail("oversized content must not retry") }), /size bound/);
  assert.equal(closed, true);
});

test("verified provenance binds the exact package bytes, tagged source and publish workflow", () => {
  assert.equal(validateVerifiedProvenance(audit(), COMMIT, INTEGRITY), INVOCATION);
  for (const mutate of [
    (value) => { value.subject[0].name = "pkg:npm/other@1.0.0"; },
    (value) => { value.subject[0].digest.sha512 = "00".repeat(64); },
    (value) => { value.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "0".repeat(40); },
    (value) => { value.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/other/repository"; },
    (value) => { value.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/verify-release.yml"; },
    (value) => { value.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/another-branch"; },
  ]) {
    const value = statement(); mutate(value);
    assert.throws(() => validateVerifiedProvenance(audit(value), COMMIT, INTEGRITY));
  }
  assert.throws(() => validateVerifiedProvenance({ invalid: [], missing: [], verified: [] }, COMMIT, INTEGRITY), /cryptographically verify/);
  assert.throws(() => validateVerifiedProvenance({ ...audit(), invalid: [{ name: "disktop" }] }, COMMIT, INTEGRITY), /invalid signature/);
});

test("provenance crypto verification applies the expected GitHub issuer and workflow identity", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "disktop-signature-policy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = { fixture: "the bundle already audited by npm" };
  let checked = false;
  await verifyProvenanceCertificate(bundle, join(directory, "tuf"), { loadSigstore: async () => ({ verify: async (actual, options) => {
    assert.equal(actual, bundle);
    assert.equal(options.certificateIssuer, "https://token.actions.githubusercontent.com");
    assert.equal(options.certificateIdentityURI, `${REPOSITORY}/.github/workflows/publish.yml@refs/heads/main`);
    assert.ok(options.tufCachePath.startsWith(`${join(directory, "tuf")}/sigstore-tuf-`));
    assert.equal((await stat(options.tufCachePath)).mode & 0o777, 0o700);
    checked = true;
  } }) });
  assert.equal(checked, true);
});

test("a cryptographically signed bundle from the wrong signer fails verification", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "disktop-signature-refusal-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(verifyProvenanceCertificate({}, join(directory, "tuf"), {
    loadSigstore: async () => ({ verify: async () => { throw new Error("certificate identity does not match the reviewed publisher"); } }),
  }), /certificate identity does not match/);
});

test("recovery dispatch has read-only permissions and verifies before executing the installed CLI", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/verify-release.yml", import.meta.url), "utf8");
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.doesNotMatch(workflow, /\bsecrets\s*[.\[]|id-token:|contents: write|npm publish\b|npm-publish/);
  assert.match(workflow, /ref: refs\/tags\/v1\.0\.0/);
  assert.match(workflow, /expected_commit:/);
  assert.match(workflow, /expected_sha256:/);
  assert.match(workflow, /pull_request:\n    paths:/);
  assert.match(workflow, new RegExp(COMMIT));
  assert.match(workflow, new RegExp(SHA256));
  assert.match(workflow, /npm audit signatures --json --include-attestations/);
  assert.match(workflow, /DISKTOP_PACKAGE_REQUIRE_ALL_TARGETS: '1'/);
  assert.match(workflow, /node --test tests\/package\/package\.test\.mjs/);
  const audit = workflow.indexOf("verify-registry-release.mjs audit");
  assert.ok(audit > 0 && workflow.indexOf("node_modules/.bin/disktop") > audit);
});

for (const [mode, views, waits, status] of [["available", 3, 2, 0], ["missing", 32, 31, 1]]) {
  test(`the original post-publish read retry ${mode === "available" ? "recovers from metadata propagation" : "fails after its fixed limit"}`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "disktop-registry-retry-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const log = join(directory, "calls.jsonl");
    const executable = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const calls = fs.existsSync(process.env.DISKTOP_RETRY_LOG) ? fs.readFileSync(process.env.DISKTOP_RETRY_LOG, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse) : [];
const tool = path.basename(process.argv[1]);
fs.appendFileSync(process.env.DISKTOP_RETRY_LOG, JSON.stringify([tool, ...process.argv.slice(2)]) + "\\n");
if (tool === "npm") {
  const count = calls.filter((call) => call[0] === "npm").length + 1;
  if (process.env.DISKTOP_RETRY_MODE === "available" && count >= 3) process.stdout.write("1.0.0\\n");
  else process.exitCode = 1;
}
`;
    for (const tool of ["npm", "sleep"]) {
      await writeFile(join(directory, tool), executable);
      await chmod(join(directory, tool), 0o755);
    }
    const workflow = await readFile(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8");
    const loop = /^          for attempt in \$\(seq 1 32\); do[\s\S]*?^          done$/m.exec(workflow)?.[0];
    assert.ok(loop, "publication must contain one bounded registry-read loop");
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", loop], { encoding: "utf8", timeout: 15_000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, DISKTOP_RETRY_LOG: log, DISKTOP_RETRY_MODE: mode } });
    assert.equal(result.status, status, result.stderr);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.filter((call) => call[0] === "npm").length, views);
    assert.equal(calls.filter((call) => call[0] === "sleep").length, waits);
    for (const call of calls.filter((entry) => entry[0] === "npm")) {
      assert.deepEqual(call.slice(1), ["view", "disktop@1.0.0", "version", "--registry=https://registry.npmjs.org", "--fetch-retries=0", "--fetch-timeout=10000"]);
    }
    for (const call of calls.filter((entry) => entry[0] === "sleep")) assert.deepEqual(call, ["sleep", "10"]);
  });
}
