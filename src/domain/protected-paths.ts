import type { OperationFailureCode } from "./errors.js";
import type { RawPath } from "./models.js";
import { bytesEqual, isAbsoluteNormalized, isWithin, pathBytes, rawPathFromUtf8 } from "./paths.js";

/**
 * Roots that generic cleanup can never target, directly or as a descendant.
 * `/` matches only itself here; everything below it is judged by the rest of
 * this policy. There is no option that overrides this list.
 */
export const PROTECTED_ROOTS: readonly string[] = [
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/efi",
  "/etc",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/opt",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/srv",
  "/sys",
  "/usr",
  "/var",
];

/**
 * Roots that hold many users' or many programs' data. They may be an ancestor
 * of an allowed root, but they are never a target themselves and can never be
 * added to the allowlist: `/home` would otherwise reach every other account.
 */
export const SHARED_CONTAINER_ROOTS: readonly string[] = [
  "/home",
  "/media",
  "/mnt",
  "/run/media",
  "/tmp",
  "/var/tmp",
];

/** True when a path may not be configured as a root generic cleanup acts in. */
export function isRefusedAsAllowedRoot(path: string): boolean {
  const bytes = pathBytes(rawPathFromUtf8(path));
  if (!isAbsoluteNormalized(bytes)) {
    return true;
  }
  if (containerRootBytes.some((root) => bytesEqual(root, bytes))) {
    return true;
  }
  return protectedRootBytes.some((root) =>
    bytesEqual(root, ROOT) ? bytesEqual(bytes, ROOT) : isWithin(root, bytes),
  );
}

export interface ProtectedPathContext {
  readonly homeDirectory: RawPath;
  /** User-owned roots generic cleanup may act inside. */
  readonly allowedRoots: readonly RawPath[];
  /** Mount points observed in /proc/self/mountinfo, including bind mounts. */
  readonly mountRoots: readonly RawPath[];
  /** Trash, Disktop state, swap, active logs, and other named exclusions. */
  readonly excludedRoots: readonly RawPath[];
}

export type TargetVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: OperationFailureCode; readonly reason: string };

const protectedRootBytes = PROTECTED_ROOTS.map((root) => pathBytes(rawPathFromUtf8(root)));
const containerRootBytes = SHARED_CONTAINER_ROOTS.map((root) => pathBytes(rawPathFromUtf8(root)));
const ROOT = protectedRootBytes[0] as Uint8Array;

/**
 * Pure policy over path bytes. It cannot see the filesystem, so it does not
 * prove mount identity, ownership, or that a parent is safe to write in; the
 * helper repeats and extends these checks against live descriptors.
 *
 * Every rule that depends on context fails closed: an empty `mountRoots` or
 * `excludedRoots` is treated as a caller that could not read the system, not
 * as a system with nothing to protect.
 */
export function classifyGenericTarget(target: RawPath, context: ProtectedPathContext): TargetVerdict {
  const bytes = pathBytes(target);

  if (context.mountRoots.length === 0 || context.excludedRoots.length === 0) {
    return refuse("invalid-plan", "The mount and excluded-root context is incomplete, so no target can be cleared");
  }

  if (!isAbsoluteNormalized(bytes)) {
    return refuse("invalid-plan", "A target must be an absolute path with no empty, '.', or '..' segment");
  }

  if (containerRootBytes.some((root) => bytesEqual(root, bytes))) {
    return refuse("protected-path", "The target is a shared container root holding other accounts' or programs' data");
  }

  for (const root of protectedRootBytes) {
    const hit = bytesEqual(root, ROOT) ? bytesEqual(bytes, ROOT) : isWithin(root, bytes);
    if (hit) {
      return refuse("protected-path", "The target is a protected system root or below one");
    }
  }

  if (bytesEqual(bytes, pathBytes(context.homeDirectory))) {
    return refuse("protected-path", "The home directory itself is never a cleanup target");
  }

  for (const mount of context.mountRoots) {
    if (bytesEqual(bytes, pathBytes(mount))) {
      return refuse("protected-path", "The target is a mount root");
    }
    if (isWithin(bytes, pathBytes(mount))) {
      return refuse("protected-path", "The target has another filesystem's mount point below it");
    }
  }

  for (const excluded of context.excludedRoots) {
    if (isWithin(pathBytes(excluded), bytes)) {
      return refuse("protected-path", "The target is inside Trash, Disktop state, or another excluded root");
    }
  }

  if (context.allowedRoots.some((root) => bytesEqual(pathBytes(root), bytes))) {
    return refuse("protected-path", "An allowed root is the scope of cleanup, never its target");
  }

  const container = context.allowedRoots.find((root) => isWithin(pathBytes(root), bytes));
  if (container === undefined) {
    return refuse("protected-path", "The target is outside every allowed root");
  }
  if (containerRootBytes.some((root) => bytesEqual(root, pathBytes(container)))) {
    return refuse("protected-path", "A shared container root cannot be widened into an allowed root");
  }

  return { allowed: true };
}

function refuse(code: OperationFailureCode, reason: string): TargetVerdict {
  return { allowed: false, code, reason };
}

/**
 * Whether a move or a compress may publish into this directory.
 *
 * This is deliberately a different question from `classifyGenericTarget`, and
 * getting it wrong in either direction is a real failure. A target is
 * something Disktop removes, so it has to be inside a root the user said
 * Disktop may clean. A destination is somewhere Disktop writes, and the whole
 * point of a cross-disk move is that the other disk is not inside the home
 * directory — `/mnt/archive` is a correct answer here and an incorrect one
 * there.
 *
 * So the allowlist does not apply, and neither does the mount-root rule: the
 * second disk's mount point is exactly where somebody means to publish. What
 * does apply is everything that says "this is not yours to write into": the
 * protected system roots, the shared container roots themselves, and Trash and
 * Disktop's own state, where an archive would be mistaken for rubbish or for
 * Disktop's own records.
 *
 * Like the rest of this module it reads bytes and cannot see the filesystem.
 * It does not prove the directory exists, that it is a directory, or that this
 * user may write in it; the planner stats it and the helper repeats every
 * check against a live descriptor.
 */
export function classifyDestination(
  destination: RawPath,
  context: ProtectedPathContext,
): TargetVerdict {
  const bytes = pathBytes(destination);

  if (context.mountRoots.length === 0 || context.excludedRoots.length === 0) {
    return refuse(
      "invalid-plan",
      "The mount and excluded-root context is incomplete, so no destination can be approved",
    );
  }

  if (!isAbsoluteNormalized(bytes)) {
    return refuse(
      "invalid-plan",
      "A destination must be an absolute path with no empty, '.', or '..' segment",
    );
  }

  if (containerRootBytes.some((root) => bytesEqual(root, bytes))) {
    return refuse(
      "protected-path",
      "The destination is a shared container root holding other accounts' or programs' data; publish into a directory inside it instead",
    );
  }

  for (const root of protectedRootBytes) {
    const hit = bytesEqual(root, ROOT) ? bytesEqual(bytes, ROOT) : isWithin(root, bytes);
    if (hit) {
      return refuse("protected-path", "The destination is a protected system root or below one");
    }
  }

  for (const excluded of context.excludedRoots) {
    if (isWithin(pathBytes(excluded), bytes)) {
      return refuse(
        "protected-path",
        "The destination is inside Trash, Disktop state, or another excluded root",
      );
    }
  }

  return { allowed: true };
}
