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

test("a file lists empty, while an unreadable directory reports the denied read", async () => {
  const root = await sandbox();
  try {
    await writeFile(join(root, "plain.txt"), "a");
    const closed = join(root, "unreadable-directory");
    await mkdir(closed);
    await chmod(closed, 0o000);

    assert.deepEqual(await probe.list(rawPathFromUtf8(join(root, "plain.txt"))), []);
    if (process.getuid?.() !== 0) {
      await assert.rejects(probe.list(rawPathFromUtf8(closed)), { code: "EACCES" });
      await assert.rejects(probe.facts(rawPathFromUtf8(join(closed, "hidden"))), { code: "EACCES" });
      await assert.rejects(probe.readText(rawPathFromUtf8(join(closed, "hidden")), 64), { code: "EACCES" });
    }
  } finally {
    await restoreAndRemove(root);
  }
});

test("reading text stops at the byte limit and missing or non-file paths are absent", async () => {
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

test("reading text from a pipe or a device answers nothing at once instead of waiting or reading forever", async () => {
  // A Steam library or a logrotate rule names files anyone with write access
  // there can replace; a named pipe would hang discovery and /dev/zero would
  // be read until memory ran out, since only the first bytes are kept.
  const { spawnSync } = await import("node:child_process");
  const root = await sandbox();
  try {
    const pipe = join(root, "appmanifest_1.acf");
    assert.equal(spawnSync("mkfifo", [pipe]).status, 0);
    const endless = join(root, "libraryfolders.vdf");
    await symlink("/dev/zero", endless);

    const begun = Date.now();
    assert.equal(await probe.readText(rawPathFromUtf8(pipe), 4096), undefined);
    assert.equal(await probe.readText(rawPathFromUtf8(endless), 4096), undefined);
    assert.ok(Date.now() - begun < 2_000, `reading took ${Date.now() - begun} ms`);

    // A procfs file reports no size and is still read, up to the limit.
    const version = await probe.readText(rawPathFromUtf8("/proc/version"), 8);
    assert.equal(version?.length, 8);
  } finally {
    await restoreAndRemove(root);
  }
});

test("large directory sampling remains bounded and preserves the first sorted raw names", async () => {
  const root = await sandbox();
  try {
    // Create in reverse order, across bounded batches, so the answer cannot
    // accidentally rely on directory enumeration order.
    for (let end = 4608; end > 0; end -= 64) {
      await Promise.all(Array.from({ length: Math.min(64, end) }, (_, offset) =>
        writeFile(join(root, String(end - offset - 1).padStart(5, "0")), "")));
    }
    const listed = await probe.list(rawPathFromUtf8(root));
    assert.equal(listed.length, 4096);
    assert.deepEqual(listed.map((path) => path.display.slice(root.length + 1)),
      Array.from({ length: 4096 }, (_, index) => String(index).padStart(5, "0")));
    // Repeated reads close their directory descriptors and return the same
    // bounded selection, rather than retaining the previous directory's rows.
    assert.deepEqual(await probe.list(rawPathFromUtf8(root)), listed);
  } finally {
    await restoreAndRemove(root);
  }
});
