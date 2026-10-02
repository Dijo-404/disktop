import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PROTECTED_ROOTS, SHARED_CONTAINER_ROOTS } from "../../dist/domain/protected-paths.js";

const guard = readFileSync(new URL("../../native/disktop-fs/src/guard.rs", import.meta.url), "utf8");

function rustList(name) {
  const start = guard.indexOf(`const ${name}:`);
  assert.ok(start >= 0, `${name} is declared in guard.rs`);
  const open = guard.indexOf("= [", start);
  const body = guard.slice(open, guard.indexOf("];", open));
  return [...body.matchAll(/b"([^"]*)"/g)].map((match) => match[1]).sort();
}

test("the helper's protected roots are the same list as Node's", () => {
  assert.deepEqual(rustList("PROTECTED_ROOTS"), [...PROTECTED_ROOTS].sort());
});

test("the helper's shared container roots are the same list as Node's", () => {
  assert.deepEqual(rustList("SHARED_CONTAINER_ROOTS"), [...SHARED_CONTAINER_ROOTS].sort());
});
