/**
 * The packed artifact, installed the way a user installs it.
 *
 * This packs the repository (or takes the exact tarball a release will publish,
 * from `DISKTOP_PACKAGE_TARBALL`), compares every file in it against an
 * explicit allowlist, installs it into a throwaway prefix with a throwaway
 * HOME, XDG directories, and npm cache, and runs the installed `disktop` and
 * `npm exec` from it. Nothing here reads the repository's own `dist/` or
 * `vendor/bin/`: what runs is what was packed.
 *
 * The helper has to be in the package for the scan and tamper checks, so
 * `vendor/bin/` must hold at least this machine's binary before packing:
 *
 *   node scripts/build-release.mjs --target host
 *
 * `DISKTOP_PACKAGE_REQUIRE_ALL_TARGETS=1` additionally requires all four, which
 * is how CI and the publish workflow run it. Installing needs the npm registry
 * for `terminal-kit`, as a user's install does.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { after, before, test } from "node:test";
import { inspectElf, targetMismatches } from "../../scripts/elf.mjs";
import { helperHello } from "../../scripts/helper-hello.mjs";
import { RELEASE_TARGETS, binaryName } from "../../scripts/release-targets.mjs";
import { compileBundle } from "../support/schemas.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const REQUIRE_ALL_TARGETS = process.env.DISKTOP_PACKAGE_REQUIRE_ALL_TARGETS === "1";
const GIVEN_TARBALL = process.env.DISKTOP_PACKAGE_TARBALL;
const MINUTES = 60_000;
/** Four static-ish binaries and the compiled CLI; a figure far past this means something leaked in. */
const UNPACKED_CEILING_BYTES = 48 * 1024 * 1024;

const state = {};

/** A fixed environment: nothing from the caller's npm, home, or XDG settings leaks in. */
function isolatedEnvironment(work) {
  const home = join(work, "home");
  const environment = {
    PATH: [join(work, "prefix", "bin"), dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
    TMPDIR: join(work, "tmp"),
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    npm_config_cache: join(work, "npm-cache"),
    npm_config_userconfig: join(work, "npmrc"),
    npm_config_globalconfig: join(work, "npmrc-global"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_loglevel: "warn",
  };
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"]) {
    if (process.env[name] !== undefined) {
      environment[name] = process.env[name];
    }
  }
  return environment;
}

function run(command, args, { cwd = state.work, timeout = 5 * MINUTES } = {}) {
  const result = spawnSync(command, args, { cwd, env: state.environment, encoding: "utf8", timeout, shell: false });
  assert.equal(result.error, undefined, `${command} ${args.join(" ")}: ${result.error?.message}`);
  return result;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A minimal ustar reader: npm pack writes regular files, with PAX headers for long names. */
function readTarball(path) {
  const bytes = gunzipSync(readFileSync(path));
  const entries = [];
  let pending = {};
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const data = bytes.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === "x" || type === "g") {
      for (const record of data.toString("utf8").split("\n").filter(Boolean)) {
        const [, key, value] = /^\d+ ([^=]+)=(.*)$/s.exec(record) ?? [];
        if (type === "x" && key === "path") pending.path = value;
      }
      continue;
    }
    const prefix = field(345, 155);
    const name = pending.path ?? (prefix === "" ? field(0, 100) : `${prefix}/${field(0, 100)}`);
    entries.push({ name, type, mode: Number.parseInt(field(100, 8).trim(), 8) & 0o7777, size, data: Buffer.from(data) });
    pending = {};
  }
  return entries;
}

function filesUnder(directory, predicate) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...filesUnder(path, predicate));
    } else if (predicate(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/** What the package must contain, derived from the sources rather than restated. */
function expectedFiles(vendorNames) {
  const expected = new Set(["package.json", "README.md", "LICENSE", "CHANGELOG.md", "schemas/cli/v1/README.md", "vendor/bin/SHA256SUMS"]);
  for (const source of filesUnder(join(ROOT, "src"), (name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))) {
    expected.add(`dist/${relative(join(ROOT, "src"), source).replace(/\.ts$/, ".js")}`);
  }
  for (const name of readdirSync(join(ROOT, "schemas", "cli", "v1")).filter((file) => file.endsWith(".json"))) {
    expected.add(`schemas/cli/v1/${name}`);
  }
  for (const name of vendorNames) {
    expected.add(`vendor/bin/${name}`);
  }
  return expected;
}

before(async () => {
  state.work = await mkdtemp(join(tmpdir(), "disktop-package-"));
  state.environment = isolatedEnvironment(state.work);
  for (const directory of ["home", "tmp", "pack", "extract", "exec", "sandbox"]) {
    await mkdir(join(state.work, directory), { recursive: true });
  }
  await writeFile(join(state.work, "npmrc"), "");
  await writeFile(join(state.work, "npmrc-global"), "");

  if (GIVEN_TARBALL !== undefined) {
    state.tarball = GIVEN_TARBALL;
  } else {
    const vendor = join(ROOT, "vendor", "bin");
    assert.ok(
      existsSync(join(vendor, "SHA256SUMS")),
      "vendor/bin has no SHA256SUMS; build the helper to pack first: node scripts/build-release.mjs --target host",
    );
    const packed = run("npm", ["pack", "--ignore-scripts", "--pack-destination", join(state.work, "pack")], { cwd: ROOT });
    assert.equal(packed.status, 0, packed.stderr);
    state.tarball = join(state.work, "pack", `${MANIFEST.name}-${MANIFEST.version}.tgz`);
  }
  assert.ok(existsSync(state.tarball), `no tarball at ${state.tarball}`);
  state.tarballDigest = sha256(readFileSync(state.tarball));
  state.entries = readTarball(state.tarball);

  const extracted = run("tar", ["-xzf", state.tarball, "-C", join(state.work, "extract")]);
  assert.equal(extracted.status, 0, extracted.stderr);
  state.extracted = join(state.work, "extract", "package");
  state.locator = await import(pathToFileURL(join(state.extracted, "dist", "native", "locator.js")).href);
  state.hostTarget = state.locator.helperTarget();
});

after(async () => {
  if (state.tarball !== undefined && state.tarballDigest !== undefined) {
    // The checks run against a copy; the artifact a release publishes is never touched.
    assert.equal(sha256(readFileSync(state.tarball)), state.tarballDigest, "the tarball changed while it was being tested");
  }
  if (state.work !== undefined && process.env.DISKTOP_PACKAGE_KEEP !== "1") {
    await rm(state.work, { recursive: true, force: true });
  }
});

test("the tarball holds exactly the files a user needs, and nothing else", (context) => {
  const files = new Map();
  for (const entry of state.entries) {
    assert.ok(entry.name.startsWith("package/"), `entry outside package/: ${entry.name}`);
    assert.ok(["0", "5"].includes(entry.type), `${entry.name} is tar type ${entry.type}, not a regular file or directory`);
    if (entry.type === "0") {
      files.set(entry.name.slice("package/".length), entry);
    }
  }

  const sums = files.get("vendor/bin/SHA256SUMS");
  assert.ok(sums, "the package has no vendor/bin/SHA256SUMS");
  const recorded = state.locator.parseChecksums(sums.data.toString("utf8"));
  assert.ok(recorded, "the packaged SHA256SUMS is not one the packaged locator accepts");
  const vendorNames = [...recorded.keys()];
  if (REQUIRE_ALL_TARGETS) {
    assert.deepEqual(vendorNames.sort(), RELEASE_TARGETS.map(binaryName).sort(), "a release packages all four helpers");
  }
  assert.ok(
    state.hostTarget !== undefined && recorded.has(state.locator.helperBinaryName(state.hostTarget)),
    `the package has no helper for this machine (${state.hostTarget}); build it with: node scripts/build-release.mjs --target host`,
  );

  // The allowlist below already refuses these; naming them gives the clearer failure.
  const forbidden = [
    /^(src|tests|native|docs|scripts|\.github|\.claude|coverage)\//,
    /(^|\/)(\.env[^/]*|\.npmrc|\.git|node_modules|target|fixtures)(\/|$)/,
    /\.(map|ts|tsbuildinfo|tgz|sqlite|db|log)$/,
  ];
  for (const name of files.keys()) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(name, pattern, `${name} must never ship`);
    }
  }

  const expected = expectedFiles(vendorNames);
  const unexpected = [...files.keys()].filter((name) => !expected.has(name)).sort();
  const missing = [...expected].filter((name) => !files.has(name)).sort();
  assert.deepEqual(unexpected, [], "files in the package that the allowlist does not name; review before adding them");
  assert.deepEqual(missing, [], "files the package must carry");

  for (const [name, entry] of files) {
    const executable = name === "dist/bin/disktop.js" || (name.startsWith("vendor/bin/disktop-fs-") && recorded.has(name.slice("vendor/bin/".length)));
    assert.equal(entry.mode, executable ? 0o755 : 0o644, `${name} has mode ${entry.mode.toString(8)}`);
  }

  const unpacked = [...files.values()].reduce((total, entry) => total + entry.size, 0);
  assert.ok(unpacked < UNPACKED_CEILING_BYTES, `the package unpacks to ${unpacked} bytes`);
  context.diagnostic(`${state.tarball}: ${readFileSync(state.tarball).length} bytes packed, ${unpacked} unpacked, ${files.size} files, sha256 ${state.tarballDigest}`);
  for (const name of [...files.keys()].filter((file) => !file.startsWith("dist/")).sort()) {
    context.diagnostic(`  ${files.get(name).mode.toString(8)} ${String(files.get(name).size).padStart(9)} ${name}`);
  }
  context.diagnostic(`  dist/: ${[...files.keys()].filter((file) => file.startsWith("dist/")).length} compiled .js files, one per src/**/*.ts`);
});

test("the packaged manifest is the public 1.0.0 CLI with no install-time code", () => {
  const manifest = JSON.parse(readFileSync(join(state.extracted, "package.json"), "utf8"));
  assert.equal(manifest.name, "disktop");
  assert.equal(manifest.version, MANIFEST.version);
  assert.equal(manifest.private, false);
  assert.deepEqual(manifest.bin, { disktop: "./dist/bin/disktop.js" });
  assert.deepEqual(manifest.os, ["linux"]);
  assert.equal(manifest.cpu, undefined, "another architecture installs and keeps inventory");
  assert.equal(manifest.main, undefined);
  assert.equal(manifest.types, undefined);
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    assert.equal(manifest.scripts?.[hook], undefined, `${hook} would run code at install time`);
  }
  assert.deepEqual(Object.keys(manifest.dependencies), ["terminal-kit"]);
});

test("every packaged helper matches SHA256SUMS and is the binary its name says", (context) => {
  const sums = readFileSync(join(state.extracted, "vendor", "bin", "SHA256SUMS"), "utf8");
  const recorded = state.locator.parseChecksums(sums);
  for (const [name, digest] of recorded) {
    const bytes = readFileSync(join(state.extracted, "vendor", "bin", name));
    assert.equal(sha256(bytes), digest, `${name} does not match SHA256SUMS`);
    const target = RELEASE_TARGETS.find((candidate) => binaryName(candidate) === name);
    const facts = inspectElf(bytes);
    assert.deepEqual(targetMismatches(facts, target), [], name);
    context.diagnostic(`${name}: ${bytes.length} bytes, ${facts.glibc === null ? "static" : `GLIBC_${facts.glibc}`}`);
  }

  // The stock tool reads the same file. GNU coreutils checks strictly; BusyBox has no --strict.
  const gnu = spawnSync("sha256sum", ["--version"], { encoding: "utf8" }).status === 0;
  const checked = run("sha256sum", gnu ? ["--check", "--strict", "SHA256SUMS"] : ["-c", "SHA256SUMS"], { cwd: join(state.extracted, "vendor", "bin") });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});

test("the tarball installs globally into a clean prefix with no install scripts", () => {
  const installed = run("npm", ["install", "--global", "--prefix", join(state.work, "prefix"), "--ignore-scripts", state.tarball]);
  assert.equal(installed.status, 0, installed.stderr);
  state.packageRoot = join(state.work, "prefix", "lib", "node_modules", "disktop");
  state.bin = join(state.work, "prefix", "bin", "disktop");
  assert.ok(existsSync(state.bin), "npm did not link the disktop executable");
  state.validators = compileBundle(join(state.packageRoot, "schemas", "cli", "v1"));
});

function disktop(args, options) {
  return run(state.bin, args, { cwd: join(state.work, "home"), ...options });
}

function envelope(result, schema) {
  assert.notEqual(result.stdout.trim(), "", `no stdout; stderr: ${result.stderr}`);
  const document = JSON.parse(result.stdout);
  const validate = state.validators.get(schema);
  assert.ok(validate(document), `${schema}: ${JSON.stringify(validate.errors)}`);
  assert.equal(document.exitCode, result.status);
  return document;
}

test("the installed disktop answers --help, --version, --json, and devices --json", () => {
  const help = disktop(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /disktop/);
  assert.match(help.stdout, /scan/);

  const version = disktop(["--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), MANIFEST.version);
  assert.equal(version.stdout.trim(), "1.0.0");

  const dashboard = envelope(disktop(["--json"]), "dashboard");
  assert.ok([0, 3].includes(dashboard.exitCode), `dashboard exited ${dashboard.exitCode}`);
  const devices = envelope(disktop(["devices", "--json"]), "devices");
  assert.ok([0, 3].includes(devices.exitCode), `devices exited ${devices.exitCode}`);
});

test("the installed CLI finds its packaged helper, verifies it, and scans with it", async (context) => {
  const locator = await import(pathToFileURL(join(state.packageRoot, "dist", "native", "locator.js")).href);
  const lookup = await locator.locateHelper(locator.helperTarget());
  assert.equal(lookup.found, true, JSON.stringify(lookup.capability));
  assert.equal(lookup.location.integrity, "checksum-verified");
  assert.equal(lookup.location.executablePath, join(state.packageRoot, "vendor", "bin", locator.helperBinaryName(state.hostTarget)));

  const hello = await helperHello(lookup.location.executablePath);
  assert.equal(hello.helperVersion, MANIFEST.version, "the helper reports the package version");
  assert.match(hello.buildChecksum ?? "", /^[0-9a-f]{64}$/, "a release helper reports the build checksum it was given");
  context.diagnostic(`${state.hostTarget}: helper ${hello.helperVersion}, build ${hello.buildChecksum}, openat2 ${JSON.stringify(hello.kernelCapabilities.openat2)}`);

  const sandbox = join(state.work, "sandbox");
  await mkdir(join(sandbox, "nested"), { recursive: true });
  await writeFile(join(sandbox, "a.txt"), "a".repeat(4096));
  await writeFile(join(sandbox, "nested", "b.bin"), Buffer.alloc(65536, 1));
  const scan = envelope(disktop(["scan", sandbox, "--json"]), "scan");
  assert.equal(scan.status, "complete", JSON.stringify(scan.warnings ?? scan.error));
  assert.equal(scan.data.capability.status, "available");
  assert.ok(BigInt(scan.data.totals.apparentBytes) >= 69632n, JSON.stringify(scan.data.totals));
});

test("the package exposes package.json and the CLI schemas, and no library surface", () => {
  const require = createRequire(join(state.work, "prefix", "lib", "node_modules", "probe.cjs"));
  assert.equal(require.resolve("disktop/package.json"), join(state.packageRoot, "package.json"));
  assert.equal(require.resolve("disktop/schemas/cli/v1/envelope.json"), join(state.packageRoot, "schemas", "cli", "v1", "envelope.json"));
  for (const specifier of ["disktop", "disktop/dist/native/locator.js", "disktop/vendor/bin/SHA256SUMS"]) {
    assert.throws(() => require.resolve(specifier), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }, specifier);
  }
});

test("npm exec runs the same tarball, helper included", () => {
  // `npx disktop` is the advertised way in; it installs into npm's own cache.
  const exec = (args) => run("npm", ["exec", "--yes", "--package", state.tarball, "--", "disktop", ...args], { cwd: join(state.work, "exec") });
  const version = exec(["--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), MANIFEST.version);
  const scan = envelope(exec(["scan", join(state.work, "sandbox"), "--json"]), "scan");
  assert.equal(scan.status, "complete", JSON.stringify(scan.error ?? scan.warnings));
});

test("a helper altered after packing is refused with an explicit capability, and so is an altered SHA256SUMS", async () => {
  const vendor = join(state.packageRoot, "vendor", "bin");
  const binary = join(vendor, `disktop-fs-${state.hostTarget}`);
  const sumsPath = join(vendor, "SHA256SUMS");
  const original = await readFile(binary);
  const originalSums = await readFile(sumsPath, "utf8");
  const sandbox = join(state.work, "sandbox");

  const refused = (pattern) => {
    const result = envelope(disktop(["scan", sandbox, "--json"]), "scan");
    assert.equal(result.status, "error");
    assert.equal(result.exitCode, 2);
    assert.equal(result.error.code, "unsupported");
    assert.equal(result.error.details.capability, "unsupported-architecture");
    assert.match(result.error.message, pattern);
  };

  try {
    // One byte appended: still an executable that would run, refused on its checksum.
    await appendFile(binary, Buffer.from([0]));
    await chmod(binary, 0o755);
    refused(/does not match its recorded checksum in SHA256SUMS/);

    // The binary restored, its recorded digest changed instead.
    await writeFile(binary, original);
    await chmod(binary, 0o755);
    const digest = sha256(original);
    const altered = digest.replace(/^./, (first) => (first === "0" ? "1" : "0"));
    await writeFile(sumsPath, originalSums.replace(digest, altered));
    refused(/does not match its recorded checksum/);

    // A list the strict reader cannot read is no evidence for any binary.
    await writeFile(sumsPath, originalSums.replaceAll("\n", "\r\n"));
    refused(/not a well-formed checksum list/);
  } finally {
    await writeFile(binary, original);
    await chmod(binary, 0o755);
    await writeFile(sumsPath, originalSums);
  }

  const restored = envelope(disktop(["scan", sandbox, "--json"]), "scan");
  assert.equal(restored.status, "complete");
});
