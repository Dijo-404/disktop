import assert from "node:assert/strict";
import { test } from "node:test";
import { handshakeRequest } from "../../dist/native/protocol.js";
import { compileBundle, exampleCases, readJson, schemaFiles } from "../support/schemas.mjs";

const directory = "schemas/native/v1";
const validators = compileBundle(directory);

test("every native v1 schema compiles", () => {
  const names = schemaFiles(directory).map((file) => file.name);
  for (const required of ["request", "event"]) {
    assert.ok(names.includes(required), `${required} schema is required`);
    assert.ok(validators.get(required), `${required} failed to compile`);
  }
});

test("the client's own handshake request validates against the request schema", () => {
  const validate = validators.get("request");
  assert.ok(validate(handshakeRequest("hello-1")), JSON.stringify(validate.errors));
});

test("documented native examples validate against their schema", () => {
  const cases = exampleCases(`${directory}/examples/valid`);
  assert.ok(cases.length >= 4);
  for (const example of cases) {
    const validate = validators.get(example.schema);
    assert.ok(validate, `${example.label} names an unknown schema`);
    assert.ok(validate(example.document), `${example.label}: ${JSON.stringify(validate.errors)}`);
  }
});

test("unsafe request IDs, unknown operations, and display-string paths are rejected", () => {
  const cases = exampleCases(`${directory}/examples/invalid`);
  assert.ok(cases.length >= 4);
  for (const example of cases) {
    const validate = validators.get(example.schema);
    assert.ok(validate, `${example.label} names an unknown schema`);
    assert.equal(validate(example.document), false, `${example.label} was accepted`);
  }
});

test("the scan and index result schemas are published", () => {
  const names = schemaFiles(directory).map((file) => file.name);
  for (const required of ["scan-result", "query-index-result"]) {
    assert.ok(names.includes(required), `${required} schema is required`);
    assert.ok(validators.get(required), `${required} failed to compile`);
  }
});

test("a scan result carries completeness, totals, and lossless counts", () => {
  const validate = validators.get("scan-result");
  const complete = readJson(`${directory}/examples/valid/scan-result.complete-home.json`);
  assert.ok(validate(complete), JSON.stringify(validate.errors));
  assert.equal(complete.result.complete, true);

  const partial = readJson(`${directory}/examples/valid/scan-result.partial-after-cancel.json`);
  assert.ok(validate(partial), JSON.stringify(validate.errors));
  assert.equal(partial.result.complete, false);
  assert.ok(partial.result.warnings.length >= 1, "a partial scan must say what it missed");
});

test("an index page returns byte paths and a cursor, never display text", () => {
  const validate = validators.get("query-index-result");
  const page = readJson(`${directory}/examples/valid/query-index-result.page-with-cursor.json`);
  assert.ok(validate(page), JSON.stringify(validate.errors));
  assert.ok(page.result.entries.every((entry) => typeof entry.path === "string" && !entry.path.includes("/")));
  assert.equal(typeof page.result.nextCursor, "string");
});
