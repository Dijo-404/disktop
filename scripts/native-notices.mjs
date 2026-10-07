#!/usr/bin/env node
/** Reproduce the notices for the locked helper without compiling any code. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_TARGETS } from "./release-targets.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT = "THIRD_PARTY_NOTICES";
const INPUTS = [
  "native/disktop-fs/Cargo.toml",
  "native/disktop-fs/Cargo.lock",
  "rust-toolchain.toml",
  ".github/actions/release-toolchain/action.yml",
  "scripts/native-notices.mjs",
  "scripts/licenses/runtime.json",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

async function runtimeAssets(root) {
  const manifest = JSON.parse(await readFile(join(root, "scripts/licenses/runtime.json"), "utf8"));
  const rust = await readFile(join(root, "rust-toolchain.toml"), "utf8");
  const release = await readFile(join(root, ".github/actions/release-toolchain/action.yml"), "utf8");
  if (!rust.includes(`channel = "${manifest.rustVersion}"`) || !release.includes(`ZIG_VERSION: ${manifest.zigVersion}`)) {
    throw new Error("Runtime licence assets do not match the pinned Rust and Zig versions; review and refresh scripts/licenses/runtime.json.");
  }
  for (const asset of manifest.assets) {
    if (!/^scripts\/licenses\/runtime\/[\w.-]+$/.test(asset.file) || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
      throw new Error("Invalid runtime licence asset path or checksum.");
    }
    const bytes = await readFile(join(root, asset.file));
    if (sha256(bytes) !== asset.sha256) throw new Error(`Runtime licence asset changed: ${asset.file}; review its attribution and checksum.`);
  }
  return manifest.assets;
}

async function sourceInputs(root) {
  const assets = await runtimeAssets(root);
  const paths = [...INPUTS, ...assets.map((asset) => asset.file)].sort(compare);
  return (await Promise.all(paths.map(async (path) => `${sha256(await readFile(join(root, path)))}  ${path}`))).join("\n");
}

/** A network/toolchain-free gate for unit tests and npm pack. */
export async function checkNoticeInputs(root = ROOT) {
  const actual = await readFile(join(root, OUTPUT), "utf8");
  const recorded = /\nSource inputs \(SHA-256\):\n([\s\S]*?)\nEnd source inputs\.\n/.exec(actual)?.[1];
  if (recorded !== await sourceInputs(root)) {
    throw new Error("THIRD_PARTY_NOTICES is stale; run node scripts/native-notices.mjs after reviewing the locked dependencies and runtime licences.");
  }
  const body = /\nNotice body SHA-256: ([a-f0-9]{64})\n([\s\S]*)$/.exec(actual);
  if (body === null || sha256(body[2]) !== body[1]) throw new Error("THIRD_PARTY_NOTICES is incomplete or changed; regenerate and review the full notices.");
}

function cargoMetadata(root, target) {
  const result = spawnSync("cargo", ["metadata", "--locked", "--format-version", "1", "--manifest-path", join(root, "native/disktop-fs/Cargo.toml"), "--filter-platform", target], {
    cwd: root,
    shell: false,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Cannot read locked native dependencies for ${target}: ${result.error?.message ?? result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

/** Include normal dependencies and proc macros conservatively for generated code. */
export function runtimePackages(metadata) {
  const packages = new Map(metadata.packages.map((entry) => [entry.id, entry]));
  const nodes = new Map(metadata.resolve.nodes.map((entry) => [entry.id, entry]));
  const pending = [metadata.resolve.root];
  const reached = new Set();
  while (pending.length > 0) {
    const id = pending.pop();
    if (reached.has(id)) continue;
    reached.add(id);
    const node = nodes.get(id);
    if (node === undefined || !packages.has(id)) throw new Error("Incomplete Cargo dependency graph.");
    for (const dependency of node.deps) {
      if (dependency.dep_kinds.some((kind) => kind.kind === null)) pending.push(dependency.pkg);
    }
  }
  return [...reached].filter((id) => id !== metadata.resolve.root).map((id) => packages.get(id));
}

async function noticeFiles(entry) {
  const root = dirname(entry.manifest_path);
  const names = (await readdir(root, { withFileTypes: true })).filter((file) => file.isFile()).map((file) => file.name).sort(compare);
  let selected;
  if (/(?:^|[ (])MIT(?:$|[ )/])/.test(entry.license ?? "")) {
    // Select MIT when upstream offers a choice. An AND obligation is additional.
    if (entry.license.includes(" AND ") && entry.license !== "(MIT OR Apache-2.0) AND Unicode-3.0") {
      throw new Error(`Review additional licence obligations for ${entry.name}: ${entry.license}.`);
    }
    selected = names.filter((name) => /^LICENSE[-.]MIT$/i.test(name));
    if (selected.length === 0 && entry.license === "MIT" && names.includes("LICENSE")) selected = ["LICENSE"];
    if (entry.license.includes("Unicode-3.0")) selected.push(...names.filter((name) => /^LICENSE[-.]UNICODE$/i.test(name)));
  } else if (["BSD-3-Clause", "Zlib"].includes(entry.license)) {
    selected = names.filter((name) => name === "LICENSE");
  } else {
    throw new Error(`Review the licence choice for ${entry.name}: ${entry.license ?? "no licence declared"}.`);
  }
  if (selected.length === 0 || (entry.license.includes("Unicode-3.0") && !selected.some((name) => /UNICODE/i.test(name)))) {
    throw new Error(`Missing full licence text for ${entry.name} ${entry.version}.`);
  }
  selected.push(...names.filter((name) => /^(?:COPYRIGHT|NOTICE)(?:[.-].*)?$/i.test(name)));
  return Promise.all([...new Set(selected)].sort(compare).map(async (name) => ({ name, text: await readFile(join(root, name), "utf8") })));
}

async function filesBelow(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile() && /\.[chS]$/.test(entry.name)) files.push(path);
  }
  return files.sort(compare);
}

async function embeddedNotices(packages) {
  const sqlite = packages.find((entry) => entry.name === "libsqlite3-sys");
  const zstd = packages.find((entry) => entry.name === "zstd-sys");
  if (sqlite === undefined || zstd === undefined) throw new Error("Review native embedded library licences after dependency changes.");
  const sqliteSource = await readFile(join(dirname(sqlite.manifest_path), "sqlite3/sqlite3.c"), "utf8");
  const sqliteVersion = /^#define SQLITE_VERSION\s+"([^"]+)"/m.exec(sqliteSource)?.[1];
  const dedication = /\/\*\n\*\* 2001 September 15\n[\s\S]*?\*\//.exec(sqliteSource)?.[0];
  if (sqliteVersion === undefined || dedication === undefined || !dedication.includes("disclaims copyright")) throw new Error("Cannot locate SQLite's public-domain dedication.");
  const output = [`\n=== Embedded SQLite ${sqliteVersion} (public domain) ===\nSource: libsqlite3-sys ${sqlite.version}/sqlite3/sqlite3.c\n\n${dedication}\n`];
  const zstdRoot = join(dirname(zstd.manifest_path), "zstd");
  output.push(`\n=== Embedded Zstandard C library (BSD licence choice) ===\nSource: zstd-sys ${zstd.version}/zstd/LICENSE\n\n${await readFile(join(zstdRoot, "LICENSE"), "utf8")}\n`);
  // Preserve the separate historical BSD-2-Clause and contributor notices in
  // legacy codecs/xxHash, too. Only comments are copied, never implementations.
  const comments = new Map();
  for (const path of await filesBelow(join(zstdRoot, "lib"))) {
    const text = await readFile(path, "utf8");
    for (const [comment] of text.matchAll(/\/\*[\s\S]*?\*\//g)) {
      if (!/copyright|redistribution|public domain/i.test(comment)) continue;
      const name = relative(zstdRoot, path).split("\\").join("/");
      const sources = comments.get(comment) ?? [];
      if (!sources.includes(name)) sources.push(name);
      comments.set(comment, sources);
    }
  }
  for (const [comment, sources] of comments) {
    output.push(`\nEmbedded Zstandard attribution: ${sources.join(", ")}\n\n${comment}\n`);
  }
  return output.join("");
}

export async function generateNotices(root = ROOT) {
  const byId = new Map();
  for (const target of RELEASE_TARGETS) {
    for (const entry of runtimePackages(cargoMetadata(root, target.rustTarget))) byId.set(entry.id, entry);
  }
  const packages = [...byId.values()].sort((left, right) => compare(`${left.name}@${left.version}`, `${right.name}@${right.version}`));
  const sections = [
    "\nThese notices cover the four bundled Linux helper targets, their normal Rust\ndependencies (including proc macros conservatively for generated code), embedded\nC libraries, and the pinned Rust/musl runtimes. Build tools are not distributed.\nFor crates offering alternative licences, the full MIT text below is the selected\noption; additional Unicode terms and all upstream copyright notices are retained.\nZstandard uses its BSD option. Runtime notices retain the upstream alternatives.\nNode and npm dependencies are installed separately with their own notices.\n",
  ];
  for (const entry of packages) {
    if (!entry.source?.startsWith("registry+")) throw new Error(`Review non-registry native dependency ${entry.name}.`);
    sections.push(`\n=== Rust crate ${entry.name} ${entry.version} ===\nUpstream licence: ${entry.license}\nSource: https://crates.io/crates/${entry.name}/${entry.version}\n`);
    for (const file of await noticeFiles(entry)) sections.push(`\nUpstream ${file.name}:\n\n${file.text}\n`);
  }
  sections.push(await embeddedNotices(packages));
  for (const asset of await runtimeAssets(root)) {
    sections.push(`\n=== ${asset.name} ${asset.version} ===\nSource: ${asset.source}\nSHA-256: ${asset.sha256}\n\n${await readFile(join(root, asset.file), "utf8")}\n`);
  }
  const body = sections.join("");
  return `Disktop bundled native third-party notices\nGenerated by scripts/native-notices.mjs. Do not edit this file by hand.\n\nSource inputs (SHA-256):\n${await sourceInputs(root)}\nEnd source inputs.\n\nNotice body SHA-256: ${sha256(body)}\n${body}`;
}

/** Deep release gate: recompute from Cargo's locked graph and upstream files. */
export async function checkNativeNotices(root = ROOT) {
  const expected = await generateNotices(root);
  if (await readFile(join(root, OUTPUT), "utf8") !== expected) {
    throw new Error("THIRD_PARTY_NOTICES does not match the locked native sources; run node scripts/native-notices.mjs and review the changes.");
  }
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === "--check-inputs") return checkNoticeInputs();
  if (argv.length === 1 && argv[0] === "--check") return checkNativeNotices();
  if (argv.length !== 0) throw new Error("Usage: node scripts/native-notices.mjs [--check | --check-inputs]");
  await writeFile(join(ROOT, OUTPUT), await generateNotices(ROOT));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
