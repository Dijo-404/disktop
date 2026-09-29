import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isAbsoluteNormalized,
  isWithin,
  pathBytes,
  rawPathFromBytes,
  rawPathFromUtf8,
} from "../../dist/domain/paths.js";

const bytes = (...values) => Uint8Array.from(values);
const utf8 = (value) => new TextEncoder().encode(value);

test("a raw path keeps its bytes and round-trips through base64", () => {
  const invalidUtf8 = bytes(0x2f, 0x68, 0x6f, 0x6d, 0x65, 0x2f, 0xff, 0xfe);
  const path = rawPathFromBytes(invalidUtf8);
  assert.deepEqual(pathBytes(path), invalidUtf8);
  assert.equal(path.utf8, undefined);
  assert.equal(path.bytesBase64, Buffer.from(invalidUtf8).toString("base64"));
});

test("valid UTF-8 paths expose a utf8 form; invalid ones do not", () => {
  const path = rawPathFromUtf8("/home/example/résumé 📄.pdf");
  assert.equal(path.utf8, "/home/example/résumé 📄.pdf");
  assert.equal(path.display, "/home/example/résumé 📄.pdf");
  assert.deepEqual(pathBytes(path), utf8("/home/example/résumé 📄.pdf"));
});

test("display text never carries control bytes that a terminal would execute", () => {
  const escape = rawPathFromBytes(utf8("/home/example/\u001b[2Kfake\nsecond"));
  assert.doesNotMatch(escape.display, /[\u0000-\u001F\u007F]/);
  assert.match(escape.display, /␛/);
  assert.match(escape.display, /␊/);
  assert.equal(rawPathFromBytes(bytes(0x2f, 0x7f)).display, "/␡");
  assert.match(rawPathFromBytes(bytes(0x2f, 0xff)).display, /�/);
});

test("only absolute, normalized paths are accepted as operation targets", () => {
  for (const good of ["/", "/home", "/home/example/.cache"]) {
    assert.equal(isAbsoluteNormalized(utf8(good)), true, good);
  }
  for (const bad of ["", "home", "/home/", "/home//example", "/home/./x", "/home/../etc", "/.."]) {
    assert.equal(isAbsoluteNormalized(utf8(bad)), false, JSON.stringify(bad));
  }
});

test("containment compares whole path segments, not string prefixes", () => {
  assert.equal(isWithin(utf8("/home/example"), utf8("/home/example/.cache")), true);
  assert.equal(isWithin(utf8("/home/example"), utf8("/home/example")), true);
  assert.equal(isWithin(utf8("/home/example"), utf8("/home/example-backup")), false);
  assert.equal(isWithin(utf8("/"), utf8("/etc")), true);
  assert.equal(isWithin(utf8("/home/example/.cache"), utf8("/home/example")), false);
});
