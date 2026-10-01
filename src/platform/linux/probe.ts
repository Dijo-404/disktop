import { lstat, readdir, readFile } from "node:fs/promises";
import { pathBytes, rawPathFromBytes } from "../../domain/paths.js";
import { allocatedBytesFromBlocks } from "../../domain/sizes.js";
import type { PathFacts, PathProbe } from "../../ports/providers.js";

const SLASH = 0x2f;

/** A directory listing is bounded: a detector reads structure, not a whole tree. */
const MAX_ENTRIES = 4096;

/**
 * Read-only questions about paths a detector already knows the names of.
 *
 * Every call resolves the path's bytes, never its display text, and every
 * failure is an absent answer rather than an exception: a provider asking
 * whether `~/.cargo/registry` exists should not have to catch EACCES to find
 * out that it cannot tell.
 */
export function createPathProbe(): PathProbe {
  return {
    async facts(path) {
      try {
        // lstat, not stat: a symlink is reported as itself, so a detector
        // never attributes the target's bytes to the link.
        const reading = await lstat(Buffer.from(pathBytes(path)), { bigint: true });
        return {
          kind: kindOf(reading),
          apparentBytes: reading.size,
          allocatedBytes: allocatedBytesFromBlocks(reading.blocks),
          ownerId: reading.uid,
          modifiedNanoseconds: reading.mtimeNs,
          device: reading.dev,
          inode: reading.ino,
          mountId: reading.dev.toString(10),
        } satisfies PathFacts;
      } catch {
        return undefined;
      }
    },

    async list(path) {
      let names: Buffer[];
      try {
        names = await readdir(Buffer.from(pathBytes(path)), { encoding: "buffer" });
      } catch {
        return [];
      }
      const prefix = withTrailingSlash(pathBytes(path));
      return names
        .sort(Buffer.compare)
        .slice(0, MAX_ENTRIES)
        .map((name) => rawPathFromBytes(new Uint8Array(Buffer.concat([prefix, name]))));
    },

    async readText(path, maxBytes) {
      try {
        const contents = await readFile(Buffer.from(pathBytes(path)));
        return contents.subarray(0, maxBytes).toString("utf8");
      } catch {
        return undefined;
      }
    },
  };
}

interface ModeReading {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

function kindOf(reading: ModeReading): PathFacts["kind"] {
  if (reading.isDirectory()) {
    return "directory";
  }
  if (reading.isSymbolicLink()) {
    return "symlink";
  }
  return reading.isFile() ? "file" : "other";
}

function withTrailingSlash(bytes: Uint8Array): Buffer {
  if (bytes.length > 0 && bytes[bytes.length - 1] === SLASH) {
    return Buffer.from(bytes);
  }
  return Buffer.concat([Buffer.from(bytes), Buffer.from([SLASH])]);
}
