import assert from "node:assert/strict";

/**
 * A strict RFC 4180 reader: every record ends in CRLF, a quote may only open
 * a field or be doubled inside one, and a line break outside quotes is an
 * error. A renderer that gets quoting wrong fails here rather than loading
 * as a shifted table.
 */
export function parseCsv(text) {
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  let started = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      assert.equal(started, false, `a quote inside an unquoted field at ${index}`);
      quoted = true;
      started = true;
    } else if (character === ",") {
      record.push(field);
      field = "";
      started = false;
    } else if (character === "\r" && text[index + 1] === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      started = false;
      index += 1;
    } else {
      assert.ok(character !== "\r" && character !== "\n", `a bare line break outside quotes at ${index}`);
      field += character;
      started = true;
    }
  }
  assert.equal(quoted, false, "a quoted field never closed");
  assert.equal(field, "", "the last record does not end with CRLF");
  assert.equal(record.length, 0, "the last record does not end with CRLF");
  return records;
}

export function csvRows(text) {
  const [header, ...rows] = parseCsv(text);
  return { header, rows: rows.map((cells) => Object.fromEntries(header.map((column, index) => [column, cells[index]]))), raw: rows };
}
