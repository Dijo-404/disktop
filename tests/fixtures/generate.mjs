/**
 * Builds throwaway trees that reproduce the filesystem shapes Disktop must
 * survive: sparse files, hardlinks, symlink loops, unreadable directories, and
 * names that are not valid UTF-8. Every fixture lives under a `mkdtemp`
 * directory in the system temporary directory, and `cleanup` refuses to remove
 * anything else, so no test can point this at real data.
 */
import { chmod, link, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PREFIX = "disktop-fixture-";
const SPARSE_BYTES = 1024 * 1024;

const removed = new WeakSet();

/**
 * A sandbox is a direct child of the system temporary directory whose name
 * starts with the fixture prefix. The path is resolved first, so a root
 * carrying `..` cannot borrow a valid prefix to reach real data.
 */
function assertSandbox(root) {
  const resolved = resolve(root);
  if (dirname(resolved) !== resolve(tmpdir()) || !basenameOf(resolved).startsWith(PREFIX)) {
    throw new Error(`${root} is not a Disktop fixture sandbox`);
  }
  return resolved;
}

function basenameOf(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

function sandboxCleanup(fixture) {
  return async () => {
    if (removed.has(fixture)) {
      throw new Error(`Fixture ${fixture.root} was already removed`);
    }
    const resolved = assertSandbox(fixture.root);
    removed.add(fixture);
    await rm(resolved, { recursive: true, force: true });
  };
}

async function sandbox() {
  return mkdtemp(join(tmpdir(), PREFIX));
}

/** A path whose final component is raw bytes, so invalid UTF-8 survives. */
function bytePath(root, nameBytes) {
  return Buffer.concat([Buffer.from(`${root}/`), Buffer.from(nameBytes)]);
}

export async function createStandardFixture() {
  const root = await sandbox();
  try {
    return await buildStandardFixture(root);
  } catch (error) {
    await restoreAndRemove(root);
    throw error;
  }
}

/** Make the tree removable again before deleting it: 0o000 defeats rm -rf. */
export async function restoreAndRemove(root) {
  await chmod(join(assertSandbox(root), "unreadable-directory"), 0o700).catch(() => undefined);
  await rm(assertSandbox(root), { recursive: true, force: true });
}

async function buildStandardFixture(root) {
  const manifest = [];
  const record = (name, path, extra = {}) => {
    manifest.push({ name, path, ...extra });
    return path;
  };

  const plain = join(root, "plain.txt");
  await writeFile(plain, "x".repeat(1024));
  record("plain-file", plain, { apparentBytes: 1024 });

  const sparse = join(root, "sparse.bin");
  const handle = await open(sparse, "w");
  await handle.truncate(SPARSE_BYTES);
  await handle.close();
  record("sparse-file", sparse, { apparentBytes: SPARSE_BYTES });

  const original = join(root, "hardlink-original.bin");
  await writeFile(original, "shared bytes");
  const copy = join(root, "hardlink-copy.bin");
  await link(original, copy);
  record("hardlink-original", original, { linkCount: 2 });
  record("hardlink-copy", copy, { linkCount: 2 });

  await symlink(plain, join(root, "symlink-to-file"));
  record("symlink-to-file", join(root, "symlink-to-file"));
  await symlink(join(root, "does-not-exist"), join(root, "broken-symlink"));
  record("broken-symlink", join(root, "broken-symlink"));
  await symlink(join(root, "symlink-loop"), join(root, "symlink-loop"));
  record("symlink-loop", join(root, "symlink-loop"));

  await mkdir(join(root, "empty-directory"));
  record("empty-directory", join(root, "empty-directory"));

  const oddNames = [
    ["invalid-utf8-name", Buffer.from([0x62, 0x61, 0x64, 0x2d, 0xff, 0xfe, 0x2e, 0x62, 0x69, 0x6e])],
    ["newline-name", Buffer.from("first\nsecond.txt")],
    ["control-character-name", Buffer.from("escape\u001b[2Kname.txt")],
    ["emoji-name", Buffer.from("report \u{1F4C4}.txt")],
    ["long-name", Buffer.from("l".repeat(255))],
  ];
  for (const [name, nameBytes] of oddNames) {
    const path = bytePath(root, nameBytes);
    await writeFile(path, name);
    record(name, path);
  }

  let deep = root;
  for (let depth = 0; depth < 12; depth += 1) {
    deep = join(deep, `level-${depth}`);
    await mkdir(deep);
  }
  const leaf = join(deep, "leaf.txt");
  await writeFile(leaf, "bottom");
  record("deep-leaf", leaf, { depth: 12 });

  const unreadable = join(root, "unreadable-directory");
  await mkdir(unreadable);
  await writeFile(join(unreadable, "hidden.txt"), "unreachable");
  await chmod(unreadable, 0o000);
  record("unreadable-directory", unreadable, { enforced: process.getuid?.() !== 0 });

  const changing = join(root, "changing.txt");
  await writeFile(changing, "before");
  record("changing-file", changing);

  const fixture = { root, manifest };
  const remove = sandboxCleanup(fixture);
  fixture.cleanup = async () => {
    await chmod(join(assertSandbox(fixture.root), "unreadable-directory"), 0o700).catch(() => undefined);
    await remove();
  };
  return fixture;
}

/**
 * A wide, shallow tree for the memory and scan-time budget.
 *
 * `bytesPerFile` gives the files real content, which is what makes an
 * allocated-bytes comparison against `du -x` mean anything: empty files
 * occupy no blocks, so a tree of them totals zero on every filesystem.
 */
export async function createLargeFixture({ entries, fanOut = 256, bytesPerFile = 0 }) {
  if (!Number.isInteger(entries) || entries < 1) {
    throw new RangeError("entries must be a positive integer");
  }
  const root = await sandbox();
  let created = 0;
  for (let bucket = 0; created < entries; bucket += 1) {
    const directory = join(root, `bucket-${bucket}`);
    await mkdir(directory);
    const batch = Math.min(fanOut, entries - created);
    for (let index = 0; index < batch; index += 1) {
      await writeFile(join(directory, `file-${index}.bin`), bytesPerFile === 0 ? "" : "d".repeat(bytesPerFile));
      created += 1;
    }
  }
  const fixture = { root, entryCount: created, bytesPerFile };
  fixture.cleanup = sandboxCleanup(fixture);
  return fixture;
}

/**
 * A home directory holding the development environments and build output the
 * Phase 3 detectors look for.
 *
 * Every tree here is the smallest thing that makes a detector's evidence real:
 * a conda prefix is a `conda-meta` directory, a virtualenv is a `pyvenv.cfg`,
 * a rustup install is a `settings.toml` naming its default toolchain. A
 * detector that matched on the directory name alone would report every
 * directory called `envs` on the machine.
 */
export async function createDeveloperFixture() {
  const root = await sandbox();
  const home = join(root, "home");
  await mkdir(home);

  const conda = join(home, "miniconda3");
  await mkdir(join(conda, "conda-meta"), { recursive: true });
  await writeFile(join(conda, "conda-meta", "history"), "==> 2026-01-01 <==\n");
  await mkdir(join(conda, "pkgs"), { recursive: true });
  await writeFile(join(conda, "pkgs", "python-3.13.tar.bz2"), "p".repeat(2048));
  for (const name of ["base", "research"]) {
    await mkdir(join(conda, "envs", name, "conda-meta"), { recursive: true });
  }
  // A directory under envs that is not an environment, to prove the detector
  // reads conda-meta rather than listing names.
  await mkdir(join(conda, "envs", "notes"), { recursive: true });

  const venv = join(home, ".virtualenvs", "api");
  await mkdir(venv, { recursive: true });
  await writeFile(join(venv, "pyvenv.cfg"), "home = /usr/bin\nversion = 3.13.1\n");
  await mkdir(join(home, ".virtualenvs", "empty"), { recursive: true });

  const pyenv = join(home, ".pyenv");
  await mkdir(join(pyenv, "versions", "3.12.8"), { recursive: true });
  await mkdir(join(pyenv, "versions", "3.13.1"), { recursive: true });
  await writeFile(join(pyenv, "version"), "3.13.1\n");

  const nvm = join(home, ".nvm", "versions", "node");
  await mkdir(join(nvm, "v22.9.0"), { recursive: true });
  await mkdir(join(nvm, "v24.8.0"), { recursive: true });
  await mkdir(join(home, ".nvm", "alias"), { recursive: true });
  await writeFile(join(home, ".nvm", "alias", "default"), "v24.8.0\n");

  const fnm = join(home, ".local", "share", "fnm", "node-versions", "v20.11.0", "installation");
  await mkdir(fnm, { recursive: true });

  const rustup = join(home, ".rustup");
  await mkdir(join(rustup, "toolchains", "stable-x86_64-unknown-linux-gnu"), { recursive: true });
  await mkdir(join(rustup, "toolchains", "nightly-x86_64-unknown-linux-gnu"), { recursive: true });
  await mkdir(join(rustup, "downloads"), { recursive: true });
  await writeFile(
    join(rustup, "settings.toml"),
    'default_toolchain = "stable-x86_64-unknown-linux-gnu"\nversion = "12"\n',
  );

  const project = join(home, "projects", "api");
  await mkdir(join(project, "node_modules", "left-pad"), { recursive: true });
  await writeFile(join(project, "package.json"), '{"name":"api"}\n');
  await mkdir(join(project, "target", "debug"), { recursive: true });
  await writeFile(join(project, "Cargo.toml"), '[package]\nname = "api"\n');
  await mkdir(join(project, "__pycache__"), { recursive: true });

  // A `target` with no Cargo.toml beside it: a directory with that name is not
  // proof of a Rust build.
  const ambiguous = join(home, "projects", "docs", "target");
  await mkdir(ambiguous, { recursive: true });

  const fixture = {
    root,
    home,
    paths: {
      conda,
      condaPkgs: join(conda, "pkgs"),
      condaEnvs: [join(conda, "envs", "base"), join(conda, "envs", "research")],
      venv,
      pyenvVersions: [join(pyenv, "versions", "3.12.8"), join(pyenv, "versions", "3.13.1")],
      nvmVersions: [join(nvm, "v22.9.0"), join(nvm, "v24.8.0")],
      fnmVersion: join(home, ".local", "share", "fnm", "node-versions", "v20.11.0"),
      rustupToolchains: [
        join(rustup, "toolchains", "nightly-x86_64-unknown-linux-gnu"),
        join(rustup, "toolchains", "stable-x86_64-unknown-linux-gnu"),
      ],
      rustupDownloads: join(rustup, "downloads"),
      nodeModules: join(project, "node_modules"),
      cargoTarget: join(project, "target"),
      pycache: join(project, "__pycache__"),
      ambiguousTarget: ambiguous,
    },
  };
  fixture.cleanup = sandboxCleanup(fixture);
  return fixture;
}

/** One file of known size, creating the directories above it. */
async function sizedFile(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "c".repeat(bytes));
}

/**
 * A home directory holding the cache and model roots the Phase 3 detectors
 * look for. Each root holds one file, so a detector that reports it has
 * reported something real.
 */
export async function createCacheFixture() {
  const root = await sandbox();
  const home = join(root, "home");

  const roots = {
    npm: join(home, ".npm", "_cacache"),
    yarn: join(home, ".cache", "yarn"),
    pip: join(home, ".cache", "pip"),
    cargoRegistry: join(home, ".cargo", "registry"),
    goBuild: join(home, ".cache", "go-build"),
    gradle: join(home, ".gradle", "caches"),
    huggingface: join(home, ".cache", "huggingface"),
    ollama: join(home, ".ollama", "models"),
    jetbrainsCache: join(home, ".cache", "JetBrains"),
    vscodeCache: join(home, ".config", "Code", "Cache"),
    vscodeExtensions: join(home, ".vscode", "extensions"),
    androidSdk: join(home, "Android", "Sdk"),
    androidAvd: join(home, ".android", "avd"),
  };
  for (const path of Object.values(roots)) {
    await sizedFile(join(path, "stored.bin"), 1024);
  }

  // A Chrome profile beside its cache, and two Electron applications.
  const chromeProfile = join(home, ".config", "google-chrome", "Default");
  await sizedFile(join(chromeProfile, "History"), 2048);
  await sizedFile(join(chromeProfile, "Cache", "data_0"), 4096);
  const chromeCache = join(home, ".cache", "google-chrome", "Default", "Cache");
  await sizedFile(join(chromeCache, "data_0"), 4096);

  const firefoxProfile = join(home, ".mozilla", "firefox", "abc123.default-release");
  await sizedFile(join(firefoxProfile, "places.sqlite"), 2048);
  const firefoxCache = join(home, ".cache", "mozilla", "firefox", "abc123.default-release");
  await sizedFile(join(firefoxCache, "cache2", "entries"), 4096);
  await sizedFile(join(firefoxCache, "startupCache", "scriptCache.bin"), 1024);

  const slack = join(home, ".config", "Slack");
  await sizedFile(join(slack, "Cache", "data_0"), 4096);
  await sizedFile(join(slack, "GPUCache", "data_0"), 1024);
  const quiet = join(home, ".config", "quiet-app");
  await sizedFile(join(quiet, "settings.json"), 64);

  // An application directory whose name is not valid UTF-8.
  const oddApp = bytePath(join(home, ".config"), Buffer.from([0x61, 0x70, 0x70, 0xff]));
  await mkdir(oddApp, { recursive: true });
  await mkdir(Buffer.concat([oddApp, Buffer.from("/Cache")]), { recursive: true });
  await writeFile(Buffer.concat([oddApp, Buffer.from("/Cache/data_0")]), "o".repeat(2048));

  const fixture = {
    root,
    home,
    roots,
    browsers: { chromeProfile, chromeCache, firefoxProfile, firefoxCache },
    electron: { slack, quiet, oddApp: oddApp.toString("latin1") },
  };
  fixture.cleanup = sandboxCleanup(fixture);
  return fixture;
}
