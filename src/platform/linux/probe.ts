import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { pathBytes, rawPathFromBytes } from "../../domain/paths.js";
import { allocatedBytesFromBlocks } from "../../domain/sizes.js";
import type { PathFacts, PathProbe } from "../../ports/providers.js";

const SLASH = 0x2f;

/** A directory listing is bounded: a detector reads structure, not a whole tree. */
const MAX_ENTRIES = 4096;

/**
 * Read-only questions about paths a detector already knows the names of.
 *
 * Every call resolves the path's bytes, never its display text. Missing paths
 * are absent answers; denied and failed reads propagate so discovery cannot
 * mistake data it could not inspect for an empty directory.
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
      } catch (error) {
        if (isAbsent(error)) return undefined;
        throw error;
      }
    },

    async list(path) {
      const names: Buffer[] = [];
      try {
        // Node supports byte names here; @types/node types this option as text
        // encodings only. Validate the returned name instead of trusting its type.
        const directory = await opendir(Buffer.from(pathBytes(path)), { encoding: "buffer" as BufferEncoding, bufferSize: 32 });
        try {
          for (;;) {
            const entry = await directory.read();
            if (entry === null) break;
            const name: unknown = entry.name;
            if (!Buffer.isBuffer(name)) throw new Error("The directory reader did not preserve raw name bytes");
            retainName(names, name);
          }
        } finally {
          await directory.close();
        }
      } catch (error) {
        if (isAbsent(error)) return [];
        throw error;
      }
      const prefix = withTrailingSlash(pathBytes(path));
      return names
        .sort(Buffer.compare)
        .map((name) => rawPathFromBytes(new Uint8Array(Buffer.concat([prefix, name]))));
    },

    /**
     * The first `maxBytes` of a regular file, and only those are read.
     *
     * Detectors read files other people can replace — a Steam library on a
     * shared disk, a logrotate rule — so a named pipe must not block discovery
     * and `/dev/zero` must not be read whole to keep its first kilobytes. The
     * open does not block, anything but a regular file is no answer, and procfs
     * files, which report no size, are still read up to the limit.
     */
    async readText(path, maxBytes) {
      let handle;
      try {
        handle = await open(Buffer.from(pathBytes(path)), constants.O_RDONLY | constants.O_NONBLOCK);
      } catch (error) {
        if (isAbsent(error)) return undefined;
        throw error;
      }
      try {
        if (!(await handle.stat()).isFile()) {
          return undefined;
        }
        const buffer = Buffer.alloc(Math.max(0, maxBytes));
        let filled = 0;
        while (filled < buffer.length) {
          const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
          if (bytesRead === 0) {
            break;
          }
          filled += bytesRead;
        }
        return buffer.subarray(0, filled).toString("utf8");
      } catch (error) {
        if (isAbsent(error)) return undefined;
        throw error;
      } finally {
        await handle.close();
      }
    },
  };
}

/** A missing parent or a parent that is not a directory means this path is absent. */
function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Retain the same first sorted names as readdir+sort without retaining the full directory. */
function retainName(heap: Buffer[], name: Buffer): void {
  if (heap.length < MAX_ENTRIES) {
    heap.push(name);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (Buffer.compare(heap[parent] as Buffer, name) >= 0) break;
      heap[index] = heap[parent] as Buffer;
      index = parent;
    }
    heap[index] = name;
    return;
  }
  if (Buffer.compare(name, heap[0] as Buffer) >= 0) return;
  let index = 0;
  for (;;) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const largest = right < heap.length && Buffer.compare(heap[right] as Buffer, heap[left] as Buffer) > 0 ? right : left;
    if (Buffer.compare(name, heap[largest] as Buffer) >= 0) break;
    heap[index] = heap[largest] as Buffer;
    index = largest;
  }
  heap[index] = name;
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
