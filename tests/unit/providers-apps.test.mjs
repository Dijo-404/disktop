import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInstalledAppsProvider } from "../../dist/providers/apps/index.js";
import { createPackageInventory } from "../../dist/platform/linux/packages/index.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";
import { restoreAndRemove } from "../fixtures/generate.mjs";
import { discover, discoveryEnvironment } from "../support/discovery.mjs";

const AVAILABLE = { status: "available", explanation: "responded" };

/** A tool port answering for the managers a test says exist. */
function toolsReplying(replies) {
  return {
    async run(name) {
      const reply = replies[name];
      if (reply === undefined) {
        return {
          capability: { status: "missing-tool", explanation: `${name} is not installed.` },
          stdout: "",
          stderr: "",
          exitCode: null,
        };
      }
      return {
        capability: reply.capability ?? AVAILABLE,
        stdout: reply.stdout ?? "",
        stderr: "",
        exitCode: reply.exitCode ?? 0,
      };
    },
  };
}

const DPKG = [
  "bash\t1800\tinstall ok installed",
  "linux-image-6.8.0-45-generic\t392144\tinstall ok installed",
  "coreutils\t18000\tinstall ok installed",
  "",
].join("\n");

const SNAP = ["Name     Version   Rev   Tracking       Publisher  Notes", "core22   20240823  1612  latest/stable  canonical  base", ""].join("\n");

function providerFor(replies) {
  return createInstalledAppsProvider(createPackageInventory(toolsReplying(replies)));
}

let home;

before(async () => {
  home = await mkdtemp(join(tmpdir(), "disktop-fixture-"));
});

after(async () => {
  await restoreAndRemove(home);
});

test("each manager that answered gets one summary finding naming its own figure", async () => {
  const result = await discover(providerFor({ "dpkg-query": { stdout: DPKG }, snap: { stdout: SNAP } }), discoveryEnvironment(home));

  const summaries = result.findings.filter((finding) => finding.managerScope !== undefined && !finding.managerScope.includes(" "));
  assert.deepEqual(summaries.map((finding) => finding.managerScope).sort(), ["dpkg", "snap"]);

  const dpkg = summaries.find((finding) => finding.managerScope === "dpkg");
  assert.equal(dpkg.size.basis, "manager-reported");
  assert.match(dpkg.size.explanation, /Installed-Size/);
  assert.match(dpkg.title, /3 packages/);
});

test("a manager that reports no size has an unknown total, not a zero one", async () => {
  const result = await discover(providerFor({ snap: { stdout: SNAP } }), discoveryEnvironment(home));

  const snap = result.findings.find((finding) => finding.managerScope === "snap");
  assert.equal(snap.size.basis, "unknown");
  assert.equal(snap.size.bytes, undefined);
});

test("a package count is never taken from a command that did not answer", async () => {
  const result = await discover(providerFor({ "dpkg-query": { stdout: DPKG } }), discoveryEnvironment(home));

  assert.ok(
    !result.findings.some((finding) => finding.managerScope === "pacman"),
    "a manager that is not installed contributes no finding",
  );
});

test("a manager that refuses makes the result incomplete and is named", async () => {
  const result = await discover(
    providerFor({
      "dpkg-query": { stdout: DPKG },
      rpm: { capability: { status: "permission-denied", explanation: "rpm could not be run by this user." }, exitCode: 1 },
    }),
    discoveryEnvironment(home),
  );

  assert.equal(result.complete, false);
  assert.ok(result.warnings.some((warning) => warning.message.includes("rpm")), JSON.stringify(result.warnings));
});

test("per-package findings are bounded and ranked by the reported size", async () => {
  const many = Array.from({ length: 40 }, (_, index) => `pkg-${index}\t${(index + 1) * 100}\tinstall ok installed`).join("\n");
  const result = await discover(providerFor({ "dpkg-query": { stdout: many } }), discoveryEnvironment(home));

  const individual = result.findings.filter((finding) => finding.managerScope?.startsWith("dpkg ") === true);
  assert.equal(individual.length, 5, "one manager cannot flood the list");
  assert.equal(individual[0].title.startsWith("pkg-39"), true, JSON.stringify(individual.map((finding) => finding.title)));
});

test("every installed-app finding says whose number its size is", async () => {
  const result = await discover(providerFor({ "dpkg-query": { stdout: DPKG }, snap: { stdout: SNAP } }), discoveryEnvironment(home));

  for (const finding of result.findings) {
    assert.ok(finding.size.explanation.length > 0, `${finding.id} has an unexplained size`);
    assert.notEqual(finding.size.basis, "measured-allocated", `${finding.id} claims a measurement it did not take`);
  }
});

test("an AppImage in a configured root is sized by one stat call", async () => {
  const appImage = join(home, "Toolbox.AppImage");
  await writeFile(appImage, "a".repeat(8192));

  const result = await discover(
    providerFor({ "dpkg-query": { stdout: DPKG } }),
    discoveryEnvironment(home, { appImageRoots: [rawPathFromUtf8(home)] }),
  );

  const found = result.findings.find((finding) => finding.paths[0]?.display === appImage);
  assert.ok(found !== undefined, JSON.stringify(result.findings.map((finding) => finding.title)));
  assert.equal(found.size.basis, "stat");
  assert.ok(found.size.bytes >= 8192n);
});

test("a machine with no package manager at all says so", async () => {
  const result = await discover(providerFor({}), discoveryEnvironment(home));

  assert.equal(result.capability.status, "missing-tool");
  assert.deepEqual(result.findings, []);
});

test("output a manager prints in an unrecognised format is not counted as zero packages", async () => {
  const result = await discover(
    providerFor({ "dpkg-query": { stdout: "this is not what dpkg-query prints at all\n" } }),
    discoveryEnvironment(home),
  );

  assert.equal(result.capability.status, "missing-tool");
  assert.deepEqual(result.findings, []);
});
