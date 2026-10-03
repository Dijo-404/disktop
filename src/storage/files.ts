import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Read one of Disktop's own files, refusing anything that is not a small
 * regular file.
 *
 * These files live in directories other programs running as the user can
 * write to. A named pipe in their place would block the read until somebody
 * wrote to it, and a symlink to `/dev/zero` would be read until memory ran
 * out; both are refused with a reason instead. The pipe is opened without
 * blocking so the refusal comes before any wait.
 */
export async function readOwnFile(
  path: string,
  maxBytes: number,
  options: { readonly followSymlinks: boolean },
): Promise<string> {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | (options.followSymlinks ? 0 : constants.O_NOFOLLOW);
  const handle = await open(path, flags);
  try {
    const facts = await handle.stat();
    if (!facts.isFile()) {
      throw new RangeError(`${path} is not a regular file`);
    }
    if (facts.size > maxBytes) {
      throw new RangeError(`${path} holds ${facts.size} bytes, more than the ${maxBytes} it may`);
    }
    // The size can change between the stat and the read, so the read itself
    // is bounded too: it stops at end of file or one byte past the limit.
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(Math.max(facts.size - total, 0) + 4096, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > maxBytes) {
        throw new RangeError(`${path} grew past the ${maxBytes} bytes it may hold while it was read`);
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Replace a file so that a crash leaves either the old contents or the new,
 * never a mixture.
 *
 * The staging file is created exclusively with the final mode, written, and
 * flushed; the rename publishes it; and the directory is flushed so the rename
 * itself survives a power cut. A failure at any step removes the staging file
 * rather than leaving `.partial` litter for the next reader to skip.
 */
export async function writeFileAtomically(path: string, contents: string, mode: number): Promise<void> {
  const staging = `${path}.${randomBytes(6).toString("hex")}.partial`;
  const handle = await open(staging, "wx", mode);
  let published = false;
  try {
    try {
      await handle.writeFile(contents, "utf8");
      // The umask can only take bits away at creation; this makes the mode
      // exactly what was asked for, in either direction.
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(staging, path);
    published = true;
  } finally {
    if (!published) {
      await unlink(staging).catch(() => undefined);
    }
  }
  await syncDirectory(dirname(path));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
