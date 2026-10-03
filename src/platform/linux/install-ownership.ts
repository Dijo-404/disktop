import { readFileSync } from "node:fs";
import { lstat as readLstat, readdir as readDirectory, realpath as resolveRealpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sanitizeText } from "../../domain/paths.js";

export interface OwnershipReader {
  lstat(path: string): Promise<{ readonly uid: number; readonly mode: number; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  readdir(path: string): Promise<readonly string[]>;
  /** Where a link finally leads, with every link on the way resolved. */
  realpath(path: string): Promise<string>;
}

const NODE_READER: OwnershipReader = {
  lstat: (path) => readLstat(path),
  readdir: (path) => readDirectory(path),
  realpath: (path) => resolveRealpath(path),
};

const MAX_ENTRIES = 100_000;

export type OwnershipOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const refuse = (path: string, why: string): OwnershipOutcome => ({ ok: false, reason: `${sanitizeText(path)} ${why}` });
const writableByOthers = (mode: number): boolean => (mode & 0o022) !== 0;

/**
 * Every directory above a path is root's and closed to other accounts, apart
 * from sticky ones like /tmp, where nobody can rename what they do not own.
 * Whoever can rename a directory on the way can swap what is below it.
 */
async function verifyAncestors(path: string, reader: OwnershipReader): Promise<OwnershipOutcome | undefined> {
  for (let ancestor = dirname(path); ; ancestor = dirname(ancestor)) {
    const facts = await reader.lstat(ancestor);
    if (facts.uid !== 0 || (writableByOthers(facts.mode) && (facts.mode & 0o1000) === 0)) {
      return refuse(ancestor, "is not owned by root and closed to other accounts, so whoever can write it can replace Disktop.");
    }
    if (ancestor === dirname(ancestor)) {
      return undefined;
    }
  }
}

/** Root may run only code no other account can change: every entry and every ancestor. */
export async function verifyRootOwnedInstall(packageRoot: string, reader: OwnershipReader = NODE_READER): Promise<OwnershipOutcome> {
  const above = await verifyAncestors(packageRoot, reader);
  if (above !== undefined) {
    return above;
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
    if (facts.isSymbolicLink()) {
      // A link's own mode means nothing, but where it leads does: Node follows
      // it to load a module. A target inside the install is checked by this
      // walk; one outside it — `npm link` leaves these — is code nobody here
      // has looked at, and a target that does not exist yet is code whoever
      // creates it gets to choose.
      let target: string;
      try {
        target = await reader.realpath(path);
      } catch {
        return refuse(path, "is a link that leads nowhere, so whoever creates its target chooses what root runs.");
      }
      if (target !== packageRoot && !target.startsWith(`${packageRoot}/`)) {
        return refuse(path, `is a link to ${sanitizeText(target)}, outside the install, which this check cannot vouch for.`);
      }
      continue;
    }
    if (writableByOthers(facts.mode)) {
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

/**
 * The Node binary is code root runs too.
 *
 * `sudo env PATH=$PATH disktop` with Node from a version manager in the
 * user's home would run, as root, a binary every one of the user's own
 * processes can replace — the escalation the install check exists to stop.
 */
export async function verifyRootOwnedExecutable(executable: string, reader: OwnershipReader = NODE_READER): Promise<OwnershipOutcome> {
  const above = await verifyAncestors(executable, reader);
  if (above !== undefined) {
    return above;
  }
  const facts = await reader.lstat(executable);
  if (facts.uid !== 0 || writableByOthers(facts.mode)) {
    return refuse(executable, "is not owned by root and closed to other accounts, so whoever can write it can run code as root.");
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
