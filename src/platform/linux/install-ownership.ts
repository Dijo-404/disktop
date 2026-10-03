import { readFileSync } from "node:fs";
import { lstat as readLstat, readdir as readDirectory } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sanitizeText } from "../../domain/paths.js";

export interface OwnershipReader {
  lstat(path: string): Promise<{ readonly uid: number; readonly mode: number; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  readdir(path: string): Promise<readonly string[]>;
}

const NODE_READER: OwnershipReader = {
  lstat: (path) => readLstat(path),
  readdir: (path) => readDirectory(path),
};

const MAX_ENTRIES = 100_000;

export type OwnershipOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Root may run only code no other account can change: every entry and every ancestor. */
export async function verifyRootOwnedInstall(packageRoot: string, reader: OwnershipReader = NODE_READER): Promise<OwnershipOutcome> {
  const refuse = (path: string, why: string): OwnershipOutcome => ({ ok: false, reason: `${sanitizeText(path)} ${why}` });
  const writableByOthers = (mode: number) => (mode & 0o022) !== 0;

  for (let path = dirname(packageRoot); ; path = dirname(path)) {
    const facts = await reader.lstat(path);
    if (facts.uid !== 0 || (writableByOthers(facts.mode) && (facts.mode & 0o1000) === 0)) {
      return refuse(path, "is not owned by root and closed to other accounts, so whoever can write it can replace Disktop.");
    }
    if (path === dirname(path)) {
      break;
    }
  }

  const pending = [packageRoot];
  let seen = 0;
  while (pending.length > 0) {
    const path = pending.pop() as string;
    seen += 1;
    if (seen > MAX_ENTRIES) {
      return refuse(packageRoot, "holds too many files to verify.");
    }
    const facts = await reader.lstat(path);
    if (facts.uid !== 0) {
      return refuse(path, "is not owned by root.");
    }
    if (!facts.isSymbolicLink() && writableByOthers(facts.mode)) {
      return refuse(path, "can be written by an account other than root.");
    }
    if (facts.isDirectory()) {
      for (const name of await reader.readdir(path)) {
        pending.push(join(path, name));
      }
    }
  }
  return { ok: true };
}

/** Root inside an unprivileged user namespace has only its creator's power. */
export function inInitialUserNamespace(uidMap: string | undefined = readUidMap()): boolean {
  if (uidMap === undefined) {
    return true;
  }
  return uidMap
    .split("\n")
    .some((line) => line.trim().split(/\s+/).join(" ") === "0 0 4294967295");
}

function readUidMap(): string | undefined {
  try {
    return readFileSync("/proc/self/uid_map", "utf8");
  } catch {
    return undefined;
  }
}
