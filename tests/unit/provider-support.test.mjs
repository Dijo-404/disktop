import assert from "node:assert/strict";
import { test } from "node:test";
import { basename, buildFinding, slugForPath } from "../../dist/providers/support.js";
import { rawPathFromBytes, rawPathFromUtf8 } from "../../dist/domain/paths.js";

const HOSTILE = "/home/example/.config/App\u001b[31mRED\u001b[0m\nFAKE ROW";

test("a name a detector puts in a title cannot command the terminal", () => {
  const name = basename(rawPathFromUtf8(HOSTILE));

  assert.ok(!name.includes("\u001b"), `${JSON.stringify(name)} carries an escape character`);
  assert.ok(!name.includes("\n"), `${JSON.stringify(name)} can split a row in two`);
  for (const character of name) {
    const code = character.codePointAt(0);
    assert.ok(code >= 0x20 && code !== 0x7f, `U+${code.toString(16)} can command a terminal`);
  }
});

test("a name that is ordinary text is unchanged", () => {
  assert.equal(basename(rawPathFromUtf8("/home/example/.cargo/registry")), "registry");
  assert.equal(basename(rawPathFromUtf8("/home/example/report \u{1F4C4}.txt")), "report \u{1F4C4}.txt");
});

test("a name that is not valid UTF-8 is still readable rather than empty", () => {
  const bytes = Buffer.concat([Buffer.from("/home/example/"), Buffer.from([0x62, 0x61, 0x64, 0xff, 0xfe])]);
  const name = basename(rawPathFromBytes(new Uint8Array(bytes)));

  assert.ok(name.startsWith("bad"), JSON.stringify(name));
  assert.ok(!name.includes("/"), "a basename is one segment");
});

test("a slug built from a hostile name holds only identifier characters", () => {
  // The provider id supplies the leading letter; the slug supplies the rest.
  const slug = slugForPath(rawPathFromUtf8(HOSTILE));

  assert.match(slug, /^[A-Za-z0-9._-]+$/, slug);
});

test("a finding built from a hostile name has a schema-valid id and a safe title", () => {
  const finding = buildFinding({
    providerId: "cache.electron",
    providerVersion: 1,
    category: "app-cache",
    slug: slugForPath(rawPathFromUtf8(HOSTILE)),
    title: `${basename(rawPathFromUtf8(HOSTILE))} Cache`,
    evidence: [],
    paths: [rawPathFromUtf8(HOSTILE)],
  });

  assert.match(finding.id, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
  assert.ok(finding.id.length <= 256);
  assert.ok(!finding.title.includes("\u001b") && !finding.title.includes("\n"), JSON.stringify(finding.title));
});
