import assert from "node:assert/strict";
import { test } from "node:test";
import { handshakeRequest } from "../../dist/native/protocol.js";
import { compileBundle, exampleCases, schemaFiles } from "../support/schemas.mjs";

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
