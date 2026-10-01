import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  createCondaProvider,
  createNodeVersionsProvider,
  createProjectArtifactsProvider,
  createPyenvProvider,
  createPythonEnvsProvider,
  createRustupProvider,
} from "../../dist/providers/dev/index.js";
import { createDeveloperFixture } from "../fixtures/generate.mjs";
import { createPathProbe } from "../../dist/platform/linux/probe.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";
import { byId, discover, discoveryEnvironment, displays, storedScan } from "../support/discovery.mjs";

/** The real probe, with one file's contents replaced or removed. */
function aliasReader(path, contents) {
  const real = createPathProbe();
  return {
    facts: (candidate) => real.facts(candidate),
    list: (candidate) => real.list(candidate),
    async readText(candidate, maxBytes) {
      if (candidate.display === path) {
        return contents;
      }
      return real.readText(candidate, maxBytes);
    },
  };
}

let fixture;

before(async () => {
  fixture = await createDeveloperFixture();
});

after(async () => {
  await fixture.cleanup();
});

function environmentFor(overrides = {}) {
  return discoveryEnvironment(fixture.home, overrides);
}

test("conda reports the prefix, each environment, and the package cache", async () => {
  const result = await discover(createCondaProvider(), environmentFor());

  assert.equal(result.capability.status, "available");
  const paths = displays(result.findings);
  assert.ok(paths.includes(fixture.paths.condaPkgs), `pkgs cache missing from ${JSON.stringify(paths)}`);
  for (const environmentPath of fixture.paths.condaEnvs) {
    assert.ok(paths.includes(environmentPath), `${environmentPath} missing from ${JSON.stringify(paths)}`);
  }
});

test("a directory under envs without conda-meta is not an environment", async () => {
  const result = await discover(createCondaProvider(), environmentFor());

  assert.ok(
    !displays(result.findings).some((path) => path.endsWith("/envs/notes")),
    "a directory named like an environment is not evidence of one",
  );
});

test("the active conda prefix is marked in use", async () => {
  const result = await discover(
    createCondaProvider(),
    environmentFor({ variables: { CONDA_PREFIX: fixture.paths.condaEnvs[0] } }),
  );

  const active = result.findings.find((finding) => finding.paths[0]?.display === fixture.paths.condaEnvs[0]);
  assert.equal(active.active, true);
  assert.deepEqual(active.availableActionIds, []);

  const idle = result.findings.find((finding) => finding.paths[0]?.display === fixture.paths.condaEnvs[1]);
  assert.equal(idle.active, false);
  assert.deepEqual(idle.availableActionIds, ["trash"]);
});

test("conda is absent when no prefix exists, which is not an empty result", async () => {
  const result = await discover(createCondaProvider(), discoveryEnvironment("/home/nobody-at-all"));

  assert.equal(result.capability.status, "missing-tool");
  assert.deepEqual(result.findings, []);
  assert.match(result.capability.explanation, /conda/i);
});

test("a virtualenv is found by its pyvenv.cfg, not by its directory name", async () => {
  const result = await discover(createPythonEnvsProvider(), environmentFor());

  const paths = displays(result.findings);
  assert.ok(paths.includes(fixture.paths.venv));
  assert.ok(!paths.some((path) => path.endsWith("/.virtualenvs/empty")));
  const found = result.findings[0];
  assert.ok(found.evidence.some((line) => line.includes("pyvenv.cfg")), JSON.stringify(found.evidence));
});

test("project virtualenvs come from a stored scan, and their absence is incomplete", async () => {
  const withScan = await discover(
    createPythonEnvsProvider(),
    environmentFor({ index: storedScan([`${fixture.home}/projects/api/.venv`]) }),
  );
  assert.equal(withScan.complete, true);

  const withoutScan = await discover(createPythonEnvsProvider(), environmentFor());
  assert.equal(withoutScan.complete, false, "no stored scan means project environments were not looked for");
  assert.ok(withoutScan.warnings.some((warning) => warning.code === "no-stored-scan"));
});

test("pyenv marks the version named in its version file", async () => {
  const result = await discover(createPyenvProvider(), environmentFor());

  const active = result.findings.filter((finding) => finding.active).map((finding) => finding.paths[0].display);
  assert.deepEqual(active, [fixture.paths.pyenvVersions[1]]);
  assert.equal(result.findings.length, 2);
});

test("node versions come from nvm and fnm, and the default alias is in use", async () => {
  const result = await discover(createNodeVersionsProvider(), environmentFor());

  const paths = displays(result.findings);
  for (const version of [...fixture.paths.nvmVersions, fixture.paths.fnmVersion]) {
    assert.ok(paths.includes(version), `${version} missing from ${JSON.stringify(paths)}`);
  }
  // nvm names its default, so the other nvm version is known to be idle.
  const idle = result.findings.filter((finding) => !finding.active).map((finding) => finding.paths[0].display);
  assert.deepEqual(idle, [fixture.paths.nvmVersions[0]]);

  // fnm records no default here, so its version is not called idle.
  const fnm = result.findings.find((finding) => finding.paths[0].display === fixture.paths.fnmVersion);
  assert.equal(fnm.active, true);
  assert.deepEqual(fnm.availableActionIds, []);
});

test("rustup marks its default toolchain and reports the download cache", async () => {
  const result = await discover(createRustupProvider(), environmentFor());

  const found = byId(result.findings);
  const paths = displays(result.findings);
  assert.ok(paths.includes(fixture.paths.rustupDownloads));
  const active = result.findings.filter((finding) => finding.active).map((finding) => finding.paths[0].display);
  assert.deepEqual(active, [fixture.paths.rustupToolchains[1]], "settings.toml names the stable toolchain");
  assert.equal(found.size, result.findings.length, "every finding has its own id");
});

test("every developer finding leaves its size for the footprint port to fill", async () => {
  for (const provider of [
    createCondaProvider(),
    createPythonEnvsProvider(),
    createPyenvProvider(),
    createNodeVersionsProvider(),
    createRustupProvider(),
  ]) {
    const result = await discover(provider, environmentFor());
    for (const finding of result.findings) {
      assert.equal(finding.size.basis, "unknown", `${finding.id} measured its own size`);
      assert.equal(finding.size.bytes, undefined);
      assert.ok(finding.size.explanation.length > 0);
    }
  }
});

test("build output is found through the index, with Cargo.toml deciding confidence", async () => {
  const result = await discover(
    createProjectArtifactsProvider(),
    environmentFor({
      index: storedScan([
        fixture.paths.nodeModules,
        fixture.paths.cargoTarget,
        fixture.paths.pycache,
        fixture.paths.ambiguousTarget,
      ]),
    }),
  );

  const found = byId(result.findings);
  const paths = displays(result.findings);
  assert.ok(paths.includes(fixture.paths.nodeModules));
  assert.ok(paths.includes(fixture.paths.pycache));

  const rust = [...found.values()].find((finding) => finding.paths[0].display === fixture.paths.cargoTarget);
  const ambiguous = [...found.values()].find((finding) => finding.paths[0].display === fixture.paths.ambiguousTarget);
  assert.equal(rust.confidence, "likely", "a target beside a Cargo.toml is a Rust build directory");
  assert.equal(ambiguous.confidence, "uncertain", "a target with no Cargo.toml beside it is only a name");
});

test("without a stored scan, build output is incomplete rather than absent", async () => {
  const result = await discover(createProjectArtifactsProvider(), environmentFor());

  assert.deepEqual(result.findings, []);
  assert.equal(result.complete, false);
  assert.ok(result.warnings.some((warning) => warning.message.includes("disktop scan")));
});

test("every developer finding has a stable id that survives a second run", async () => {
  const first = await discover(createCondaProvider(), environmentFor());
  const second = await discover(createCondaProvider(), environmentFor());

  assert.deepEqual(
    first.findings.map((finding) => finding.id),
    second.findings.map((finding) => finding.id),
  );
  for (const finding of first.findings) {
    assert.match(finding.id, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/, `${finding.id} is not a valid identifier`);
  }
});

test("a truncated index search is reported rather than silently listing fewer", async () => {
  const crowded = {
    async directoriesNamed() {
      return { paths: [rawPathFromUtf8(`${fixture.home}/projects/api/node_modules`)], searched: true, truncated: true };
    },
  };

  const result = await discover(createProjectArtifactsProvider(), environmentFor({ index: crowded }));

  assert.equal(result.complete, false);
  assert.ok(
    result.warnings.some((warning) => warning.code === "findings-truncated"),
    JSON.stringify(result.warnings),
  );
});

test("nvm's default alias is resolved, and an absent one is not read as 'not default'", async () => {
  // nvm writes `lts/iron` or `20` into alias/default, never `v24.8.0`.
  const aliased = await discover(
    createNodeVersionsProvider(),
    environmentFor({ paths: aliasReader(`${fixture.home}/.nvm/alias/default`, "lts/iron\n") }),
  );
  // `lts/iron` resolves to nothing here, so no nvm version is called idle.
  const idleUnderAlias = aliased.findings.filter((finding) => finding.title.includes("nvm") && !finding.active);
  assert.deepEqual(idleUnderAlias, [], JSON.stringify(idleUnderAlias.map((finding) => finding.title)));

  const noAlias = await discover(
    createNodeVersionsProvider(),
    environmentFor({ paths: aliasReader(`${fixture.home}/.nvm/alias/default`, undefined) }),
  );
  for (const finding of noAlias.findings.filter((candidate) => candidate.title.includes("nvm"))) {
    assert.equal(finding.active, true, `${finding.title} was called inactive with no evidence`);
    assert.deepEqual(finding.availableActionIds, [], `${finding.title} was offered for removal`);
    assert.ok(
      finding.evidence.some((line) => /could not be established|no default/i.test(line)),
      JSON.stringify(finding.evidence),
    );
  }
});

test("a version named by a bare number in the alias file is still recognised", async () => {
  const result = await discover(
    createNodeVersionsProvider(),
    environmentFor({ paths: aliasReader(`${fixture.home}/.nvm/alias/default`, "24\n") }),
  );

  const idleNvm = result.findings
    .filter((finding) => finding.title.includes("nvm") && !finding.active)
    .map((finding) => finding.paths[0].display);
  assert.deepEqual(idleNvm, [fixture.paths.nvmVersions[0]], "`24` names v24.8.0, so only v22.9.0 is idle");
});
