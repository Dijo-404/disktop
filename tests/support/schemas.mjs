import Ajv from "ajv/dist/2020.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const AjvClass = Ajv.default ?? Ajv;

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function schemaFiles(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name: name.replace(/\.json$/, ""), path: join(directory, name) }));
}

/** Compile every schema in a directory as one bundle so `$ref` between them resolves. */
export function compileBundle(directory) {
  const ajv = new AjvClass({ strict: true, allErrors: true });
  const files = schemaFiles(directory);
  for (const file of files) {
    ajv.addSchema(readJson(file.path), file.name);
  }
  const validators = new Map();
  for (const file of files) {
    validators.set(file.name, ajv.getSchema(file.name));
  }
  return validators;
}

/** Example files are named `<schema>.<case>.json` so each case names its schema. */
export function exampleCases(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      schema: name.slice(0, name.indexOf(".")),
      label: name.replace(/\.json$/, ""),
      document: readJson(join(directory, name)),
    }));
}
