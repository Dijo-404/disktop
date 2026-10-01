import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "../../dist/cli/run.js";
import { compileBundle } from "../support/schemas.mjs";
import { fakeContext, rawPath } from "../support/cli-context.mjs";

const validators = compileBundle("schemas/cli/v1");

function envelopeOf(context, schema) {
  const envelope = JSON.parse(context.captured.stdout);
  const validate = validators.get(schema);
  assert.ok(validate(envelope), `${schema}: ${JSON.stringify(validate.errors)}`);
  return envelope;
}

const CARGO = {
  id: "cache.language:cargo-registry",
  providerId: "cache.language",
  providerVersion: 1,
  category: "language-cache",
  title: "Cargo registry cache",
  evidence: ["Downloaded crate sources and their index."],
  paths: [rawPath("/home/example/.cargo/registry")],
  size: { bytes: 7_314_112_512n, basis: "measured-allocated", explanation: "Blocks on disk, from the scan index." },
  confidence: "observed",
  capability: { status: "available", explanation: "The directory was read." },
  availableActionIds: ["trash"],
  regenerationCost: "Re-downloaded on the next build that needs a crate.",
  active: false,
};

const PROFILE = {
  id: "cache.browser:firefox-profile",
  providerId: "cache.browser",
  providerVersion: 1,
  category: "browser-cache",
  title: "Firefox profile default-release",
  evidence: ["A profile holds logins and history, not disposable cache."],
  paths: [rawPath("/home/example/.mozilla/firefox/default-release")],
  size: { basis: "unknown", explanation: "No stored scan covers this path." },
  confidence: "observed",
  capability: { status: "available", explanation: "The directory was read." },
  availableActionIds: [],
  active: true,
};

const RAN = {
  providerId: "cache.language",
  version: 1,
  capability: { status: "available", explanation: "8 cache roots exist." },
  findings: 1,
  complete: true,
  ran: true,
};

const DENIED = {
  providerId: "diagnostic.open-deleted",
  version: 1,
  capability: { status: "permission-denied", explanation: "lsof could not be run by this user." },
  findings: 0,
  complete: false,
  ran: false,
};

function summary(overrides = {}) {
  return {
    findings: [CARGO, PROFILE],
    providers: [RAN, DENIED],
    warnings: [],
    complete: true,
    categoryTotals: [
      { category: "language-cache", findings: 1, bytes: 7_314_112_512n, unmeasured: 0, nested: 0 },
      { category: "browser-cache", findings: 1, bytes: 0n, unmeasured: 1, nested: 0 },
    ],
    measured: true,
    capability: { status: "available", explanation: "1 of 2 detectors ran." },
    ...overrides,
  };
}

function cleanContext(overrides = {}) {
  const recorded = {};
  const context = fakeContext();
  context.footprint = {
    async discover(request) {
      recorded.request = request;
      return overrides.summary ?? summary();
    },
  };
  context.recordedFootprint = recorded;
  return context;
}

test("clean lists what was found and validates against the published schema", async () => {
  const context = cleanContext();
  const status = await runCli(["clean", "--json"], context);
  const envelope = envelopeOf(context, "clean");

  assert.equal(status, 0);
  assert.equal(envelope.command, "clean");
  assert.equal(envelope.data.measured, true);
  assert.deepEqual(
    envelope.data.findings.map((finding) => finding.id),
    ["cache.language:cargo-registry", "cache.browser:firefox-profile"],
  );
  assert.equal(envelope.data.findings[0].size.bytes, "7314112512");
  assert.equal(envelope.data.findings[1].size.bytes, undefined);
  assert.equal(envelope.data.findings[1].size.basis, "unknown");
});

test("every detector appears, including the one that was denied", async () => {
  const context = cleanContext();
  await runCli(["clean", "--json"], context);
  const envelope = envelopeOf(context, "clean");

  assert.deepEqual(
    envelope.data.providers.map((report) => [report.providerId, report.capability.status]),
    [
      ["cache.language", "available"],
      ["diagnostic.open-deleted", "permission-denied"],
    ],
  );
});

test("--dry-run is accepted and changes nothing, because nothing is applied", async () => {
  const context = cleanContext();
  const status = await runCli(["clean", "--dry-run", "--json"], context);

  assert.equal(status, 0);
  assert.equal(JSON.parse(context.captured.stdout).data.findings.length, 2);
});

test("an incomplete discovery exits 3 and says what was missed", async () => {
  const context = cleanContext({
    summary: summary({
      complete: false,
      warnings: [{ code: "provider-denied", message: "diagnostic.open-deleted was denied: lsof refused." }],
    }),
  });

  const status = await runCli(["clean", "--json"], context);
  const envelope = envelopeOf(context, "clean");

  assert.equal(status, 3);
  assert.equal(envelope.status, "incomplete");
  assert.deepEqual(
    envelope.warnings.map((warning) => warning.code),
    ["provider-denied"],
  );
});

test("--category narrows the request and an unknown one is an input error", async () => {
  const context = cleanContext();
  await runCli(["clean", "--category", "browser-cache", "--json"], context);
  assert.deepEqual(context.recordedFootprint.request.categories, ["browser-cache"]);

  const bad = cleanContext();
  const status = await runCli(["clean", "--category", "everything", "--json"], bad);
  assert.equal(status, 2);
  assert.equal(JSON.parse(bad.captured.stdout).error.code, "invalid-input");
});

test("--no-sizes asks for no measurement at all", async () => {
  const context = cleanContext();
  await runCli(["clean", "--no-sizes", "--json"], context);
  assert.equal(context.recordedFootprint.request.measureSizes, false);
});

test("text output names the detector that could not look and why", async () => {
  const context = cleanContext();
  await runCli(["clean"], context);

  assert.match(context.captured.stdout, /Cargo registry cache/);
  assert.match(context.captured.stdout, /unknown/, "an unmeasured finding says so rather than showing a size");
  assert.match(context.captured.stderr, /diagnostic\.open-deleted/);
  assert.match(context.captured.stderr, /lsof could not be run/);
});

test("text output marks data that is in use", async () => {
  const context = cleanContext();
  await runCli(["clean"], context);

  const profileLine = context.captured.stdout
    .split("\n")
    .find((line) => line.includes("Firefox profile default-release"));
  assert.ok(profileLine !== undefined, context.captured.stdout);
  assert.match(profileLine, /in use/);
});

test("clean itself still applies nothing: a plan is a separate, deliberate command", async () => {
  const context = cleanContext();
  await runCli(["clean", "--json"], context);
  const envelope = JSON.parse(context.captured.stdout);

  // Listing names the actions each finding could support, and offers no way to
  // run one. Reaching an action takes `clean plan` and then `clean apply`.
  assert.deepEqual(envelope.data.findings[0].availableActionIds, ["trash"]);
  assert.equal(envelope.data.findings[1].availableActionIds.length, 0);
  assert.equal(context.recordedFootprint.request.measureSizes, true);
});

test("--limit refuses a number above the documented maximum", async () => {
  const context = cleanContext();
  const status = await runCli(["clean", "--limit", "9999", "--json"], context);

  assert.equal(status, 2);
  assert.equal(JSON.parse(context.captured.stdout).error.code, "invalid-input");
});

test("--limit accepts the documented maximum", async () => {
  const context = cleanContext();
  assert.equal(await runCli(["clean", "--limit", "1000", "--json"], context), 0);
});
