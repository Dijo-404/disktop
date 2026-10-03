import { MANAGER_ACTIONS } from "../../../domain/managers.js";
import type { ManagerItem } from "../../../domain/managers.js";
import type { Warning } from "../../../domain/models.js";
import { rawPathFromUtf8, sanitizeText } from "../../../domain/paths.js";
import type { ManagerAdapter, ManagerDiscovery } from "../../../ports/managers.js";
import type { PathProbe, ToolPort } from "../../../ports/providers.js";
import { listedAgain, previewFrom } from "./support.js";

export interface SnapPorts {
  readonly tools: ToolPort;
  readonly paths: PathProbe;
}

interface Revision {
  readonly id: string;
  readonly disabled: boolean;
}

/** `snap list --all`: a header, then name, version, rev, tracking, publisher, notes. */
export function parseSnapRevisions(text: string): { readonly revisions: readonly Revision[]; readonly unreadable: readonly string[] } {
  const revisions: Revision[] = [];
  const unreadable: string[] = [];
  const pattern = MANAGER_ACTIONS["snap.remove-disabled"].itemPattern as RegExp;
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6) {
      continue;
    }
    const id = `${fields[0]}=${fields[2]}`;
    const notes = (fields[fields.length - 1] as string).split(",");
    if (!pattern.test(id)) {
      unreadable.push(id);
      continue;
    }
    revisions.push({ id, disabled: notes.includes("disabled") });
  }
  return { revisions, unreadable };
}

export function createSnapAdapter(ports: SnapPorts): ManagerAdapter {
  async function revisions(): Promise<ReturnType<typeof parseSnapRevisions> | ManagerDiscovery> {
    const answer = await ports.tools.run("snap", ["list", "--all"]);
    if (answer.capability.status !== "available") {
      return { adapter: "snap", capability: answer.capability, proposals: [], warnings: [] };
    }
    return parseSnapRevisions(answer.stdout);
  }

  async function discover(): Promise<ManagerDiscovery> {
    const listing = await revisions();
    if ("adapter" in listing) {
      return listing;
    }
    const items: ManagerItem[] = [];
    for (const revision of listing.revisions.filter((entry) => entry.disabled)) {
      const [name, rev] = revision.id.split("=");
      const facts = await ports.paths.facts(rawPathFromUtf8(`/var/lib/snapd/snaps/${name as string}_${rev as string}.snap`));
      items.push({ id: revision.id, ...(facts === undefined ? {} : { bytes: facts.allocatedBytes }) });
    }
    const warnings: Warning[] = listing.unreadable.map((id) => ({
      code: "manager-item-skipped",
      message: `${sanitizeText(id)} was left out: it is not a name Disktop will hand to snap.`,
    }));
    const measured = items.every((item) => item.bytes !== undefined);
    return {
      adapter: "snap",
      capability: { status: "available", explanation: "snap answered." },
      proposals: [
        {
          action: "snap.remove-disabled",
          title: "Disabled snap revisions",
          evidence: [
            `${items.length} revision(s) are installed and disabled; snapd keeps them so a refresh can be reverted.`,
            "Each is removed by its own `snap remove NAME --revision=REV`, so the active revision is never named.",
          ],
          items,
          count: { kind: "exact", value: BigInt(items.length) },
          ...(measured ? { estimatedBytes: items.reduce((total, item) => total + (item.bytes ?? 0n), 0n) } : {}),
          bytesBasis: measured ? "stat" : "unknown",
          preview: "listed",
          offered: items.length > 0,
          parameters: {},
        },
      ],
      warnings,
    };
  }

  async function disabledNow(): Promise<ReadonlySet<string> | undefined> {
    const listing = await revisions();
    return "adapter" in listing ? undefined : new Set(listing.revisions.filter((entry) => entry.disabled).map((entry) => entry.id));
  }

  return {
    id: "snap",
    discover,
    preview: (action) => previewFrom(discover, action),
    async preflight(scope) {
      const disabled = await disabledNow();
      if (disabled === undefined) {
        return { refusal: "snap could not be asked which revisions are disabled now.", skipped: new Map() };
      }
      const skipped = new Map<number, string>();
      scope.items.forEach((item, position) => {
        if (!disabled.has(item.id)) {
          skipped.set(position, "That revision is no longer an installed, disabled one.");
        }
      });
      return { skipped };
    },
    async verify(scope, attempted) {
      const listing = await revisions();
      const present = "adapter" in listing ? undefined : new Set(listing.revisions.map((entry) => entry.id));
      return listedAgain(scope, attempted, present, "snap");
    },
    async spacePath() {
      return "/var/lib/snapd/snaps";
    },
  };
}
