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
