/** Read-only registry verification for the sole initial release. Never publishes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const REGISTRY = "https://registry.npmjs.org/";
const TARBALL = `${REGISTRY}disktop/-/disktop-1.0.0.tgz`;
const ATTESTATIONS = `${REGISTRY}-/npm/v1/attestations/disktop@1.0.0`;
const PROVENANCE = "https://slsa.dev/provenance/v1";
const REPOSITORY = "https://github.com/Dijo-404/disktop";
const CERTIFICATE_ISSUER = "https://token.actions.githubusercontent.com";
const CERTIFICATE_IDENTITY = `${REPOSITORY}/.github/workflows/publish.yml@refs/heads/main`;

export function validateInputs(commit, sha256) {
  assert.equal(commit?.length, 40, "expected_commit must be a full lowercase source SHA");
  assert.match(commit ?? "", /^[0-9a-f]{40}$/, "expected_commit must be a full lowercase source SHA");
  assert.equal(sha256?.length, 64, "expected_sha256 must be the exact lowercase artifact SHA-256");
  assert.match(sha256 ?? "", /^[0-9a-f]{64}$/, "expected_sha256 must be the exact lowercase artifact SHA-256");
}

async function bytes(response, maximum) {
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  let failed = false;
  try {
    assert.ok(Number(response.headers.get("content-length") ?? 0) <= maximum, "registry response exceeds its size bound");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      assert.ok(length <= maximum, "registry response exceeds its size bound");
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    return Buffer.concat(chunks, length);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await reader.cancel();
    } catch (error) {
      // A failed stream may also reject cancellation; retain the original failure.
      if (!failed) throw error;
    } finally {
      reader.releaseLock();
    }
  }
}

/** Retry only temporary registry/network availability, with a fixed total bound. */
export async function registryMetadata({ fetchImpl = fetch, wait = sleep, attempts = 32, delay = 10_000 } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    const signal = AbortSignal.timeout(10_000);
    try {
      response = await fetchImpl(`${REGISTRY}disktop/1.0.0`, { redirect: "error", signal });
    } catch (error) { last = error; }
    if (response !== undefined) {
      if (response.ok) {
        let body;
        try {
          body = await bytes(response, 1024 * 1024);
        } catch (error) {
          if (!temporaryBodyFailure(error, signal)) throw error;
          last = error;
        }
        if (body !== undefined) return JSON.parse(body.toString("utf8"));
      } else {
        await response.body?.cancel();
        last = new Error(`Registry metadata returned HTTP ${response.status}`);
        if (response.status !== 404 && response.status !== 429 && response.status < 500) throw last;
      }
    }
    if (attempt < attempts) await wait(delay);
  }
  throw new Error(`disktop@1.0.0 remained unavailable after ${attempts} attempts`, { cause: last });
}

function temporaryBodyFailure(error, signal) {
  if (error?.code === "ERR_ASSERTION") return false;
  if (signal.aborted) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  if (error instanceof TypeError && (error.message === "terminated" || error.message === "fetch failed")) return true;
  return ["ECONNRESET", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_BODY_TIMEOUT"].includes(error.code ?? error.cause?.code);
}

export function validateMetadata(metadata) {
  assert.equal(metadata.name, "disktop");
  assert.equal(metadata.version, "1.0.0");
  assert.equal(metadata.dist?.tarball, TARBALL);
  assert.match(metadata.dist?.integrity ?? "", /^sha512-[A-Za-z0-9+/]{86}==$/);
  assert.equal(metadata.dist.integrity.length, 95, "registry integrity must contain one exact SHA-512 digest");
  const encodedDigest = metadata.dist.integrity.slice("sha512-".length);
  assert.equal(Buffer.from(encodedDigest, "base64").toString("base64"), encodedDigest, "registry integrity must use canonical base64");
  assert.ok(Array.isArray(metadata.dist?.signatures) && metadata.dist.signatures.length > 0, "the release requires registry signatures");
  assert.equal(metadata.dist?.attestations?.url, ATTESTATIONS);
  assert.equal(metadata.dist?.attestations?.provenance?.predicateType, PROVENANCE);
}

/** The input must be npm audit signatures --json --include-attestations output. */
export function validateVerifiedProvenance(report, commit, integrity) {
  assert.deepEqual(report.invalid, [], "npm found an invalid signature or attestation");
  assert.deepEqual(report.missing, [], "npm found a missing registry signature");
  const verified = report.verified?.filter((entry) => entry.name === "disktop" && entry.version === "1.0.0");
  assert.equal(verified?.length, 1, "npm must cryptographically verify this release's attestation");
  assert.equal(new URL(verified[0].registry).href, REGISTRY);
  const provenances = verified[0].attestationBundles?.filter((entry) => entry.predicateType === PROVENANCE);
  assert.equal(provenances?.length, 1, "npm must verify exactly one SLSA provenance bundle for disktop");
  const statement = JSON.parse(Buffer.from(provenances[0].bundle.dsseEnvelope.payload, "base64").toString("utf8"));
  assert.equal(statement._type, "https://in-toto.io/Statement/v1");
  assert.equal(statement.predicateType, PROVENANCE);
  const sha512 = Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
  assert.deepEqual(statement.subject, [{ name: "pkg:npm/disktop@1.0.0", digest: { sha512 } }]);
  const definition = statement.predicate.buildDefinition;
  assert.equal(definition.buildType, "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1");
  assert.deepEqual(definition.externalParameters.workflow, { ref: "refs/heads/main", repository: REPOSITORY, path: ".github/workflows/publish.yml" });
  assert.deepEqual(definition.resolvedDependencies, [{ uri: `git+${REPOSITORY}@refs/heads/main`, digest: { gitCommit: commit } }]);
  assert.equal(definition.internalParameters.github.event_name, "workflow_dispatch");
  assert.equal(statement.predicate.runDetails.builder.id, "https://github.com/actions/runner/github-hosted");
  const invocation = statement.predicate.runDetails.metadata.invocationId;
  assert.match(invocation, /^https:\/\/github\.com\/Dijo-404\/disktop\/actions\/runs\/[0-9]+\/attempts\/[0-9]+$/);
  return invocation;
}

async function installedNpmSigstore() {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, "npm");
    let executable;
    try {
      await access(candidate, constants.X_OK);
      executable = await realpath(candidate);
      if (!(await stat(executable)).isFile()) continue;
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) continue;
      throw error;
    }
    return createRequire(pathToFileURL(executable))("sigstore");
  }
  throw new Error("The npm executable is unavailable on PATH; its bundled Sigstore verifier is required.");
}

/** Bind npm's authenticated bundle to the release workflow's certified OIDC identity. */
export async function verifyProvenanceCertificate(bundle, cacheDirectory, { loadSigstore = installedNpmSigstore } = {}) {
  await mkdir(cacheDirectory, { recursive: true });
  const privateCache = await mkdtemp(join(cacheDirectory, "sigstore-tuf-"));
  const sigstore = await loadSigstore();
  await sigstore.verify(bundle, {
    tufCachePath: privateCache,
    certificateIssuer: CERTIFICATE_ISSUER,
    certificateIdentityURI: CERTIFICATE_IDENTITY,
    timeout: 10_000,
    retry: { retries: 1 },
  });
}

async function main() {
  const [mode, directory, reportPath] = process.argv.slice(2);
  const commit = process.env.EXPECTED_COMMIT;
  const sha256 = process.env.EXPECTED_SHA256;
  validateInputs(commit, sha256);
  assert.ok(mode === "download" || mode === "audit", "choose download or audit");
  if (mode === "download") {
    const metadata = await registryMetadata();
    validateMetadata(metadata);
    const response = await fetch(TARBALL, { redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`registry tarball returned HTTP ${response.status}`);
    }
    const artifact = await bytes(response, 64 * 1024 * 1024);
    assert.equal(createHash("sha256").update(artifact).digest("hex"), sha256, "registry tarball differs from the audited publication artifact");
    assert.equal(`sha512-${createHash("sha512").update(artifact).digest("base64")}`, metadata.dist.integrity);
    await mkdir(directory);
    await writeFile(join(directory, "disktop-1.0.0.tgz"), artifact, { flag: "wx" });
    await writeFile(join(directory, "metadata.json"), JSON.stringify(metadata), { flag: "wx" });
    process.stdout.write(`Verified registry artifact SHA-256 ${sha256}\n`);
  } else {
    const metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"));
    validateMetadata(metadata);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const invocation = validateVerifiedProvenance(report, commit, metadata.dist.integrity);
    const verified = report.verified.find((entry) => entry.name === "disktop" && entry.version === "1.0.0");
    const provenance = verified.attestationBundles.find((entry) => entry.predicateType === PROVENANCE);
    await verifyProvenanceCertificate(provenance.bundle, join(directory, "provenance-cache"));
    const lock = JSON.parse(await readFile(join(directory, "consumer", "package-lock.json"), "utf8"));
    const installed = lock.packages["node_modules/disktop"];
    assert.equal(installed.version, "1.0.0");
    assert.equal(installed.resolved, TARBALL);
    assert.equal(installed.integrity, metadata.dist.integrity, "clean install must use the exact audited registry artifact");
    process.stdout.write(`Verified source ${commit} and cryptographic provenance: ${invocation}\n`);
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
