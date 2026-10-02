import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, parseConfigDocument } from "../../dist/storage/config.js";

test("defaults match the documented product behaviour", () => {
  assert.equal(DEFAULT_CONFIG.alerts.spaceThresholdPercent, 90);
  assert.equal(DEFAULT_CONFIG.alerts.inodeThresholdPercent, 90);
  assert.equal(DEFAULT_CONFIG.scan.crossFilesystems, false);
  assert.equal(DEFAULT_CONFIG.scan.accounting, "allocated");
  assert.equal(DEFAULT_CONFIG.scan.excludeWindowsMounts, true);
  assert.equal(DEFAULT_CONFIG.find.staleAfterDays, 183);
  assert.equal(DEFAULT_CONFIG.cleanup.defaultOperation, "trash");
  assert.equal(DEFAULT_CONFIG.units, "iec");
});

test("an empty document yields the defaults", () => {
  assert.deepEqual(parseConfigDocument("# nothing set\n"), DEFAULT_CONFIG);
});

test("a partial document overrides only what it names", () => {
  const config = parseConfigDocument('[alerts]\nspace_threshold_percent = 80\n');
  assert.equal(config.alerts.spaceThresholdPercent, 80);
  assert.equal(config.alerts.inodeThresholdPercent, DEFAULT_CONFIG.alerts.inodeThresholdPercent);
});

test("unknown tables and keys are refused so a typo never silently disables a guard", () => {
  assert.throws(() => parseConfigDocument("[alerts]\nspace_treshold_percent = 80\n"), /alerts\.space_treshold_percent/);
  assert.throws(() => parseConfigDocument("[danger]\nforce = true\n"), /danger/);
});

test("out-of-range and wrongly typed values are refused", () => {
  assert.throws(() => parseConfigDocument("[alerts]\nspace_threshold_percent = 101\n"), /0 and 100/);
  assert.throws(() => parseConfigDocument("[alerts]\nspace_threshold_percent = true\n"), /integer/);
  assert.throws(() => parseConfigDocument('[scan]\naccounting = "guessed"\n'), /allocated/);
  assert.throws(() => parseConfigDocument("[find]\nstale_after_days = 0\n"), /between 1 and 3650/);
});

test("configuration cannot widen cleanup to a protected root", () => {
  for (const root of ["/", "/etc", "/usr/share", "/var"]) {
    assert.throws(
      () => parseConfigDocument(`[cleanup]\nadditional_allowed_roots = ["${root}"]\n`),
      /protected/,
      root,
    );
  }
  assert.throws(() => parseConfigDocument('[cleanup]\nadditional_allowed_roots = ["relative/path"]\n'), /absolute/);
  const config = parseConfigDocument('[cleanup]\nadditional_allowed_roots = ["/media/work"]\n');
  assert.deepEqual(config.cleanup.additionalAllowedRoots, ["/media/work"]);
});

test("the shipped example config parses and matches the defaults it documents", async () => {
  const { readFile } = await import("node:fs/promises");
  const config = parseConfigDocument(await readFile("docs/config.example.toml", "utf8"));
  assert.deepEqual(config, DEFAULT_CONFIG);
});

test("a prototype-named table cannot smuggle settings past the unknown-key check", () => {
  assert.throws(() => parseConfigDocument('[__proto__]\nunits = "si"\n'), /__proto__/);
  assert.throws(() => parseConfigDocument("[constructor]\nbogus = 1\n"), /constructor/);
  assert.throws(() => parseConfigDocument("[alerts]\n__proto__ = 1\n"), /__proto__/);
});

test("a shared container root cannot be added to the cleanup allowlist", () => {
  for (const root of ["/home", "/tmp", "/media", "/mnt"]) {
    assert.throws(() => parseConfigDocument(`[cleanup]\nadditional_allowed_roots = ["${root}"]\n`), /protected|shared/, root);
  }
});

test("integer settings have an upper bound, so a typo cannot disable plan expiry", () => {
  assert.throws(() => parseConfigDocument("[cleanup]\nplan_expiry_minutes = 99999999999999999999\n"), /expected an integer/);
  assert.throws(() => parseConfigDocument("[snapshots]\nkeep_latest = 100000\n"), /between/);
  assert.throws(() => parseConfigDocument("[find]\nstale_after_days = 100000\n"), /between/);
  assert.equal(parseConfigDocument("[cleanup]\nplan_expiry_minutes = 1440\n").cleanup.planExpiryMinutes, 1440);
});

test("an empty unknown table is still an unknown table", () => {
  assert.throws(() => parseConfigDocument("[bogus]\n"), /bogus/);
});

test("the providers table carries the bounds the detectors run under", () => {
  assert.deepEqual(DEFAULT_CONFIG.providers.appImageRoots, []);
  assert.equal(DEFAULT_CONFIG.providers.largeLogBytes, 128 * 1024 * 1024);
  assert.equal(DEFAULT_CONFIG.providers.maxFindingsPerProvider, 50);
  assert.ok(DEFAULT_CONFIG.providers.artifactDirectories.includes("node_modules"));
});

test("an AppImage root is a discovery root, so a system directory is allowed but a relative path is not", () => {
  // These roots are read, never cleaned: AppImages commonly live under /opt,
  // and what may be acted on is decided by the finding, not by this list.
  const config = parseConfigDocument('[providers]\napp_image_roots = ["/opt/appimages"]\n');
  assert.deepEqual(config.providers.appImageRoots, ["/opt/appimages"]);

  assert.throws(() => parseConfigDocument('[providers]\napp_image_roots = ["Applications"]\n'), /absolute/);
  assert.throws(() => parseConfigDocument('[providers]\napp_image_roots = ["/opt/../etc"]\n'), /normalized/);
});

test("the log threshold and the finding cap are bounded so a typo cannot disable them", () => {
  assert.equal(parseConfigDocument("[providers]\nlarge_log_bytes = 1048576\n").providers.largeLogBytes, 1_048_576);
  assert.throws(() => parseConfigDocument("[providers]\nlarge_log_bytes = 0\n"), /between/);
  assert.throws(() => parseConfigDocument("[providers]\nmax_findings_per_provider = 0\n"), /between/);
  assert.throws(() => parseConfigDocument("[providers]\nmax_findings_per_provider = 100000\n"), /between/);
});

test("an artifact directory name cannot be a path, so a detector cannot be pointed anywhere", () => {
  const config = parseConfigDocument('[providers]\nartifact_directories = ["node_modules", ".turbo"]\n');
  assert.deepEqual(config.providers.artifactDirectories, ["node_modules", ".turbo"]);

  assert.throws(() => parseConfigDocument('[providers]\nartifact_directories = ["/etc"]\n'), /name/);
  assert.throws(() => parseConfigDocument('[providers]\nartifact_directories = ["../etc"]\n'), /name/);
});

test("an unknown key in the providers table is still refused", () => {
  assert.throws(() => parseConfigDocument("[providers]\nmax_finding = 1\n"), /providers\.max_finding/);
});

// --- Declarative cleanup rules ---

test("rules are read in order, with their limits, from [[rules]] blocks", () => {
  const config = parseConfigDocument(`
[[rules]]
name = "old downloads"
roots = ["/home/example/Downloads"]
globs = ["*.iso"]
minimum_age_days = 30
minimum_bytes = 1048576
maximum_count = 50
maximum_bytes = 10737418240

[[rules]]
name = "build output"
roots = ["/home/example/projects"]
globs = ["**/target"]
kinds = ["directory"]
minimum_age_days = 14
minimum_bytes = 0
maximum_count = 20
maximum_bytes = 1073741824
`);

  assert.equal(config.rules.length, 2);
  assert.equal(config.rules[0].name, "old downloads");
  assert.equal(config.rules[0].maximumCount, 50);
  assert.deepEqual(config.rules[1].kinds, ["directory"]);
});

test("no rules at all is an empty list, not an error", () => {
  assert.deepEqual(parseConfigDocument('units = "si"\n').rules, []);
});

test("a rule naming a protected root is reported rather than dropped", () => {
  assert.throws(
    () =>
      parseConfigDocument(`
[[rules]]
name = "bad"
roots = ["/etc"]
globs = ["*"]
minimum_age_days = 1
minimum_bytes = 0
maximum_count = 1
maximum_bytes = 1
`),
    /etc/,
  );
});

test("a rule that tries to name a command is refused by name", () => {
  assert.throws(
    () =>
      parseConfigDocument(`
[[rules]]
name = "sneaky"
roots = ["/home/example/Downloads"]
globs = ["*"]
command = "rm -rf /"
minimum_age_days = 1
minimum_bytes = 0
maximum_count = 1
maximum_bytes = 1
`),
    /command/,
  );
});

test("an unknown top-level section is still refused now that one array of tables is known", () => {
  assert.throws(() => parseConfigDocument('[[policies]]\nname = "x"\n'), /policies/);
});

test("two rules whose names reduce to one identifier are refused, not silently merged", () => {
  assert.throws(
    () =>
      parseConfigDocument(`
[[rules]]
name = "My rule"
roots = ["/home/example/Downloads"]
globs = ["*.a"]
minimum_age_days = 1
minimum_bytes = 0
maximum_count = 1
maximum_bytes = 1

[[rules]]
name = "my-rule"
roots = ["/home/example/Downloads"]
globs = ["*.b"]
minimum_age_days = 1
minimum_bytes = 0
maximum_count = 1
maximum_bytes = 1
`),
    /name/i,
  );
});
