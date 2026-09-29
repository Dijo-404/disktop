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
const ROOT = protectedRootBytes[0] as Uint8Array;

/**
 * Pure policy over path bytes. It cannot see the filesystem, so it does not
 * prove mount identity, ownership, or that a parent is safe to write in; the
 * helper repeats and extends these checks against live descriptors.
 */
export function classifyGenericTarget(target: RawPath, context: ProtectedPathContext): TargetVerdict {
  const bytes = pathBytes(target);

  if (!isAbsoluteNormalized(bytes)) {
    return refuse("invalid-plan", "A target must be an absolute path with no empty, '.', or '..' segment");
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
  }

  for (const excluded of context.excludedRoots) {
    if (isWithin(pathBytes(excluded), bytes)) {
      return refuse("protected-path", "The target is inside Trash, Disktop state, or another excluded root");
    }
  }

  const inAllowedRoot = context.allowedRoots.some((root) => isWithin(pathBytes(root), bytes));
  if (!inAllowedRoot) {
    return refuse("protected-path", "The target is outside every allowed root");
  }

  return { allowed: true };
}

function refuse(code: OperationFailureCode, reason: string): TargetVerdict {
  return { allowed: false, code, reason };
}
