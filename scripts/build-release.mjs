#!/usr/bin/env node
/**
 * Build the packaged `disktop-fs` helpers into `vendor/bin/` and record them.
 *
 *   node scripts/build-release.mjs                     all four release targets
 *   node scripts/build-release.mjs --target host       this machine's target only
 *   node scripts/build-release.mjs --target linux-x64-musl [--target ...]
 *   node scripts/build-release.mjs --clean             remove what this script wrote
 *   node scripts/build-release.mjs --print-build-checksum --target linux-x64-gnu
 *
 * Each target is built `--release --locked` with `cargo zigbuild`, which links
 * the glibc targets against the `GLIBC_FLOOR` symbol set and the musl targets
 * statically. A host-only build may fall back to plain `cargo build` when zig
 * is absent; its glibc floor is then whatever this machine has, and it says so.
 *
 * Every binary is checked against its name (ELF machine, interpreter, stripped,
 * glibc floor), copied to `vendor/bin/disktop-fs-<target>` with mode 0755, and
 * recorded in `vendor/bin/SHA256SUMS` in the format `sha256sum --check --strict`
 * reads. A binary this machine can run is then asked `hello` and must report
 * the package version and the build checksum it was given.
 *
 * Nothing here runs through a shell: every command is a fixed argument vector.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectElf, targetMismatches } from "./elf.mjs";
import { helperHello } from "./helper-hello.mjs";
import { CHECKSUM_FILE, GLIBC_FLOOR, RELEASE_TARGETS, binaryName, hostTarget, zigTarget } from "./release-targets.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CRATE = join(ROOT, "native", "disktop-fs");
const MANIFEST = join(CRATE, "Cargo.toml");
const TARGET_DIRECTORY = join(CRATE, "target");
const VENDOR = join(ROOT, "vendor", "bin");
const GENERATED = /^(?:disktop-fs-linux-(?:x64|arm64)-(?:gnu|musl)|SHA256SUMS)$/;

class Refusal extends Error {}

function parseArguments(argv) {
  const options = { targets: [], clean: false, printChecksum: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--clean") {
      options.clean = true;
    } else if (argument === "--print-build-checksum") {
      options.printChecksum = true;
    } else if (argument === "--target") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Refusal("--target needs a value: all, host, or a target name.");
      }
      options.targets.push(value);
      index += 1;
    } else {
      throw new Refusal(`Unknown argument ${JSON.stringify(argument)}.`);
    }
  }
  return options;
}

function selectTargets(names) {
  const requested = names.length === 0 ? ["all"] : names;
  const selected = new Map();
  for (const name of requested) {
    if (name === "all") {
      for (const target of RELEASE_TARGETS) selected.set(target.name, target);
    } else if (name === "host") {
      const host = hostTarget();
      if (host === undefined) {
        throw new Refusal(`This machine (${process.arch}) has no release target.`);
      }
      selected.set(host.name, host);
    } else {
      const target = RELEASE_TARGETS.find((candidate) => candidate.name === name);
      if (target === undefined) {
        throw new Refusal(`Unknown target ${JSON.stringify(name)}; expected all, host, or one of ${RELEASE_TARGETS.map((t) => t.name).join(", ")}.`);
      }
      selected.set(target.name, target);
    }
  }
  return [...selected.values()];
}

function run(command, args, { env = process.env, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env,
    shell: false,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error !== undefined) {
    return { ok: false, missing: result.error.code === "ENOENT", stdout: "", stderr: result.error.message };
  }
  return { ok: result.status === 0, missing: false, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function packageVersions() {
  const npmVersion = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;
  const manifest = await readFile(MANIFEST, "utf8");
  const cargoVersion = /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(manifest)?.[1];
  if (cargoVersion !== npmVersion) {
    throw new Refusal(`native/disktop-fs/Cargo.toml is version ${cargoVersion ?? "(none)"} but package.json is ${npmVersion}; the helper reports its own version in hello, so they must agree.`);
  }
  return npmVersion;
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".rs")) {
      files.push(path);
    }
  }
  return files;
}

/**
 * The build checksum the helper reports in `hello`: SHA-256 over what the
 * binary was built from, so a reader can recompute it from the tagged tree.
 * It is not the binary's own digest, which cannot be inside the binary;
 * `SHA256SUMS` carries that.
 */
async function buildChecksum(target, cargoTarget = zigTarget(target)) {
  const inputs = [MANIFEST, join(CRATE, "Cargo.lock"), join(ROOT, "rust-toolchain.toml"), ...(await sourceFiles(join(CRATE, "src")))];
  // The cargo target carries the glibc floor, so a host build linked without
  // zig never reports the same checksum as a release build of the same tree.
  const lines = ["disktop-fs build inputs v1", `target ${target.name} ${cargoTarget}`];
  for (const path of inputs.map((file) => relative(ROOT, file).split("\\").join("/")).sort()) {
    lines.push(`${createHash("sha256").update(await readFile(join(ROOT, path))).digest("hex")}  ${path}`);
  }
  return createHash("sha256").update(`${lines.join("\n")}\n`).digest("hex");
}

function haveZigbuild() {
  return run("cargo-zigbuild", ["--version"], { capture: true }).ok && run("zig", ["version"], { capture: true }).ok;
}

function checkRustTargets(targets) {
  const installed = run("rustup", ["target", "list", "--installed"], { capture: true });
  if (!installed.ok) {
    return; // No rustup: cargo will say for itself if a target is missing.
  }
  const have = new Set(installed.stdout.split("\n").map((line) => line.trim()));
  const missing = targets.filter((target) => !have.has(target.rustTarget)).map((target) => target.rustTarget);
  if (missing.length > 0) {
    throw new Refusal(`The pinned Rust toolchain lacks ${missing.join(", ")}. Add them with: rustup target add ${missing.join(" ")}`);
  }
}

function buildEnvironment(checksum, target) {
  const env = { ...process.env, DISKTOP_HELPER_BUILD_CHECKSUM: checksum, CARGO_TARGET_DIR: TARGET_DIRECTORY };
  // A release is defined by this script and Cargo.toml, not by whatever flags
  // the calling shell had. Paths are remapped so no build machine's home
  // directory is written into a shipped binary's panic locations.
  delete env.RUSTFLAGS;
  delete env.CARGO_BUILD_RUSTFLAGS;
  delete env.CARGO_BUILD_TARGET;
  const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
  const flags = [`--remap-path-prefix=${ROOT}=/disktop`, `--remap-path-prefix=${cargoHome}=/cargo`];
  if (target.libc === "musl") {
    // The helper calls statx(2). The libc crate declares it for musl only
    // under this cfg, because musl gained the wrapper in 1.2.5; the musl that
    // Rust 1.93 and zig link is 1.2.5, and a musl without it fails to link
    // here rather than at run time.
    flags.push("--cfg", "libc_unstable_musl_v1_2_3");
  }
  env.CARGO_ENCODED_RUSTFLAGS = flags.join("\x1f");
  return env;
}

async function removeGenerated() {
  const removed = [];
  for (const name of await readdir(VENDOR)) {
    if (GENERATED.test(name)) {
      const path = join(VENDOR, name);
      if (!(await lstat(path)).isFile()) {
        throw new Refusal(`${relative(ROOT, path)} is not a regular file; remove it by hand after checking what it is.`);
      }
      await rm(path);
      removed.push(name);
    }
  }
  return removed;
}

async function main(argv) {
  const options = parseArguments(argv);

  if (options.clean) {
    const removed = await removeGenerated();
    console.log(removed.length === 0 ? "vendor/bin holds nothing this script wrote." : `Removed ${removed.map((name) => `vendor/bin/${name}`).join(", ")}.`);
    return;
  }

  const targets = selectTargets(options.targets);
  if (options.printChecksum) {
    for (const target of targets) console.log(`${await buildChecksum(target)}  ${target.name}`);
    return;
  }

  const version = await packageVersions();
  const host = hostTarget();
  const zig = haveZigbuild();
  const hostOnly = targets.length === 1 && targets[0] === host;
  if (!zig && !hostOnly) {
    throw new Refusal(
      "cargo-zigbuild and zig are required to build any target other than this machine's own. " +
        "Install the versions pinned in .github/actions/release-toolchain/action.yml, or pass --target host for a local build.",
    );
  }
  checkRustTargets(targets);

  // Everything is built and checked before vendor/bin is touched, so a failure
  // leaves whatever was there rather than a mix of old and new.
  const built = [];
  for (const target of targets) {
    const cargoTarget = zig ? zigTarget(target) : target.rustTarget;
    const checksum = await buildChecksum(target, cargoTarget);
    const args = [zig ? "zigbuild" : "build", "--release", "--locked", "--manifest-path", MANIFEST, "--target", cargoTarget];
    console.log(`\n==> ${target.name}: cargo ${args.join(" ")}`);
    if (!zig) {
      console.log(`    zig is absent; linking with this machine's toolchain, so the glibc floor is this machine's, not ${GLIBC_FLOOR}.`);
    }
    if (!run("cargo", args, { env: buildEnvironment(checksum, target) }).ok) {
      throw new Refusal(`cargo failed to build ${target.name}.`);
    }

    const output = join(TARGET_DIRECTORY, target.rustTarget, "release", "disktop-fs");
    const bytes = await readFile(output);
    const facts = inspectElf(bytes);
    const problems = targetMismatches(facts, target, zig ? { glibcFloor: GLIBC_FLOOR } : {});
    if (problems.length > 0) {
      throw new Refusal(`${target.name} is not the binary its name promises: ${problems.join("; ")}.`);
    }

    // A binary this machine can run must answer the client's own hello with
    // the package version and the build checksum it was given.
    const runnable = host !== undefined && target.arch === host.arch && (target.libc === "musl" || host.libc === "gnu");
    let handshake = "not run here: needs a matching host";
    if (runnable) {
      const hello = await helperHello(output);
      if (hello.helperVersion !== version || hello.buildChecksum !== checksum || hello.platform !== "linux") {
        throw new Refusal(`${target.name} answered hello with version ${hello.helperVersion}, build checksum ${hello.buildChecksum}; expected ${version} and ${checksum}.`);
      }
      handshake = `hello ok (helper ${hello.helperVersion}, ${hello.architecture})`;
    }
    built.push({ target, output, facts, handshake, size: bytes.length });
  }

  await removeGenerated();
  const lines = [];
  for (const entry of built) {
    const destination = join(VENDOR, binaryName(entry.target));
    const staging = `${destination}.partial`;
    await copyFile(entry.output, staging);
    await chmod(staging, 0o755);
    await rename(staging, destination);
    const digest = createHash("sha256").update(await readFile(destination)).digest("hex");
    lines.push(`${digest}  ${binaryName(entry.target)}`);
  }
  lines.sort((left, right) => left.slice(66).localeCompare(right.slice(66)));
  await writeFile(join(VENDOR, CHECKSUM_FILE), `${lines.join("\n")}\n`, { mode: 0o644 });
  await chmod(join(VENDOR, CHECKSUM_FILE), 0o644);

  // sha256sum resolves names against its working directory, so ask it from
  // vendor/bin: the file must be one a person can check with the stock tool.
  const check = spawnSync("sha256sum", ["--check", "--strict", CHECKSUM_FILE], { cwd: VENDOR, shell: false, encoding: "utf8" });
  if (check.error !== undefined) {
    throw new Refusal(`sha256sum could not be run to check ${CHECKSUM_FILE}: ${check.error.message}`);
  }
  if (check.status !== 0) {
    throw new Refusal(`sha256sum rejects the ${CHECKSUM_FILE} just written: ${check.stdout}${check.stderr}`);
  }

  console.log("\nPackaged helpers:");
  for (const entry of built) {
    const glibc = entry.facts.glibc === null ? "static" : `GLIBC_${entry.facts.glibc}`;
    console.log(`  vendor/bin/${binaryName(entry.target)}  ${entry.size} bytes  ${glibc}  ${entry.handshake}`);
  }
  console.log(`  vendor/bin/${CHECKSUM_FILE}  ${built.length} entr${built.length === 1 ? "y" : "ies"}, accepted by sha256sum --check --strict`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof Refusal) {
    console.error(`build-release: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
