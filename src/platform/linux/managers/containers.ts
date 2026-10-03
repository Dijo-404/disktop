import { MANAGER_ACTIONS, type ManagerActionId, type ManagerItem } from "../../../domain/managers.js";
import type { Capability, Warning } from "../../../domain/models.js";
import { sanitizeText } from "../../../domain/paths.js";
import { parsePrintedSize } from "../../../domain/tool-output.js";
import type { ManagerAdapter, ManagerDiscovery, ManagerProposal } from "../../../ports/managers.js";
import type { ToolOutput, ToolPort } from "../../../ports/providers.js";
import { listedAgain, previewFrom } from "./support.js";

export type Engine = "docker" | "podman";

export interface ContainerPorts {
  readonly tools: ToolPort;
}

export const CONTAINER_QUERIES = {
  images: ["image", "ls", "--filter", "dangling=true", "--no-trunc", "--format", "{{.ID}}\t{{.Size}}"],
  containers: [
    "container",
    "ls",
    "--all",
    "--filter",
    "status=exited",
    "--filter",
    "status=created",
    "--no-trunc",
    "--format",
    "{{.ID}}\t{{.State}}",
  ],
  dockerVolumes: ["volume", "ls", "--filter", "dangling=true", "--format", "{{.Name}}"],
  dockerAnonymousVolumes: [
    "volume",
    "ls",
    "--filter",
    "dangling=true",
    "--filter",
    "label=com.docker.volume.anonymous",
    "--format",
    "{{.Name}}",
  ],
  podmanVolumes: ["volume", "ls", "--filter", "dangling=true", "--format", "{{.Name}}\t{{.Anonymous}}"],
  systemDf: ["system", "df", "--format", "{{json .}}"],
} as const;

interface Rows {
  readonly rows: readonly (readonly string[])[];
  readonly failure?: Capability;
}

const NAMED_VOLUME_WARNING =
  "A volume no container uses can still hold the only copy of a database. Disktop never offers a named volume; remove one yourself if you are sure.";

export function createContainerAdapter(engine: Engine, ports: ContainerPorts): ManagerAdapter {
  const name = engine === "docker" ? "Docker" : "Podman";
  const before = new Map<string, bigint | undefined>();

  async function rows(commandArguments: readonly string[]): Promise<Rows> {
    const answer: ToolOutput = await ports.tools.run(engine, commandArguments);
    if (answer.capability.status !== "available") {
      return { rows: [], failure: answer.capability };
    }
    return {
      rows: answer.stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => line.split("\t")),
    };
  }

  function checked(action: ManagerActionId, ids: readonly string[], warnings: Warning[]): readonly string[] {
    const pattern = MANAGER_ACTIONS[action].itemPattern as RegExp;
    return ids.filter((id) => {
      if (pattern.test(id)) {
        return true;
      }
      warnings.push({
        code: "manager-item-skipped",
        message: `${sanitizeText(id).slice(0, 80)} was left out: it is not an id Disktop will hand to ${engine}.`,
      });
      return false;
    });
  }

  async function images(warnings: Warning[]): Promise<readonly ManagerItem[] | Capability> {
    const listing = await rows(CONTAINER_QUERIES.images);
    if (listing.failure !== undefined) {
      return listing.failure;
    }
    const sizes = new Map<string, bigint | undefined>();
    const ids = listing.rows.map(([id, size]) => {
      const full = (id ?? "").startsWith("sha256:") ? (id as string) : `sha256:${id ?? ""}`;
      sizes.set(full, size === undefined ? undefined : parsePrintedSize(size, false));
      return full;
    });
    return checked(`${engine}.remove-dangling-images`, ids, warnings).map((id) => {
      const bytes = sizes.get(id);
      return bytes === undefined ? { id } : { id, bytes };
    });
  }

  async function stoppedContainers(warnings: Warning[]): Promise<readonly ManagerItem[] | Capability> {
    const listing = await rows(CONTAINER_QUERIES.containers);
    if (listing.failure !== undefined) {
      return listing.failure;
    }
    const ids = listing.rows
      .filter(([, state]) => state === "exited" || state === "created")
      .map(([id]) => id ?? "");
    return checked(`${engine}.remove-stopped-containers`, ids, warnings).map((id) => ({ id }));
  }

  async function volumes(
    warnings: Warning[],
  ): Promise<{ readonly anonymous: readonly ManagerItem[]; readonly named: readonly string[] } | Capability> {
    const listing = await rows(engine === "docker" ? CONTAINER_QUERIES.dockerVolumes : CONTAINER_QUERIES.podmanVolumes);
    if (listing.failure !== undefined) {
      return listing.failure;
    }
    let marked: ReadonlySet<string> | undefined;
    if (engine === "docker") {
      const filtered = await rows(CONTAINER_QUERIES.dockerAnonymousVolumes);
      if (filtered.failure !== undefined) {
        return filtered.failure;
      }
      marked = new Set(filtered.rows.map(([volume]) => volume ?? ""));
    }
    const anonymous: string[] = [];
    const named: string[] = [];
    for (const [volume, marker] of listing.rows) {
      const isAnonymous = marked === undefined ? marker === "true" : marked.has(volume ?? "");
      (isAnonymous ? anonymous : named).push(volume ?? "");
    }
    return {
      anonymous: checked(`${engine}.remove-anonymous-volumes`, anonymous, warnings).map((id) => ({ id })),
      named,
    };
  }

  async function buildCache(): Promise<bigint | undefined> {
    const listing = await rows(CONTAINER_QUERIES.systemDf);
    for (const [line] of listing.rows) {
      try {
        const row = JSON.parse(line ?? "") as { Type?: unknown; Reclaimable?: unknown };
        if (row.Type === "Build Cache" && typeof row.Reclaimable === "string") {
          return parsePrintedSize(row.Reclaimable, false);
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }

  function exact(action: ManagerActionId, title: string, items: readonly ManagerItem[], evidence: readonly string[]): ManagerProposal {
    const measured = items.length > 0 && items.every((item) => item.bytes !== undefined);
    return {
      action,
      title,
      evidence,
      items,
      count: { kind: "exact", value: BigInt(items.length) },
      ...(measured ? { estimatedBytes: items.reduce((total, item) => total + (item.bytes ?? 0n), 0n) } : {}),
      bytesBasis: measured ? "manager-reported" : "unknown",
      preview: "listed",
      offered: items.length > 0,
      parameters: {},
    };
  }

  async function discover(): Promise<ManagerDiscovery> {
    const warnings: Warning[] = [];
    const imageItems = await images(warnings);
    if (!Array.isArray(imageItems)) {
      return { adapter: engine, capability: explain(imageItems as Capability), proposals: [], warnings: [] };
    }
    const containerItems = await stoppedContainers(warnings);
    const volumeItems = await volumes(warnings);
    const proposals: ManagerProposal[] = [
      exact(`${engine}.remove-dangling-images`, `${name} images nothing refers to`, imageItems, [
        `${imageItems.length} image(s) have no tag and no container refers to them.`,
      ]),
    ];
    if (Array.isArray(containerItems)) {
      proposals.push(
        exact(`${engine}.remove-stopped-containers`, `Stopped ${name} containers`, containerItems, [
          `${containerItems.length} container(s) have exited or were never started.`,
        ]),
      );
    }
    if (!("status" in volumeItems)) {
      proposals.push(
        exact(`${engine}.remove-anonymous-volumes`, `Anonymous ${name} volumes no container uses`, volumeItems.anonymous, [
          `${volumeItems.anonymous.length} volume(s) were created without a name and no container uses them.`,
        ]),
      );
      if (volumeItems.named.length > 0) {
        proposals.push({
          action: `${engine}.remove-anonymous-volumes`,
          slug: `${engine}.named-volumes`,
          title: `Named ${name} volumes no container uses`,
          evidence: [
            `${volumeItems.named.length} named volume(s) are not used by any container: ${sanitizeText(volumeItems.named.slice(0, 10).join(", "))}${volumeItems.named.length > 10 ? ", …" : ""}.`,
            NAMED_VOLUME_WARNING,
          ],
          items: [],
          count: { kind: "exact", value: BigInt(volumeItems.named.length) },
          bytesBasis: "unknown",
          preview: "listed",
          offered: false,
          parameters: {},
        });
      }
    }
    if (engine === "docker") {
      const reclaimable = await buildCache();
      proposals.push({
        action: "docker.prune-build-cache",
        title: "Docker build cache nothing refers to",
        evidence: ["Docker's own system df figure for build cache it could reclaim."],
        items: [],
        count: { kind: "unknown" },
        ...(reclaimable === undefined ? {} : { estimatedBytes: reclaimable }),
        bytesBasis: reclaimable === undefined ? "unknown" : "manager-reported",
        preview: "none",
        offered: reclaimable !== undefined && reclaimable > 0n,
        parameters: {},
      });
    } else {
      warnings.push({
        code: "manager-unsupported",
        message: "Podman keeps build layers as images, so the dangling-image proposal is where its build cache is cleaned.",
      });
    }
    return {
      adapter: engine,
      capability: { status: "available", explanation: `${engine} answered.` },
      proposals,
      warnings,
    };
  }

  function explain(capability: Capability): Capability {
    if (capability.status !== "permission-denied") {
      return capability;
    }
    return {
      status: "permission-denied",
      explanation:
        engine === "docker"
          ? "This user may not reach the Docker daemon. Join the docker group or use rootless Docker; Disktop does not escalate Docker."
          : "This user may not reach Podman's storage. Use rootless Podman; Disktop does not escalate Podman.",
    };
  }

  async function presentFor(action: ManagerActionId): Promise<ReadonlySet<string> | undefined> {
    const ignored: Warning[] = [];
    const listed =
      action === `${engine}.remove-dangling-images`
        ? await images(ignored)
        : action === `${engine}.remove-stopped-containers`
          ? await stoppedContainers(ignored)
          : await volumes(ignored).then((result) => ("status" in result ? result : result.anonymous));
    return Array.isArray(listed) ? new Set(listed.map((item) => item.id)) : undefined;
  }

  return {
    id: engine,
    discover,
    preview: (action) => previewFrom(discover, action),
    async preflight(scope) {
      if (scope.action === "docker.prune-build-cache") {
        before.set(scope.action, await buildCache());
        return { skipped: new Map() };
      }
      const present = await presentFor(scope.action);
      if (present === undefined) {
        return { refusal: `${engine} could not be asked what is there now.`, skipped: new Map() };
      }
      const skipped = new Map<number, string>();
      scope.items.forEach((item, position) => {
        if (!present.has(item.id)) {
          skipped.set(position, "It is in use again, or already gone.");
        }
      });
      return { skipped };
    },
    async verify(scope, attempted) {
      if (scope.action === "docker.prune-build-cache") {
        const earlier = before.get(scope.action);
        const after = await buildCache();
        return {
          verdicts: new Map(),
          observed: [],
          checks: [
            earlier === undefined || after === undefined
              ? { check: "manager-verified", outcome: "unavailable", detail: "Docker's build cache could not be read on both sides." }
              : after <= earlier
                ? { check: "manager-verified", outcome: "passed", detail: `Reclaimable build cache went from ${earlier} to ${after} bytes.` }
                : { check: "manager-verified", outcome: "failed", detail: `Reclaimable build cache grew from ${earlier} to ${after} bytes.` },
          ],
        };
      }
      const present = await presentFor(scope.action);
      return listedAgain(scope, attempted, present, engine);
    },
    async spacePath() {
      return engine === "docker" ? "/var/lib/docker" : undefined;
    },
  };
}
