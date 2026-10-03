/**
 * Remove this repository's `dist/` before a build, and nothing else.
 *
 * `tsc` only ever adds and overwrites, so without this a source file deleted
 * from `src/` would leave its compiled output behind to be packed and shipped.
 * The path is fixed relative to this file; it is checked to be a real
 * directory beside this repository's own package.json before it is removed,
 * and a symlink there is refused rather than followed or unlinked.
 */
import { lstat, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const dist = fileURLToPath(new URL("dist", root));

const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
if (manifest.name !== "disktop") {
  throw new Error(`clean-dist: ${fileURLToPath(root)} is not the disktop repository; refusing to remove anything.`);
}

let entry;
try {
  entry = await lstat(dist);
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}

if (entry !== undefined) {
  if (!entry.isDirectory()) {
    throw new Error(`clean-dist: ${dist} is not a directory (a symlink or file?); remove it by hand after checking what it is.`);
  }
  await rm(dist, { recursive: true });
}
