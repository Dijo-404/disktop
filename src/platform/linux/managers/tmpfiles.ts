import { MANAGER_ACTIONS, type ManagerActionId } from "../../../domain/managers.js";
import type { ManagerAdapter, ManagerDiscovery, ManagerProposal } from "../../../ports/managers.js";
import type { ToolPort } from "../../../ports/providers.js";
import { previewFrom } from "./support.js";

export interface TmpfilesPorts {
  readonly tools: ToolPort;
  readonly installed: (tool: string) => Promise<boolean>;
}

interface Policy {
  readonly action: ManagerActionId;
  readonly title: string;
  readonly spacePath: string;
  readonly evidence: string;
}

const POLICIES: readonly Policy[] = [
  {
    action: "tmpfiles.clean-user",
    title: "Your temporary files your tmpfiles.d rules have retired",
    spacePath: "/tmp",
    evidence: "Only what your own tmpfiles.d age rules allow is removed; Disktop picks no files.",
  },
  {
    action: "tmpfiles.clean-system",
    title: "Temporary files the system's tmpfiles.d rules have retired",
    spacePath: "/tmp",
    evidence: "Only what this system's own tmpfiles.d age rules allow is removed; Disktop picks no files.",
  },
  {
    action: "tmpfiles.clean-crash",
    title: "Crash reports and core dumps the system's tmpfiles.d rules have retired",
    spacePath: "/var/lib/systemd/coredump",
    evidence:
      "Only what this system's own tmpfiles.d age rules allow under /var/crash and /var/lib/systemd/coredump is removed; Disktop picks no files.",
  },
];

interface DryRun {
  readonly removals: number;
  readonly unreadable: boolean;
}

export function createTmpfilesAdapter(ports: TmpfilesPorts): ManagerAdapter {
  async function dryRun(action: ManagerActionId): Promise<DryRun | undefined> {
    const [command] = MANAGER_ACTIONS[action].commands([], {});
    const commandArguments = [...(command?.arguments ?? [])];
    commandArguments.splice(commandArguments.indexOf("--clean") + 1, 0, "--dry-run");
    const answer = await ports.tools.run("systemd-tmpfiles", commandArguments);
    if (answer.capability.status !== "available") {
      return undefined;
    }
    const lines = answer.stderr.split("\n");
    return {
      removals: lines.filter((line) => line.startsWith("Would remove ")).length,
      unreadable: lines.some((line) => /Permission denied/.test(line)),
    };
  }

  async function discover(): Promise<ManagerDiscovery> {
    if (!(await ports.installed("systemd-tmpfiles"))) {
      return {
        adapter: "tmpfiles",
        capability: { status: "missing-tool", explanation: "systemd-tmpfiles is not installed on this machine." },
        proposals: [],
        warnings: [],
      };
    }
    const proposals: ManagerProposal[] = [];
    for (const policy of POLICIES) {
      const preview = await dryRun(policy.action);
      proposals.push({
        action: policy.action,
        title: policy.title,
        evidence: [
          policy.evidence,
          preview === undefined
            ? "This systemd cannot preview a clean, so how much it removes is not known beforehand."
            : `A dry run says ${preview.removals} entr${preview.removals === 1 ? "y" : "ies"} would be removed.`,
          ...(preview?.unreadable === true
            ? ["Some directories could not be read by this user, so more may be removed than the dry run counted."]
            : []),
        ],
        items: [],
        count: preview === undefined ? { kind: "unknown" } : { kind: "estimated", value: BigInt(preview.removals) },
        bytesBasis: "unknown",
        preview: preview === undefined ? "none" : "simulated",
        offered: preview === undefined || preview.removals > 0 || preview.unreadable,
        parameters: {},
      });
    }
    return {
      adapter: "tmpfiles",
      capability: { status: "available", explanation: "systemd-tmpfiles is installed." },
      proposals,
      warnings: [],
    };
  }

  return {
    id: "tmpfiles",
    discover,
    preview: (action) => previewFrom(discover, action),
    async preflight() {
      return { skipped: new Map() };
    },
    async verify(scope) {
      const after = await dryRun(scope.action);
      return {
        verdicts: new Map(),
        observed: [],
        checks: [
          after === undefined
            ? { check: "manager-verified", outcome: "unavailable", detail: "This systemd cannot preview a clean, so the result could not be checked." }
            : after.removals === 0
              ? { check: "manager-verified", outcome: "passed", detail: "A dry run afterwards finds nothing more the policy would remove." }
              : { check: "manager-verified", outcome: "failed", detail: `A dry run afterwards still finds ${after.removals} entr${after.removals === 1 ? "y" : "ies"} the policy would remove.` },
        ],
      };
    },
    async spacePath(scope) {
      return POLICIES.find((policy) => policy.action === scope.action)?.spacePath;
    },
  };
}
