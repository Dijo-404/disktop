import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { rawPathFromBytes, rawPathFromUtf8 } from "../../dist/domain/paths.js";
import { REPORT_FILE_MODE, createReportFiles } from "../../dist/storage/report-files.js";

const root = await mkdtemp(join(tmpdir(), "disktop-report-files-"));
after(async () => {
  await chmod(join(root, "read-only"), 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

let counter = 0;
async function directory() {
  counter += 1;
  const path = join(root, `case-${counter}`);
  await mkdir(path);
  return path;
}

const content = Buffer.from("<!DOCTYPE html>\n<p>report</p>\n");

/** Nothing but the published file: no staging file is ever left beside it. */
async function assertOnly(path, names) {
  assert.deepEqual((await readdir(path)).sort(), [...names].sort());
}

test("a report is published whole under a new name, readable by its owner alone", async () => {
  const path = await directory();
  const target = join(path, "report.html");
  const files = createReportFiles();
  assert.deepEqual(await files.check(rawPathFromUtf8(target)), { kind: "clear" });

  const outcome = await files.createExclusive(rawPathFromUtf8(target), content);
  assert.deepEqual(outcome, { kind: "written", bytesWritten: BigInt(content.length), warnings: [] });
  assert.deepEqual(await readFile(target), content);
  const mode = (await stat(target)).mode & 0o777;
  assert.equal(mode & ~REPORT_FILE_MODE, 0, `a report is not shared by default: ${mode.toString(8)}`);
  assert.equal((await stat(target)).nlink, 1, "the staging name is gone, not a second link");
  await assertOnly(path, ["report.html"]);
});

test("an existing file is refused, by check and by the write, and left exactly as it was", async () => {
  const path = await directory();
  const target = join(path, "report.html");
  await writeFile(target, "somebody's notes");
  const files = createReportFiles();

  const checked = await files.check(rawPathFromUtf8(target));
  assert.equal(checked.kind, "refused");
  assert.equal(checked.failure.code, "invalid-input");
  assert.match(checked.failure.message, /report\.html already exists\. Disktop never replaces a file with a report/);

  const written = await files.createExclusive(rawPathFromUtf8(target), content);
  assert.equal(written.kind, "refused");
  assert.match(written.failure.message, /already exists/);
  assert.equal(await readFile(target, "utf8"), "somebody's notes");
  await assertOnly(path, ["report.html"]);
});

test("a symlink at the name is refused and never written through, dangling or not", async () => {
  const path = await directory();
  const victim = join(path, "victim.txt");
  await writeFile(victim, "keep me");
  await symlink(victim, join(path, "to-victim.html"));
  await symlink(join(path, "nowhere"), join(path, "dangling.html"));
  const files = createReportFiles();

  for (const name of ["to-victim.html", "dangling.html"]) {
    const target = rawPathFromUtf8(join(path, name));
    const checked = await files.check(target);
    assert.equal(checked.kind, "refused", name);
    assert.match(checked.failure.message, /is a symlink/);
    const written = await files.createExclusive(target, content);
    assert.equal(written.kind, "refused", name);
  }
  assert.equal(await readFile(victim, "utf8"), "keep me");
  await assert.rejects(lstat(join(path, "nowhere")), { code: "ENOENT" }, "the symlink's target was not created");
  await assertOnly(path, ["victim.txt", "to-victim.html", "dangling.html"]);
});

test("a directory, a missing directory, or one that cannot be written is refused with the reason", async (context) => {
  const path = await directory();
  await mkdir(join(path, "already-a-directory"));
  const files = createReportFiles();

  const directoryTarget = await files.check(rawPathFromUtf8(join(path, "already-a-directory")));
  assert.match(directoryTarget.failure.message, /is a directory/);
  const written = await files.createExclusive(rawPathFromUtf8(join(path, "already-a-directory")), content);
  assert.match(written.failure.message, /is a directory/);

  const missing = await files.check(rawPathFromUtf8(join(path, "no-such-directory", "report.html")));
  assert.equal(missing.failure.code, "invalid-input");
  assert.match(missing.failure.message, /no-such-directory is not an existing directory/);
  const missingWrite = await files.createExclusive(rawPathFromUtf8(join(path, "no-such-directory", "report.html")), content);
  assert.equal(missingWrite.failure.code, "invalid-input");

  if (process.getuid?.() === 0) {
    context.diagnostic("root can write anywhere; the permission case was not checked");
    return;
  }
  const readOnly = join(root, "read-only");
  await mkdir(readOnly, { recursive: true });
  await chmod(readOnly, 0o500);
  const denied = await files.check(rawPathFromUtf8(join(readOnly, "report.html")));
  assert.equal(denied.failure.code, "permission-denied");
  const deniedWrite = await files.createExclusive(rawPathFromUtf8(join(readOnly, "report.html")), content);
  assert.equal(deniedWrite.failure.code, "permission-denied");
});

test("a name that is not UTF-8 is created byte for byte", async () => {
  const path = await directory();
  const name = Buffer.from([0x72, 0x65, 0x70, 0xff, 0xfe, 0x2e, 0x63, 0x73, 0x76]);
  const target = rawPathFromBytes(Buffer.concat([Buffer.from(`${path}/`), name]));
  const outcome = await createReportFiles().createExclusive(target, content);
  assert.equal(outcome.kind, "written");
  const names = await readdir(path, { encoding: "buffer" });
  assert.equal(names.length, 1);
  assert.ok(names[0].equals(name));
});

test("a filesystem without hard links refuses publication instead of risking a concurrent overwrite", async () => {
  const path = await directory();
  const target = join(path, "report.csv");
  const files = createReportFiles({ link: async () => {
    // Another process creates the target between preflight and publication.
    await writeFile(target, "concurrent notes", { flag: "wx" });
    throw Object.assign(new Error("Operation not supported"), { code: "EOPNOTSUPP" });
  } });
  assert.deepEqual(await files.check(rawPathFromUtf8(target)), { kind: "clear" });
  const outcome = await files.createExclusive(rawPathFromUtf8(target), content);
  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.failure.code, "unsupported");
  assert.match(outcome.failure.message, /hard-link support/);
  assert.equal(await readFile(target, "utf8"), "concurrent notes");
  await assertOnly(path, ["report.csv"]);

  const empty = await directory();
  const refused = await createReportFiles({ link: async () => {
    throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
  } }).createExclusive(rawPathFromUtf8(join(empty, "new.csv")), content);
  assert.equal(refused.kind, "refused");
  assert.equal(refused.failure.code, "unsupported");
  await assertOnly(empty, [], "no placeholder or stage is left behind");
});

test("a link that fails for any other reason leaves nothing behind", async () => {
  const failing = async () => {
    const error = new Error("No space left on device");
    error.code = "ENOSPC";
    throw error;
  };
  const path = await directory();
  const outcome = await createReportFiles({ link: failing }).createExclusive(rawPathFromUtf8(join(path, "report.json")), content);
  assert.equal(outcome.kind, "refused");
  assert.match(outcome.failure.message, /no room left/);
  await assertOnly(path, []);
});
