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

function sandboxCleanup(fixture, restoreUnreadable = false) {
  const originalRoot = fixture.root;
  return async () => {
    if (removed.has(fixture)) {
      throw new Error(`Fixture ${fixture.root} was already removed`);
    }
    if (fixture.root !== originalRoot) {
      throw new Error(`${fixture.root} is not a Disktop fixture sandbox created by this fixture`);
    }
    const resolved = assertSandbox(originalRoot);
    if (restoreUnreadable) {
      await chmod(join(resolved, "unreadable-directory"), 0o700).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await rm(resolved, { recursive: true, force: true });
    removed.add(fixture);
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
  try {
    await handle.truncate(SPARSE_BYTES);
  } finally {
    await handle.close();
  }
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
  fixture.cleanup = sandboxCleanup(fixture, true);
  return fixture;
}

/**
 * Names chosen to break an export: a spreadsheet formula, a script tag,
 * quotes and commas, line breaks, terminal escapes, a direction override,
 * bytes that are not UTF-8, an emoji, and the longest name Linux allows.
 * Each is a file of a different size at the top of the tree, beside a
 * directory with a hostile name of its own holding one more, so a report
 * lists them as files, as a subtree, and in a ranking.
 */
export const HOSTILE_NAMES = [
  ["formula", Buffer.from("=cmd|' /C calc'!A0")],
  ["formula-at", Buffer.from("@SUM(1+1)")],
  ["formula-plus", Buffer.from("+1+1")],
  ["formula-minus", Buffer.from("-2+3")],
  // A name cannot hold a slash, so this one spans a directory and a file and
  // the path a report shows reads `<script>alert(1)</script>`.
  ["script", Buffer.from("<script>alert(1)</script>")],
  ["quoted", Buffer.from('"quoted", with a comma')],
  ["ampersand", Buffer.from("a&b<c>d'e&amp;")],
  ["newline", Buffer.from("first\nsecond\r\nthird")],
  ["escape", Buffer.from("\u001b[31mred\u001b[0m")],
  ["tab", Buffer.from("\t=1+1")],
  // U+202E, RIGHT-TO-LEFT OVERRIDE, written as its UTF-8 bytes so this file
  // holds no invisible character of its own.
  ["bidi", Buffer.concat([Buffer.from("invoice"), Buffer.from([0xe2, 0x80, 0xae]), Buffer.from("txt.exe")])],
  ["invalid-utf8", Buffer.from([0x62, 0x61, 0x64, 0x2d, 0xff, 0xfe, 0x2e, 0x62, 0x69, 0x6e])],
  ["emoji", Buffer.from("report \u{1F4C4}.txt")],
  ["formula-extension", Buffer.from("data.=1+1")],
  ["long", Buffer.from("l".repeat(255))],
];

export async function createHostileNameFixture() {
  const root = await sandbox();
  try {
    const manifest = [];
    const parent = bytePath(root, Buffer.from("<b>=HYPERLINK(\"x\")"));
    await mkdir(parent);
    for (const [index, [name, nameBytes]] of HOSTILE_NAMES.entries()) {
      const path = bytePath(root, nameBytes);
      await mkdir(path.subarray(0, path.lastIndexOf(0x2f)), { recursive: true });
      // Different sizes, so a ranking by size has an order to get right.
      await writeFile(path, "x".repeat(4096 * (index + 1)));
      manifest.push({ name, path, bytes: Buffer.from(path) });
    }
    const nested = Buffer.concat([parent, Buffer.from("/"), Buffer.from("inner <i>&amp;<i>.log")]);
    await writeFile(nested, "y".repeat(8192));
    manifest.push({ name: "nested", path: nested, bytes: Buffer.from(nested) });
    manifest.push({ name: "hostile-directory", path: parent, bytes: Buffer.from(parent) });

    const fixture = { root, manifest };
    fixture.cleanup = sandboxCleanup(fixture);
    return fixture;
  } catch (error) {
    await rm(assertSandbox(root), { recursive: true, force: true });
    throw error;
  }
}

/**
 * A wide, shallow tree for the memory and scan-time budget.
 *
 * `bytesPerFile` gives the files real content, which is what makes an
 * allocated-bytes comparison against `du -x` mean anything: empty files
 * occupy no blocks, so a tree of them totals zero on every filesystem.
 */
export async function createLargeFixture({ entries, fanOut = 256, bytesPerFile = 0 }) {
  if (!Number.isSafeInteger(entries) || entries < 1) {
    throw new RangeError("entries must be a positive integer");
  }
  if (!Number.isSafeInteger(fanOut) || fanOut < 1) {
    throw new RangeError("fanOut must be a positive integer");
  }
  if (!Number.isSafeInteger(bytesPerFile) || bytesPerFile < 0) {
    throw new RangeError("bytesPerFile must be a nonnegative integer");
  }
  const payload = bytesPerFile === 0 ? "" : "d".repeat(bytesPerFile);
  const root = await sandbox();
  try {
    let created = 0;
    for (let bucket = 0; created < entries; bucket += 1) {
      const directory = join(root, `bucket-${bucket}`);
      await mkdir(directory);
      const batch = Math.min(fanOut, entries - created);
      for (let index = 0; index < batch; index += 1) {
        await writeFile(join(directory, `file-${index}.bin`), payload);
        created += 1;
      }
    }
    const fixture = { root, entryCount: created, bytesPerFile };
    fixture.cleanup = sandboxCleanup(fixture);
    return fixture;
  } catch (error) {
    await rm(assertSandbox(root), { recursive: true, force: true });
    throw error;
  }
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

/**
 * A home directory holding game libraries, Wine prefixes, disk images, and the
 * readings the storage detectors parse.
 *
 * One Steam manifest is deliberately malformed: a detector that trusted every
 * manifest would report a zero-byte game, which reads as a game that can go.
 */
export async function createStorageFixture() {
  const root = await sandbox();
  const home = join(root, "home");

  const steamApps = join(home, ".local", "share", "Steam", "steamapps");
  await mkdir(join(steamApps, "common", "Half-Life"), { recursive: true });
  await writeFile(join(steamApps, "common", "Half-Life", "hl.bin"), "g".repeat(4096));
  await writeFile(
    join(steamApps, "appmanifest_70.acf"),
    '"AppState"\n{\n\t"appid"\t\t"70"\n\t"name"\t\t"Half-Life"\n\t"installdir"\t\t"Half-Life"\n\t"SizeOnDisk"\t\t"4294967296"\n}\n',
  );
  await writeFile(
    join(steamApps, "appmanifest_999.acf"),
    '"AppState"\n{\n\t"appid"\t\t"999"\n\t"name"\t\t"Broken Game"\n\t"installdir"\t\t"Broken"\n\t"SizeOnDisk"\t\t"not a number"\n}\n',
  );
  await writeFile(
    join(steamApps, "libraryfolders.vdf"),
    `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${join(home, ".local", "share", "Steam")}"\n\t}\n}\n`,
  );
  const compatdata = join(steamApps, "compatdata", "70", "pfx");
  await mkdir(join(compatdata, "drive_c"), { recursive: true });

  const wine = join(home, ".wine");
  await mkdir(join(wine, "drive_c", "windows"), { recursive: true });
  await writeFile(join(wine, "system.reg"), "WINE REGISTRY Version 2\n");

  const images = join(home, ".local", "share", "gnome-boxes", "images");
  await mkdir(images, { recursive: true });
  const sparse = join(images, "fedora.qcow2");
  const handle = await open(sparse, "w");
  await handle.truncate(64 * 1024 * 1024);
  await handle.close();
  await writeFile(join(images, "notes.txt"), "not an image");

  const virtualbox = join(home, "VirtualBox VMs", "build");
  await mkdir(virtualbox, { recursive: true });
  await writeFile(join(virtualbox, "build.vdi"), "v".repeat(8192));

  const swaps = join(root, "proc-swaps");
  await writeFile(
    swaps,
    "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/swapfile                               file\t\t8388604\t\t262144\t\t-2\n",
  );

  const timeshift = join(root, "timeshift");
  await mkdir(join(timeshift, "snapshots", "2026-09-01_00-00-01"), { recursive: true });

  const fixture = {
    root,
    home,
    paths: {
      steamApps,
      steamGame: join(steamApps, "common", "Half-Life"),
      steamBroken: join(steamApps, "common", "Broken"),
      protonPrefix: join(steamApps, "compatdata", "70"),
      wine,
      boxesImage: sparse,
      boxesNotes: join(images, "notes.txt"),
      virtualboxImage: join(virtualbox, "build.vdi"),
      swaps,
      timeshift,
    },
  };
  fixture.cleanup = sandboxCleanup(fixture);
  return fixture;
}

/**
 * A tree inside a throwaway home, for the tests that actually change files.
 *
 * It lives under the home rather than beside it because generic cleanup is
 * limited to the user's own roots: a target outside the home is refused by the
 * protected-path policy, which is the behaviour, not an obstacle to work
 * around. The caller owns the home and its removal.
 */
export async function createActionTree(home) {
  const resolved = resolve(home);
  if (dirname(resolved) !== resolve(tmpdir())) {
    throw new Error(`${home} is not a throwaway home directory`);
  }

  const cache = join(resolved, ".cache", "pip");
  await sizedFile(join(cache, "wheel.bin"), 4096);
  await sizedFile(join(cache, "http", "deep", "entry.bin"), 2048);

  const artifacts = join(resolved, "projects", "api", "node_modules");
  await sizedFile(join(artifacts, "left-pad", "index.js"), 512);

  const single = join(resolved, "projects", "notes.log");
  await sizedFile(single, 8192);

  // A name that is not valid UTF-8 has to survive a trip through Trash and back.
  const oddName = Buffer.from([0x6f, 0x64, 0x64, 0xff, 0xfe, 0x2e, 0x62, 0x69, 0x6e]);
  const odd = Buffer.concat([Buffer.from(`${join(resolved, "projects")}/`), oddName]);
  await writeFile(odd, "x".repeat(1024));

  // A link whose target lives outside the tree: erasing the holder must remove
  // the link and leave what it points at alone.
  const linked = join(resolved, "keep-me.bin");
  await sizedFile(linked, 256);
  const holder = join(resolved, "projects", "holder");
  await mkdir(holder, { recursive: true });
  await symlink(linked, join(holder, "alias"));

  // An empty directory and a link to nothing, for `find`.
  await mkdir(join(resolved, "projects", "empty"), { recursive: true });
  await symlink(join(resolved, "projects", "nowhere"), join(resolved, "projects", "dangling"));

  // For `find duplicates`. Two real copies of one content, a third file of the
  // same size holding different bytes, and a second name for one of the copies.
  // A correct answer groups the two copies, excludes the decoy, and treats the
  // hardlink as the file it already counted rather than as a third copy.
  const pictures = join(resolved, "pictures");
  const copies = join(resolved, "pictures", "copies");
  await mkdir(copies, { recursive: true });
  const content = Buffer.alloc(200_000, 0x41);
  const decoy = Buffer.alloc(200_000, 0x42);
  const original = join(pictures, "trip.bin");
  const copy = join(copies, "trip.bin");
  await writeFile(original, content);
  await writeFile(copy, content);
  await writeFile(join(pictures, "other.bin"), decoy);
  const secondName = join(pictures, "trip-again.bin");
  await link(original, secondName);

  return {
    home: resolved,
    cache,
    artifacts,
    single,
    odd,
    holder,
    linked,
    duplicates: { root: pictures, original, copy, secondName },
  };
}
