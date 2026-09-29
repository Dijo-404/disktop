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
  assert.throws(() => parseConfigDocument("[find]\nstale_after_days = 0\n"), /at least 1/);
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
