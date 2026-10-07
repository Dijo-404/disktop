import { findingSize, type Finding } from "../../domain/findings.js";
import type { RawPath } from "../../domain/models.js";
import type { FindingProvider } from "../../ports/providers.js";
import { absolutePath, buildFinding, childDirectories, exists } from "../support.js";

const ID = "diagnostic.windows-subsystem";
const VERSION = 1;

const VERSION_FILE = "/proc/version";
const WINDOWS_MOUNT_ROOT = "/mnt";

export interface WindowsSubsystemOptions {
  readonly versionFile?: RawPath;
  readonly mountRoot?: RawPath;
}

/**
 * Whether this is a Windows Subsystem for Linux machine, and what that hides.
 *
 * Under WSL the Windows drives appear under `/mnt`, and Disktop excludes them
 * by default: they are a different filesystem reached through a translation
 * layer, scanning them is slow, and nothing Disktop could offer there would be
 * safe. A person looking at a total that leaves out their C: drive should be
 * told that is what happened.
 */
export function createWindowsSubsystemProvider(options: WindowsSubsystemOptions = {}): FindingProvider {
  const versionFile = options.versionFile ?? (absolutePath(VERSION_FILE) as RawPath);
  const mountRoot = options.mountRoot ?? (absolutePath(WINDOWS_MOUNT_ROOT) as RawPath);

  return {
    id: ID,
    version: VERSION,
    categories: ["diagnostic"],

    async probe(environment) {
      const text = await environment.paths.readText(versionFile, 4096);
      if (text === undefined || !/microsoft|wsl/i.test(text)) {
        return { status: "missing-tool", explanation: "This is not a Windows Subsystem for Linux machine." };
      }
      return { status: "available", explanation: `${versionFile.display} names Microsoft or WSL.` };
    },

    async discover(environment) {
      const mounts = (await exists(environment, mountRoot))
        ? (await childDirectories(environment, mountRoot)).map((path) => path.display)
        : [];

      const finding: Finding = buildFinding({
        providerId: ID,
        providerVersion: VERSION,
        category: "diagnostic",
        slug: "windows-mounts-excluded",
        title: "Windows drives are excluded from scans by default",
        evidence: [
          "This machine runs under the Windows Subsystem for Linux.",
          mounts.length === 0
            ? `Nothing is mounted under ${mountRoot.display} right now.`
            : `Mounted under ${mountRoot.display}: ${mounts.join(", ")}.`,
          "Disktop's default excludes skip /mnt/c and /mnt/wsl, so any total you see leaves out what is on the Windows side.",
          "To scan a Windows path, set exclude_windows_mounts = false in the [scan] section of config.toml, then select that path. Nothing there is offered for cleanup.",
        ],
        size: findingSize(undefined, "unknown", "Excluded paths are not measured, which is the point of excluding them."),
        confidence: "observed",
        active: true,
        actions: [],
      });

      return { findings: [finding], warnings: [], complete: true };
    },
  };
}
