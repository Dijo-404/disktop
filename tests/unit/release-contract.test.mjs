/**
 * The release contract, read from every place that states it.
 *
 * The locator, the release build script, both workflows, the vendor README,
 * and ADR 0003 each name the packaged helpers and their checksum file. Before
 * this test they disagreed, and a released package would never have found or
 * verified its own helper. Any one of them drifting now fails here.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CHECKSUM_FILE, HELPER_TARGETS, helperBinaryName } from "../../dist/native/locator.js";
import { publishRefusal, repositorySlug } from "../../scripts/prepublish-guard.mjs";
import * as release from "../../scripts/release-targets.mjs";

const read = (path) => readFileSync(path, "utf8");
const manifest = JSON.parse(read("package.json"));
const BINARIES = HELPER_TARGETS.map(helperBinaryName).sort();
const HELPER_NAME = /disktop-fs-linux-[a-z0-9]+-[a-z0-9]+/g;

function namedHelpers(text) {
  return [...new Set(text.match(HELPER_NAME) ?? [])].sort();
}

/** One YAML job or step, bounded by the next declaration at its indentation. */
function workflowBlock(text, header, indentation) {
  const start = text.indexOf(`${header}\n`);
  assert.ok(start >= 0, `missing workflow declaration: ${header.trim()}`);
  const afterHeader = start + header.length + 1;
  const tail = text.slice(afterHeader);
  const next = new RegExp(`^ {0,${indentation}}\\S`, "m").exec(tail)?.index ?? tail.length;
  return text.slice(start, afterHeader + next);
}

test("the locator and the release build name the same four helpers and checksum file", () => {
  assert.deepEqual([...HELPER_TARGETS].sort(), release.RELEASE_TARGETS.map((target) => target.name).sort());
  assert.deepEqual(release.RELEASE_TARGETS.map(release.binaryName).sort(), BINARIES);
  assert.equal(release.CHECKSUM_FILE, CHECKSUM_FILE);
  assert.equal(CHECKSUM_FILE, "SHA256SUMS");
  for (const target of release.RELEASE_TARGETS) {
    assert.ok(target.rustTarget.startsWith(target.arch === "x64" ? "x86_64-" : "aarch64-"), target.name);
    assert.ok(target.rustTarget.endsWith(`-linux-${target.libc}`), target.name);
  }
});

test("both workflows check exactly the helpers the locator selects, by SHA256SUMS", () => {
  for (const workflow of [".github/workflows/publish.yml", ".github/workflows/ci.yml"]) {
    const text = read(workflow);
    assert.deepEqual(namedHelpers(text), BINARIES, `${workflow} names a different set of helpers`);
    assert.match(text, /sha256sum --check --strict SHA256SUMS/, workflow);
    assert.doesNotMatch(text, /checksums\.json|-glibc\b/, workflow);
    assert.match(text, /node scripts\/build-release\.mjs/, `${workflow} must build the helpers with the release script`);
  }
  const publish = read(".github/workflows/publish.yml");
  assert.doesNotMatch(publish, /npm run build:native/, "a development build is not a release build");
  assert.match(publish, /node --test tests\/package\//, "publish smoke-tests the tarball it publishes");
  assert.match(publish, /node scripts\/prepublish-guard\.mjs/, "publish runs the guard that --ignore-scripts skips");
  assert.match(read(".github/workflows/ci.yml"), /npm run test:package/);
});

test("CI and publication both audit npm and the native lockfile without advisory suppressions", () => {
  for (const workflow of [".github/workflows/ci.yml", ".github/workflows/publish.yml"]) {
    const text = read(workflow);
    assert.match(text, /npm audit\b/, workflow);
    assert.match(text, /cargo install --locked cargo-audit --version 0\.22\.2/, workflow);
    assert.match(text, /cargo audit --file native\/disktop-fs\/Cargo\.lock --deny warnings/, workflow);
    assert.doesNotMatch(text, /cargo audit[^\n]*--ignore\b|npm audit[^\n]*\|\|/, workflow);
  }
});

test("the publish token check and publication use the same compatible credential mapping", () => {
  const publish = workflowBlock(read(".github/workflows/publish.yml"), "  publish:", 2);
  const check = workflowBlock(publish, "      - name: Require the one-time first-publish token", 6);
  const publication = workflowBlock(publish, "      - name: Publish audited v1.0.0 with provenance", 6);
  const expected = "${{ secrets.NPM_TOKEN || secrets.DISKTOP }}";
  for (const step of [check, publication]) {
    const credentials = [...step.matchAll(/^          NODE_AUTH_TOKEN: (.+)$/gm)];
    assert.equal(credentials.length, 1, "each credential consumer has exactly one step-scoped token");
    assert.equal(credentials[0][1], expected, "NPM_TOKEN takes precedence over the DISKTOP alias");
  }
  assert.match(check, /if \[ -z "\$NODE_AUTH_TOKEN" \]; then[\s\S]*Missing NPM_TOKEN or DISKTOP[\s\S]*exit 1/);
  assert.match(publication, /^        run: npm publish "\$ARCHIVE" --ignore-scripts --provenance --access public$/m);
});

test("publish credentials are confined to the two consumers in the protected publish job", () => {
  const workflow = read(".github/workflows/publish.yml");
  const publish = workflowBlock(workflow, "  publish:", 2);
  const secretOrToken = /\bsecrets\s*(?:\.|\[)|\bNODE_AUTH_TOKEN\s*:/;
  assert.doesNotMatch(workflow.replace(publish, ""), secretOrToken, "build, verify and workflow-level configuration cannot access publish credentials");
  assert.match(publish, /^    environment: npm-publish$/m, "reviewer approval protects every token consumer");
  assert.match(publish, /^    needs: \[build, verify\]$/m, "all artifact gates precede publication");
  assert.match(publish, /^      id-token: write$/m, "provenance permissions remain in the protected job");
  const check = workflowBlock(publish, "      - name: Require the one-time first-publish token", 6);
  const publication = workflowBlock(publish, "      - name: Publish audited v1.0.0 with provenance", 6);
  assert.doesNotMatch(publish.replace(check, "").replace(publication, ""), secretOrToken, "other protected steps also receive no token");
  assert.deepEqual([...publish.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z_0-9]*)/g)].map((match) => match[1]), ["NPM_TOKEN", "DISKTOP", "NPM_TOKEN", "DISKTOP"]);
});

test("the vendor README and ADR 0003 describe the same contract", () => {
  for (const document of ["vendor/bin/README.md", "docs/adr/0003-prebuilt-binary-packaging.md"]) {
    const text = read(document);
    assert.deepEqual(namedHelpers(text), BINARIES, `${document} names a different set of helpers`);
    assert.match(text, /SHA256SUMS/, document);
    assert.doesNotMatch(text, /checksums\.json/, document);
  }
});

test("every action a workflow uses is pinned to a full commit SHA", () => {
  const files = [
    ...readdirSync(".github/workflows").map((name) => join(".github/workflows", name)),
    ".github/actions/release-toolchain/action.yml",
  ];
  for (const file of files) {
    for (const [, reference] of read(file).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      if (reference.startsWith("./")) {
        continue;
      }
      assert.match(reference, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${file}: ${reference}`);
    }
  }
});

test("package.json is the public 1.0.0 CLI and ships only what a user needs", () => {
  assert.equal(manifest.name, "disktop");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.private, false);
  assert.equal(manifest.license, "Apache-2.0");
  assert.deepEqual(manifest.os, ["linux"]);
  // No `cpu`: npm would refuse to install on another architecture, and the
  // support matrix promises that machine inventory and an explicit
  // unsupported-architecture state for the helper-backed commands instead.
  assert.equal(manifest.cpu, undefined);
  assert.equal(manifest.engines.node, ">=24.21.0 <25 || >=26.10.0 <27");
  assert.equal(manifest.main, undefined);
  assert.equal(manifest.types, undefined);
  assert.deepEqual(manifest.exports, {
    "./package.json": "./package.json",
    "./schemas/cli/v1/*.json": "./schemas/cli/v1/*.json",
  });
  assert.deepEqual(manifest.files, [
    "dist/**/*.js",
    "vendor/bin/disktop-fs-linux-*",
    "vendor/bin/SHA256SUMS",
    // npm 11, the npm Node 24 ships, adds any README.md in a directory it
    // packs from; npm 12 does not. The package smoke test caught it.
    "!vendor/bin/README.md",
    "schemas/cli/v1/*.json",
    "schemas/cli/v1/README.md",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES",
    "CHANGELOG.md",
  ]);
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    assert.equal(manifest.scripts[hook], undefined, `${hook} would run at install time`);
  }
  assert.equal(manifest.scripts.prepublishOnly, "node scripts/prepublish-guard.mjs");
  assert.match(manifest.scripts.build, /^node scripts\/clean-dist\.mjs && /, "a build starts from an empty dist/");
  assert.deepEqual(Object.keys(manifest.dependencies), ["terminal-kit"]);
  const compilerAliases = {
    "@typescript/native": "npm:typescript@",
    typescript: "npm:@typescript/typescript6@",
  };
  for (const [name, range] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const prefix = compilerAliases[name];
    if (prefix !== undefined) assert.ok(range.startsWith(prefix), `${name} uses the supported compiler alias`);
    assert.match(prefix === undefined ? range : range.slice(prefix.length), /^\d+\.\d+\.\d+$/, `${name} is pinned to an exact version`);
  }
  for (const name of Object.keys(compilerAliases)) assert.ok(manifest.devDependencies[name], `${name} stays development-only`);
  const tsconfig = read("tsconfig.json");
  assert.doesNotMatch(tsconfig, /"(declaration|sourceMap|declarationMap)":\s*true/, "a CLI ships no .d.ts or .map files");
});

test("the helper reports the package's version and licence", () => {
  const cargo = read("native/disktop-fs/Cargo.toml");
  assert.match(cargo, new RegExp(`^version = "${manifest.version.replaceAll(".", "\\.")}"$`, "m"));
  assert.match(cargo, /^license = "Apache-2\.0"$/m);
  const lock = read("native/disktop-fs/Cargo.lock");
  assert.match(lock, new RegExp(`name = "disktop-fs"\\nversion = "${manifest.version.replaceAll(".", "\\.")}"`));
  assert.match(read("LICENSE"), /Apache License\s+Version 2\.0, January 2004/);
});

test("the release profile keeps unwinding while the helper settles panics with catch_unwind", () => {
  const cargo = read("native/disktop-fs/Cargo.toml");
  const profile = /^\[profile\.release\]\n((?:[^[].*\n?)*)/m.exec(cargo)?.[1] ?? "";
  assert.match(profile, /^lto = "fat"$/m);
  assert.match(profile, /^codegen-units = 1$/m);
  assert.match(profile, /^strip = "symbols"$/m);
  const sources = readdirSync("native/disktop-fs/src").map((name) => read(join("native/disktop-fs/src", name))).join("\n");
  if (sources.includes("catch_unwind")) {
    assert.doesNotMatch(profile, /^panic\s*=\s*"abort"/m, "panic = abort would turn a settled worker panic into a dead helper");
  }
});

test("the publish guard refuses everywhere but the reviewed workflow run", () => {
  assert.equal(repositorySlug(manifest), "Dijo-404/disktop");
  const reviewed = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "Dijo-404/disktop",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: "Dijo-404/disktop/.github/workflows/publish.yml@refs/heads/main",
    DISKTOP_RELEASE_TAG: "v1.0.0",
  };
  assert.equal(publishRefusal(reviewed, manifest), undefined);
  assert.match(publishRefusal({}, manifest), /GITHUB_ACTIONS/);
  assert.match(publishRefusal({ ...reviewed, GITHUB_WORKFLOW_REF: "Dijo-404/disktop/.github/workflows/ci.yml@refs/heads/main" }, manifest), /GITHUB_WORKFLOW_REF/);
  assert.match(publishRefusal({ ...reviewed, GITHUB_REF: "refs/heads/feature" }, manifest), /GITHUB_REF/);
  assert.match(publishRefusal({ ...reviewed, GITHUB_REPOSITORY: "someone/disktop" }, manifest), /GITHUB_REPOSITORY/);
  assert.match(publishRefusal({ ...reviewed, DISKTOP_RELEASE_TAG: "v1.0.1" }, manifest), /DISKTOP_RELEASE_TAG/);
  assert.match(publishRefusal(reviewed, { ...manifest, private: true }), /not a public package/);
});
