/**
 * A deliberately small TOML reader for `config.toml`: tables, bare keys,
 * strings, integers, booleans, and single-line arrays of those. Anything else
 * is an error with its line number, so an unsupported construct is never
 * silently dropped from a configuration that controls safety behaviour.
 */
export type TomlValue = string | number | boolean | readonly TomlValue[];
export type TomlTable = { [key: string]: TomlValue | TomlTable | readonly TomlTable[] };

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
// A key that becomes an object's prototype would be invisible to the
// unknown-key check, so it is refused at the parser instead.
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const INTEGER = /^[+-]?(0|[1-9][0-9]*)$/;

export function parseToml(source: string): TomlTable {
  const root = Object.create(null) as TomlTable;
  const seenTables = new Set<string>();
  const seenArrays = new Set<string>();
  let table = root;
  let tableName = "";

  const lines = source.split("\n");
  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = stripComment(rawLine, lineNumber).trim();
    if (line === "") {
      continue;
    }

    // `[[name]]` starts another block of an array of tables. Each block is its
    // own table, so a key repeated inside one is still an error while the same
    // key in the next block is ordinary.
    if (line.startsWith("[[")) {
      if (!line.endsWith("]]")) {
        throw fail(lineNumber, "unterminated array-of-tables header");
      }
      const name = line.slice(2, -2).trim();
      if (!BARE_KEY.test(name) || RESERVED_KEYS.has(name)) {
        throw fail(lineNumber, `unsupported array-of-tables name '${name}'`);
      }
      if (seenTables.has(name)) {
        throw fail(lineNumber, `'${name}' is already a table, so it cannot also be an array of tables`);
      }
      seenArrays.add(name);
      table = Object.create(null) as TomlTable;
      const existing = root[name];
      if (Array.isArray(existing)) {
        (existing as TomlTable[]).push(table);
      } else {
        root[name] = [table] as readonly TomlTable[];
      }
      tableName = name;
      continue;
    }

    if (line.startsWith("[")) {
      if (!line.endsWith("]")) {
        throw fail(lineNumber, "unterminated table header");
      }
      const name = line.slice(1, -1).trim();
      if (!BARE_KEY.test(name) || RESERVED_KEYS.has(name)) {
        throw fail(lineNumber, `unsupported table name '${name}'`);
      }
      if (seenTables.has(name)) {
        throw fail(lineNumber, `table '${name}' is defined twice`);
      }
      if (seenArrays.has(name)) {
        throw fail(lineNumber, `'${name}' is already an array of tables, so it cannot also be a table`);
      }
      seenTables.add(name);
      table = Object.create(null) as TomlTable;
      root[name] = table;
      tableName = name;
      continue;
    }

    const separator = line.indexOf("=");
    if (separator < 0) {
      throw fail(lineNumber, "expected 'key = value'");
    }
    const key = line.slice(0, separator).trim();
    if (!BARE_KEY.test(key) || RESERVED_KEYS.has(key)) {
      throw fail(lineNumber, `unsupported key '${key}'`);
    }
    if (Object.hasOwn(table, key)) {
      throw fail(lineNumber, `key '${tableName === "" ? key : `${tableName}.${key}`}' is defined twice`);
    }
    table[key] = parseValue(line.slice(separator + 1).trim(), lineNumber);
  }

  return root;
}

function stripComment(line: string, lineNumber: number): string {
  let inString = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (inString && character === "\\") {
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = !inString;
    } else if (character === "#" && !inString) {
      return line.slice(0, index);
    }
  }
  if (inString) {
    throw fail(lineNumber, "unterminated string");
  }
  return line;
}

function parseValue(text: string, lineNumber: number): TomlValue {
  if (text === "") {
    throw fail(lineNumber, "missing value");
  }
  if (text.startsWith('"""') || text.startsWith("'")) {
    throw fail(lineNumber, "only basic double-quoted strings are supported");
  }
  if (text.startsWith("{")) {
    throw fail(lineNumber, "inline tables are not supported");
  }
  if (text.startsWith("[")) {
    return parseArray(text, lineNumber);
  }
  if (text.startsWith('"')) {
    return parseString(text, lineNumber);
  }
  if (text === "true" || text === "false") {
    return text === "true";
  }
  if (INTEGER.test(text)) {
    return Number(text);
  }
  throw fail(lineNumber, `unsupported value '${text}'`);
}

function parseArray(text: string, lineNumber: number): readonly TomlValue[] {
  if (!text.endsWith("]")) {
    throw fail(lineNumber, "arrays must close on the same line");
  }
  const body = text.slice(1, -1).trim();
  if (body === "") {
    return [];
  }
  const elements = splitTopLevel(body, lineNumber).map((element) => element.trim());
  if (elements.at(-1) === "") {
    elements.pop();
  }
  return elements.map((element) => {
    const value = parseValue(element, lineNumber);
    if (Array.isArray(value)) {
      throw fail(lineNumber, "nested arrays are not supported");
    }
    return value;
  });
}

function splitTopLevel(body: string, lineNumber: number): string[] {
  const parts: string[] = [];
  let current = "";
  let inString = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] as string;
    if (inString && character === "\\") {
      current += character + (body[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = !inString;
    }
    if (character === "," && !inString) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (inString) {
    throw fail(lineNumber, "unterminated string");
  }
  parts.push(current);
  return parts;
}

function parseString(text: string, lineNumber: number): string {
  if (text.length < 2 || !text.endsWith('"')) {
    throw fail(lineNumber, "unterminated string");
  }
  let value = "";
  for (let index = 1; index < text.length - 1; index += 1) {
    const character = text[index] as string;
    if (character === '"') {
      throw fail(lineNumber, "a string ends at its closing quote; separate array elements with a comma");
    }
    if (character !== "\\") {
      value += character;
      continue;
    }
    index += 1;
    const escape = text[index];
    switch (escape) {
      case '"':
      case "\\":
        value += escape;
        break;
      case "n":
        value += "\n";
        break;
      case "t":
        value += "\t";
        break;
      case "r":
        value += "\r";
        break;
      default:
        throw fail(lineNumber, `unsupported escape '\\${escape ?? ""}'`);
    }
  }
  return value;
}

function fail(lineNumber: number, message: string): RangeError {
  return new RangeError(`config.toml line ${lineNumber}: ${message}`);
}
