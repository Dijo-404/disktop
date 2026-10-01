import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPathProbe } from "../../dist/platform/linux/probe.js";
import { rawPathFromBytes, rawPathFromUtf8 } from "../../dist/domain/paths.js";
import { restoreAndRemove } from "../fixtures/generate.mjs";

const probe = createPathProbe();

async function sandbox() {
  return mkdtemp(join(tmpdir(), "disktop-fixture-"));
}

test("a file's apparent size is what was written and its allocated size counts whole blocks", async () => {
  const root = await sandbox();
  try {
    const file = join(root, "report.txt");
    await writeFile(file, "x".repeat(5000));

    const facts = await probe.facts(rawPathFromUtf8(file));

    assert.equal(facts.kind, "file");
    assert.equal(facts.apparentBytes, 5000n);
    assert.equal(facts.allocatedBytes % 512n, 0n, `${facts.allocatedBytes} is not a multiple of 512`);
    assert.ok(facts.allocatedBytes >= 5000n);
    assert.equal(typeof facts.modifiedNanoseconds, "bigint");
  } finally {
    await restoreAndRemove(root);
  }
});

test("a symlink is reported as itself, not as what it points at", async () => {
  const root = await sandbox();
  try {
    await writeFile(join(root, "target.bin"), "y".repeat(4096));
    await symlink(join(root, "target.bin"), join(root, "link"));

    const facts = await probe.facts(rawPathFromUtf8(join(root, "link")));

    assert.equal(facts.kind, "symlink");
    assert.ok(facts.apparentBytes < 4096n, "a link is the length of its target's name");
  } finally {
    await restoreAndRemove(root);
  }
});

test("a path that is not there is absent, never zero bytes", async () => {
  const root = await sandbox();
  try {
    assert.equal(await probe.facts(rawPathFromUtf8(join(root, "never-written"))), undefined);
  } finally {
    await restoreAndRemove(root);
  }
});

test("listing a directory returns one level, sorted, with invalid bytes intact", async () => {
  const root = await sandbox();
  try {
    await mkdir(join(root, "beta"));
    await writeFile(join(root, "beta", "deep.txt"), "deep");
    await writeFile(join(root, "alpha.txt"), "a");
    const oddName = Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0x7a, 0x7a, 0xff, 0xfe])]);
    await writeFile(oddName, "odd");

    const listed = await probe.list(rawPathFromUtf8(root));

    assert.deepEqual(
      listed.map((path) => path.display),
      [`${root}/alpha.txt`, `${root}/beta`, `${root}/zz��`],
    );
    const odd = listed[2];
    assert.equal(odd.utf8, undefined, "invalid bytes have no UTF-8 form");
    assert.deepEqual(Buffer.from(odd.bytesBase64, "base64"), oddName);
  } finally {
    await restoreAndRemove(root);
  }
});

test("a file and a directory that cannot be read list empty rather than throwing", async () => {
  const root = await sandbox();
  try {
    await writeFile(join(root, "plain.txt"), "a");
    const closed = join(root, "unreadable-directory");
    await mkdir(closed);
    await chmod(closed, 0o000);

    assert.deepEqual(await probe.list(rawPathFromUtf8(join(root, "plain.txt"))), []);
    if (process.getuid?.() !== 0) {
      assert.deepEqual(await probe.list(rawPathFromUtf8(closed)), []);
    }
  } finally {
    await restoreAndRemove(root);
  }
});

test("reading text stops at the byte limit and never throws", async () => {
  const root = await sandbox();
  try {
    const file = join(root, "settings.toml");
    await writeFile(file, "default_toolchain = \"stable-x86_64-unknown-linux-gnu\"\n");

    assert.equal(await probe.readText(rawPathFromUtf8(file), 7), "default");
    assert.equal(await probe.readText(rawPathFromUtf8(join(root, "absent")), 64), undefined);
    assert.equal(await probe.readText(rawPathFromUtf8(root), 64), undefined, "a directory is not text");
  } finally {
    await restoreAndRemove(root);
  }
});

test("a path built from bytes is resolved from those bytes, not from its display text", async () => {
  const root = await sandbox();
  try {
    const name = Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0x62, 0xff, 0x2e, 0x62, 0x69, 0x6e])]);
    await writeFile(name, "z".repeat(100));

    const facts = await probe.facts(rawPathFromBytes(new Uint8Array(name)));

    assert.equal(facts.apparentBytes, 100n);
  } finally {
    await restoreAndRemove(root);
  }
});
