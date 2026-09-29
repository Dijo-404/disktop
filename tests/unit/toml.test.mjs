import assert from "node:assert/strict";
import { test } from "node:test";
import { parseToml } from "../../dist/storage/toml.js";

// parseToml builds null-prototype tables on purpose; compare their contents.
const parsed = (source) => JSON.parse(JSON.stringify(parseToml(source)));

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
  assert.deepEqual(parsed(document), {
    units: "iec",
    alerts: { space_threshold_percent: 90, notify: true },
    scan: { excludes: ["/proc", "/sys"] },
  });
});

test("string escapes are decoded and unterminated strings are rejected", () => {
  assert.deepEqual(parsed('name = "tab\\there"'), { name: "tab\there" });
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

test("backslash escapes do not break comment and string scanning", () => {
  assert.deepEqual(parsed('path = "ends with a backslash\\\\"'), { path: "ends with a backslash\\" });
  assert.deepEqual(parsed('path = "hash # inside" # trailing comment'), { path: "hash # inside" });
  assert.deepEqual(parsed('path = "quote \\" inside"'), { path: 'quote " inside' });
});

test("a malformed array is an error rather than a silently merged string", () => {
  assert.throws(() => parseToml('excludes = ["/a" "/b"]'), /line 1/);
  assert.throws(() => parseToml('excludes = ["/a", , "/b"]'), /line 1/);
  assert.deepEqual(parsed('excludes = ["/a", "/b",]'), { excludes: ["/a", "/b"] });
});

test("prototype-polluting keys are refused", () => {
  assert.throws(() => parseToml("[__proto__]\nx = 1"), /line 1/);
  assert.throws(() => parseToml("__proto__ = 1"), /line 1/);
  assert.equal(Object.getPrototypeOf(parseToml("a = 1")), null);
});
