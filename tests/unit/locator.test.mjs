import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHECKSUM_FILE, HELPER_TARGETS, detectLibc, helperBinaryName, helperTarget, parseChecksums } from "../../dist/native/locator.js";

const DIGEST = "a".repeat(64);
const OTHER = "b".repeat(64);

test("each architecture and libc names exactly one packaged helper", () => {
  assert.equal(helperTarget("x64", "gnu"), "linux-x64-gnu");
  assert.equal(helperTarget("x64", "musl"), "linux-x64-musl");
  assert.equal(helperTarget("arm64", "gnu"), "linux-arm64-gnu");
  assert.equal(helperTarget("arm64", "musl"), "linux-arm64-musl");
  assert.equal(helperTarget("mips64", "gnu"), undefined);
  // The old spelling names nothing, so a stale file can never be selected.
  assert.equal(helperTarget("x64", "glibc"), undefined);
  assert.ok(["gnu", "musl"].includes(detectLibc()));
  assert.ok(HELPER_TARGETS.includes(helperTarget()));
  assert.equal(helperBinaryName("linux-x64-gnu"), "disktop-fs-linux-x64-gnu");
  assert.equal(CHECKSUM_FILE, "SHA256SUMS");
});

test("a SHA256SUMS file in sha256sum's own format is read line by line", () => {
  const text = HELPER_TARGETS.map((target, index) => `${String(index).repeat(64)}  ${helperBinaryName(target)}\n`).join("");
  const recorded = parseChecksums(text);
  assert.equal(recorded.size, 4);
  assert.equal(recorded.get("disktop-fs-linux-arm64-musl"), "3".repeat(64));
  // Binary mode, as `sha256sum -b` writes it, is the same digest.
  assert.equal(parseChecksums(`${DIGEST} *disktop-fs-linux-x64-musl\n`).get("disktop-fs-linux-x64-musl"), DIGEST);
});

test("one malformed line makes the whole checksum list unreadable", () => {
  const good = `${DIGEST}  disktop-fs-linux-x64-gnu\n`;
  const refused = {
    empty: "",
    "no final newline": good.trimEnd(),
    "a carriage return": good.replace("\n", "\r\n"),
    "one space": `${DIGEST} disktop-fs-linux-x64-gnu\n`,
    "upper-case hex": `${DIGEST.toUpperCase()}  disktop-fs-linux-x64-gnu\n`,
    "a short digest": `${DIGEST.slice(1)}  disktop-fs-linux-x64-gnu\n`,
    "a directory in the name": `${DIGEST}  vendor/bin/disktop-fs-linux-x64-gnu\n`,
    "a relative name": `${DIGEST}  ./disktop-fs-linux-x64-gnu\n`,
    "the old glibc spelling": `${DIGEST}  disktop-fs-linux-x64-glibc\n`,
    "a name that is not a helper": `${DIGEST}  disktop-fs-linux-x64-gnu.sig\n`,
    "the same name twice": `${good}${OTHER}  disktop-fs-linux-x64-gnu\n`,
    "a blank line": `${good}\n`,
    "a trailing space": `${DIGEST}  disktop-fs-linux-x64-gnu \n`,
    "a comment": `# release\n${good}`,
    "an escaped name": `\\${DIGEST}  disktop-fs-linux-x64-gnu\n`,
    "JSON": JSON.stringify({ "disktop-fs-linux-x64-gnu": DIGEST }),
  };
  for (const [label, text] of Object.entries(refused)) {
    assert.equal(parseChecksums(text), undefined, label);
  }
});

test("sha256sum writes what the locator reads, and checks what the release writes", async (context) => {
  if (spawnSync("sha256sum", ["--version"]).error !== undefined) {
    context.skip("sha256sum is not installed");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "disktop-sums-"));
  const digests = new Map();
  for (const target of HELPER_TARGETS) {
    const contents = Buffer.from(`helper for ${target}\n`);
    await writeFile(join(directory, helperBinaryName(target)), contents);
    digests.set(helperBinaryName(target), createHash("sha256").update(contents).digest("hex"));
  }

  const names = [...digests.keys()].sort();
  const written = spawnSync("sha256sum", names, { cwd: directory, encoding: "utf8" });
  assert.equal(written.status, 0, written.stderr);
  assert.deepEqual(parseChecksums(written.stdout), new Map(names.map((name) => [name, digests.get(name)])));

  // The form scripts/build-release.mjs writes passes the stock tool's strict check.
  const canonical = names.map((name) => `${digests.get(name)}  ${name}\n`).join("");
  await writeFile(join(directory, CHECKSUM_FILE), canonical);
  const checked = spawnSync("sha256sum", ["--check", "--strict", CHECKSUM_FILE], { cwd: directory, encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});

test("checksum inputs cannot redirect or block reads and huge binaries are bounded", async () => {
  const { chmod, open, rm, symlink } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const { locateHelper } = await import("../../dist/native/locator.js");
  const directory = await mkdtemp(join(tmpdir(), "disktop-locator-safety-"));
  const target = helperTarget();
  const name = helperBinaryName(target);
  const binary = join(directory, name);
  const sums = join(directory, CHECKSUM_FILE);
  const contents = Buffer.from("#!/bin/false\n");
  const recorded = `${createHash("sha256").update(contents).digest("hex")}  ${name}\n`;
  const location = pathToFileURL(`${directory}/`);
  try {
    await writeFile(binary, contents);
    await chmod(binary, 0o755);
    await writeFile(join(directory, "actual-checksums"), recorded);
    await symlink(join(directory, "actual-checksums"), sums);
    assert.equal((await locateHelper(target, location)).found, false, "checksum symlinks are not trusted");
    await rm(sums);
    assert.equal(spawnSync("mkfifo", [sums]).status, 0);
    const began = Date.now();
    assert.equal((await locateHelper(target, location)).found, false);
    assert.ok(Date.now() - began < 2000, "a checksum FIFO is refused without waiting for a writer");
    await rm(sums);
    await writeFile(sums, recorded);
    const handle = await open(binary, "w");
    try { await handle.truncate(256 * 1024 * 1024 + 1); } finally { await handle.close(); }
    const enormous = await locateHelper(target, location);
    assert.equal(enormous.found, false);
    assert.match(enormous.capability.explanation, /bounded regular file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
