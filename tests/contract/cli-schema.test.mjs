import assert from "node:assert/strict";
import { test } from "node:test";
import { compileBundle, exampleCases, schemaFiles } from "../support/schemas.mjs";

const directory = "schemas/cli/v1";
const validators = compileBundle(directory);

test("every CLI v1 schema compiles and is closed to unknown fields", () => {
  const names = schemaFiles(directory).map((file) => file.name);
  assert.ok(names.includes("envelope"), "envelope schema is required");
  for (const name of names) {
    assert.ok(validators.get(name), `${name} failed to compile`);
  }
});

test("documented CLI examples validate against their schema", () => {
  const cases = exampleCases(`${directory}/examples/valid`);
  assert.ok(cases.length >= 3, "at least one example per implemented command shape");
  for (const example of cases) {
    const validate = validators.get(example.schema);
    assert.ok(validate, `${example.label} names an unknown schema`);
    assert.ok(validate(example.document), `${example.label}: ${JSON.stringify(validate.errors)}`);
  }
});

test("rounded numbers, unknown fields, and display-only paths are rejected", () => {
  const cases = exampleCases(`${directory}/examples/invalid`);
  assert.ok(cases.length >= 3, "each rejection rule needs a counter-example");
  for (const example of cases) {
    const validate = validators.get(example.schema);
    assert.ok(validate, `${example.label} names an unknown schema`);
    assert.equal(validate(example.document), false, `${example.label} was accepted`);
  }
});
