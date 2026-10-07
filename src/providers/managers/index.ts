import { findingSize, type Finding, type FindingCategory } from "../../domain/findings.js";
import { MANAGER_ACTIONS, describeCommand, type ManagerAdapterId, type ManagerCommand } from "../../domain/managers.js";
import type { Warning } from "../../domain/models.js";
import type { ManagerInventoryPort, ManagerProposal } from "../../ports/managers.js";
import type { FindingProvider } from "../../ports/providers.js";
import { buildFinding, safeText } from "../support.js";

const ID = "managers";
const VERSION = 1;

const CATEGORIES: Readonly<Record<ManagerAdapterId, FindingCategory>> = {
  apt: "package-cache",
  dnf: "package-cache",
  pacman: "package-cache",
  journald: "log",
  snap: "installed-app",
  flatpak: "installed-app",
  docker: "container-data",
  podman: "container-data",
  kernels: "old-kernel",
  tmpfiles: "temporary",
};

function categoryOf(proposal: ManagerProposal): FindingCategory {
  return proposal.action === "tmpfiles.clean-crash" ? "crash-dump" : CATEGORIES[MANAGER_ACTIONS[proposal.action].adapter];
}

export function createManagerProvider(inventory: ManagerInventoryPort): FindingProvider {
  return {
    id: ID,
    version: VERSION,
    categories: ["package-cache", "log", "installed-app", "container-data", "old-kernel", "temporary", "crash-dump"],

    async probe() {
      return { status: "available", explanation: "Manager adapters are asked during discovery." };
    },

    async discover(_environment, signal) {
      const findings: Finding[] = [];
      const warnings: Warning[] = [];
      let complete = true;
      for (const discovery of await inventory.discover(signal)) {
        warnings.push(...discovery.warnings);
        if (discovery.warnings.some((warning) => warning.code === "manager-failed")) complete = false;
        if (discovery.capability.status === "permission-denied") {
          complete = false;
          warnings.push({
            code: "manager-denied",
            message: `${discovery.adapter} could not be read: ${discovery.capability.explanation}`,
          });
          continue;
        }
        if (discovery.capability.status !== "available") {
          continue;
        }
        for (const proposal of discovery.proposals) {
          findings.push(toFinding(proposal, discovery.capability));
        }
      }
      return { findings, warnings, complete };
    },
  };
}

function toFinding(proposal: ManagerProposal, capability: Finding["capability"]): Finding {
  const spec = MANAGER_ACTIONS[proposal.action];
  const commands = spec.commands(
    spec.itemPattern === undefined ? [] : proposal.items.map((item) => item.id),
    proposal.parameters,
  );
  const scope =
    commands.length <= 3
      ? commands.map((command) => describeCommand(command, spec.privilege)).join("; ")
      : `${describeCommand(commands[0] as ManagerCommand, spec.privilege)}; and ${commands.length - 1} more, one per item`;
  const count =
    proposal.count.kind === "unknown"
      ? "How many entries go is the manager's decision and is not known beforehand."
      : `${proposal.count.kind === "exact" ? "Exactly" : "About"} ${proposal.count.value} item(s).`;
  const size =
    proposal.estimatedBytes === undefined
      ? findingSize(undefined, "unknown", "The manager does not say beforehand how much it would remove.")
      : findingSize(
          proposal.estimatedBytes,
          proposal.bytesBasis === "stat" ? "stat" : "manager-reported",
          proposal.bytesBasis === "stat"
            ? "Blocks on disk of the files listed, from one stat each."
            : "The manager's own figure, which is an estimate of what it would free.",
        );

  return {
    ...buildFinding({
      providerId: ID,
      providerVersion: VERSION,
      category: categoryOf(proposal),
      slug: proposal.slug ?? proposal.action,
      title: safeText(proposal.title),
      evidence: [
        ...proposal.evidence.map((line) => safeText(line, 400)),
        count,
        spec.privilege === "root"
          ? "Needs administrator rights; Disktop asks sudo or pkexec for these commands only, after you confirm."
          : "Runs as you, with no extra rights.",
      ],
      managerScope: scope,
      size,
      confidence: "likely",
      capability,
      actions: proposal.offered ? ["manager"] : [],
      ...(spec.regenerationCost === undefined ? {} : { regenerationCost: spec.regenerationCost }),
      active: false,
    }),
    managerAction: proposal.action,
  };
}
