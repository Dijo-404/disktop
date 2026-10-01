import { findingSize, type Finding } from "../../domain/findings.js";
import type { RawPath, Warning } from "../../domain/models.js";
import type { DiscoveryEnvironment, FindingProvider } from "../../ports/providers.js";
import { absolutePath, buildFinding } from "../support.js";

const ID = "diagnostic.per-user";
const VERSION = 1;

const PASSWD = "/etc/passwd";
/** A passwd file is lines of short records; this is far more than enough. */
const PASSWD_BYTES = 1024 * 1024;

export interface PerUserOptions {
  readonly passwdFile?: RawPath;
}

/**
 * Who the bytes belong to, for the scan that already ran.
 *
 * This is the question a shared machine asks, and it is answered from the
 * index rather than by walking again: the helper groups the scan's regular
 * files by owning user id, excluding directory rows and second hardlinks for
 * the same reason the per-extension totals do.
 *
 * A name is resolved from /etc/passwd when that is readable and the numeric id
 * is used when it is not, which is honest about what was actually learned. A
 * partial scan makes every total here a floor rather than a total, and the
 * finding says so instead of presenting a short number as a complete one.
 */
export function createPerUserProvider(options: PerUserOptions = {}): FindingProvider {
  const passwdFile = options.passwdFile ?? (absolutePath(PASSWD) as RawPath);

  return {
    id: ID,
    version: VERSION,
    categories: ["per-user-usage"],

    async probe() {
      return { status: "available", explanation: "Owner totals are read from the stored scan index." };
    },

    async discover(environment) {
      const reading = await environment.index.ownerTotals(environment.maxFindingsPerProvider);
      if (!reading.searched) {
        return {
          findings: [],
          warnings: [
            {
              code: "no-stored-scan",
              message:
                "No stored scan covers the home directory, so per-user usage was not worked out. Run 'disktop scan ~' first.",
            },
          ],
          complete: false,
        };
      }

      const names = await userNames(environment, passwdFile);
      const warnings: Warning[] = [];
      if (names.size === 0) {
        warnings.push({
          code: "passwd-unreadable",
          message: `${passwdFile.display} could not be read, so users are identified by their numeric id.`,
        });
      }

      const findings: Finding[] = reading.owners.map((owner) => {
        const name = names.get(owner.ownerId);
        return buildFinding({
          providerId: ID,
          providerVersion: VERSION,
          category: "per-user-usage",
          slug: `owner-${owner.ownerId}`,
          title: `${name ?? `User ${owner.ownerId}`} owns ${owner.entries} files in the last scan`,
          evidence: [
            name === undefined
              ? `No name for user id ${owner.ownerId} was found, so the id is used.`
              : `User id ${owner.ownerId} is ${name}.`,
            "Counted over regular files only: directory rows carry their subtree, and a second hardlink carries bytes already attributed elsewhere.",
            reading.complete
              ? "The scan these totals come from reached everything in its scope."
              : "The scan these totals come from was partial, so this is a floor and not a total.",
          ],
          size: findingSize(
            owner.allocatedBytes,
            "measured-allocated",
            reading.complete
              ? "Blocks on disk, summed over the files this user owns in the last scan."
              : "Blocks on disk over the part of the tree the last scan reached; the real figure is larger.",
          ),
          confidence: reading.complete ? "observed" : "uncertain",
          active: true,
          actions: [],
        });
      });

      return { findings, warnings, complete: reading.complete && warnings.length === 0 };
    },
  };
}

/** `name:x:uid:...` for every account, when /etc/passwd can be read. */
async function userNames(
  environment: DiscoveryEnvironment,
  passwdFile: RawPath,
): Promise<ReadonlyMap<bigint, string>> {
  const text = await environment.paths.readText(passwdFile, PASSWD_BYTES);
  const names = new Map<bigint, string>();
  if (text === undefined) {
    return names;
  }
  for (const line of text.split("\n")) {
    const fields = line.split(":");
    const name = fields[0];
    const id = fields[2];
    if (name === undefined || name === "" || id === undefined || !/^[0-9]+$/.test(id)) {
      continue;
    }
    names.set(BigInt(id), name);
  }
  return names;
}
