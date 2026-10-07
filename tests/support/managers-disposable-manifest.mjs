/** Bootstrap data only: Disktop itself is never started by the root account. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";

assert.equal(process.getuid(), 0);
const [manager, fixture] = process.argv.slice(2);
const roots = { apt: ["/var/cache/apt/archives"], dnf: ["/var/cache/dnf", "/var/cache/libdnf5"], pacman: ["/var/cache/pacman/pkg"] };
assert.ok(Object.hasOwn(roots, manager));
assert.ok(roots[manager].some((root) => fixture.startsWith(`${root}/`)));
const hash = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
// Root can enter apt's private partial directory. Certify that the ordinary
// account's inaccessible directory contains no package before any application
// action is allowed to run.
const cached = [];
let inspected = 0;
async function inspectCache(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    assert.ok(++inspected <= 10_000);
    const path = `${directory}/${entry.name}`;
    assert.equal(entry.isSymbolicLink(), false, "cache entries cannot point outside the disposable image");
    if (entry.isDirectory()) await inspectCache(path);
    else if (/\.(deb|rpm|sig)$|\.pkg\.tar(?:\.[a-z0-9]+)?$/.test(entry.name)) cached.push(path);
  }
}
for (const directory of roots[manager]) await inspectCache(directory);
assert.deepEqual(cached.sort(), [fixture], "only the seeded fixture may be removed by the real manager");
if (manager === "apt") assert.deepEqual(await readdir("/var/cache/apt/archives/partial"), []);
let databaseFiles;
if (manager === "apt") databaseFiles = ["/var/lib/dpkg/status"];
else if (manager === "dnf") {
  databaseFiles = [await realpath("/var/lib/rpm/rpmdb.sqlite")];
} else {
  databaseFiles = [];
  for (const name of await readdir("/var/lib/pacman/local")) {
    const directory = `/var/lib/pacman/local/${name}`;
    if ((await lstat(directory)).isDirectory()) databaseFiles.push(`${directory}/desc`);
  }
}
assert.ok(databaseFiles.length > 0);
const database = [];
for (const path of databaseFiles.sort()) database.push({ path, hash: await hash(path) });
const manifest = {
  version: 1, manager, fixture, cacheRoots: roots[manager], database,
  sentinel: { path: "/var/tmp/disktop-manager-preserved", hash: await hash("/var/tmp/disktop-manager-preserved") },
};
await writeFile("/run/disktop-manager-gate/manifest.json", JSON.stringify(manifest), { flag: "wx", mode: 0o444 });
process.stdout.write(`Prepared ${manager}: ${fixture}\n`);
