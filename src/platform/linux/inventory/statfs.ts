import { spawn } from "node:child_process";
import { toolEnvironment } from "../process.js";
import type { StatfsReading } from "./index.js";

const TIMEOUT_MILLISECONDS = 4_500;
const MAX_OUTPUT_BYTES = 4_096;
const MAX_UNREAPED_CHILDREN = 8;
const SCRIPT = `
import { statfs } from "node:fs/promises";
try {
  const result = await statfs(Buffer.from(process.argv[1], "base64"), { bigint: true });
  console.log(JSON.stringify([result.bsize, result.blocks, result.bfree, result.bavail, result.files, result.ffree].map(String)));
} catch (error) {
  console.error(typeof error.code === "string" ? error.code : "EIO");
  process.exitCode = 1;
}
`;

/**
 * A hard network mount can block statfs in uninterruptible kernel I/O. Isolate
 * it from Node's worker pool so it cannot stall journals, config or local scans.
 * Timed-out children remain remembered until reaped and are never piled up.
 */
export function createStatfsReader(): (mountPoint: Uint8Array) => Promise<StatfsReading> {
  const unreaped = new Map<string, Promise<StatfsReading>>();
  return (mountPoint) => {
    const key = Buffer.from(mountPoint).toString("base64");
    const earlier = unreaped.get(key);
    if (earlier !== undefined) {
      return earlier;
    }
    if (unreaped.size >= MAX_UNREAPED_CHILDREN) {
      return Promise.reject(failure("ETIMEDOUT"));
    }
    let start: (() => void) | undefined;
    const pending = new Promise<StatfsReading>((resolve, reject) => {
      // Start after the map owns the promise, including synchronous spawn failures.
      start = () => {
        const child = spawn(process.execPath, ["--input-type=module", "--eval", SCRIPT, key], {
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: toolEnvironment(process.env),
        });
        let output = "";
        let diagnostic = "";
        let settled = false;
        const settle = (reading: StatfsReading | Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (reading instanceof Error) reject(reading);
          else resolve(reading);
        };
        const stop = (code: string): void => {
          child.kill("SIGKILL");
          child.stdout.destroy();
          child.stderr.destroy();
          // A kernel-stuck child takes SIGKILL once I/O returns. Its handles
          // cannot hold the CLI open, and close is still observed to release it.
          child.unref();
          settle(failure(code));
        };
        const timer = setTimeout(() => stop("ETIMEDOUT"), TIMEOUT_MILLISECONDS);
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          output += chunk;
          if (output.length > MAX_OUTPUT_BYTES) stop("EOVERFLOW");
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          diagnostic = (diagnostic + chunk).slice(0, 64);
        });
        child.stdout.on("error", () => stop("EIO"));
        child.stderr.on("error", () => stop("EIO"));
        child.on("error", (error) => {
          if (unreaped.get(key) === pending) unreaped.delete(key);
          settle(error);
        });
        child.on("close", (code) => {
          if (unreaped.get(key) === pending) unreaped.delete(key);
          if (code !== 0) {
            settle(failure(/^[A-Z][A-Z0-9_]+$/.test(diagnostic.trim()) ? diagnostic.trim() : "EIO"));
            return;
          }
          try {
            settle(parseReading(output));
          } catch {
            settle(failure("EIO"));
          }
        });
      };
    });
    unreaped.set(key, pending);
    try {
      start?.();
    } catch (error) {
      unreaped.delete(key);
      return Promise.reject(error);
    }
    return pending;
  };
}

function parseReading(output: string): StatfsReading {
  const values: unknown = JSON.parse(output);
  if (!Array.isArray(values) || values.length !== 6 ||
    !values.every((value) => typeof value === "string" && /^[0-9]+$/.test(value))) {
    throw failure("EIO");
  }
  const [blockSize, blocks, freeBlocks, availableBlocks, totalInodes, freeInodes] = values.map((value) => BigInt(value as string));
  return { blockSize: blockSize as bigint, blocks: blocks as bigint, freeBlocks: freeBlocks as bigint,
    availableBlocks: availableBlocks as bigint, totalInodes: totalInodes as bigint, freeInodes: freeInodes as bigint };
}

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Filesystem capacity could not be read (${code}).`), { code });
}
