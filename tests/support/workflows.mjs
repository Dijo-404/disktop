import assert from "node:assert/strict";

/** One YAML job or step, bounded by the next declaration at its indentation. */
export function workflowBlock(text, header, indentation) {
  const start = text.indexOf(`${header}\n`);
  assert.ok(start >= 0, `missing workflow declaration: ${header.trim()}`);
  const afterHeader = start + header.length + 1;
  const tail = text.slice(afterHeader);
  const next = new RegExp(`^ {0,${indentation}}\\S`, "m").exec(tail)?.index ?? tail.length;
  return text.slice(start, afterHeader + next);
}
