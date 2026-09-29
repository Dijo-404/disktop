import assert from "node:assert/strict";
import { test } from "node:test";
import { parseToml } from "../../dist/storage/toml.js";

test("the supported subset covers tables, scalars, and single-line arrays", () => {
  const document = `
# Disktop configuration
units = "iec"

[alerts]
space_threshold_percent = 90
notify = true

[scan]
excludes = ["/proc", "/sys"]
`;
  assert.deepEqual(parseToml(document), {
    units: "iec",
    alerts: { space_threshold_percent: 90, notify: true },
    scan: { excludes: ["/proc", "/sys"] },
  });
});

test("string escapes are decoded and unterminated strings are rejected", () => {
  assert.deepEqual(parseToml('name = "tab\\there"'), { name: "tab\there" });
  assert.throws(() => parseToml('name = "unterminated'), /line 1/);
  assert.throws(() => parseToml('name = "bad \\q escape"'), /line 1/);
});

test("unsupported TOML syntax is an error rather than a silent omission", () => {
  for (const source of [
    'value = 1.5',
    'value = 2026-09-29',
    'value = { inline = true }',
    'a.b = 1',
    "[[products]]",
    'value = """multi"""',
    'novalue',
  ]) {
    assert.throws(() => parseToml(source), /line 1/, source);
  }
});

test("duplicate keys and tables are rejected instead of last-one-wins", () => {
  assert.throws(() => parseToml("a = 1\na = 2"), /line 2/);
  assert.throws(() => parseToml("[x]\n[x]"), /line 2/);
});
