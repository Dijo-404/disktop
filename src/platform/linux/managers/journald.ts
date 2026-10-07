import type { ManagerScope } from "../../../domain/managers.js";
import { parseJournalUsage } from "../../../domain/tool-output.js";
import type { ManagerAdapter, ManagerDiscovery, ManagerProposal } from "../../../ports/managers.js";
import type { ToolPort } from "../../../ports/providers.js";

export interface JournaldPorts {
  readonly tools: ToolPort;
  readonly keepBytes: bigint;
}

export function createJournaldAdapter(ports: JournaldPorts): ManagerAdapter {
  const before = new Map<string, bigint | undefined>();

  async function usage(signal?: AbortSignal): Promise<{ readonly bytes?: bigint; readonly discovery?: ManagerDiscovery }> {
    signal?.throwIfAborted();
    const answer = await ports.tools.run("journalctl", ["--disk-usage"], signal);
    signal?.throwIfAborted();
    if (answer.capability.status !== "available") {
      return { discovery: { adapter: "journald", capability: answer.capability, proposals: [], warnings: [] } };
    }
    const bytes = parseJournalUsage(answer.stdout);
    return bytes === undefined ? {} : { bytes };
  }

  async function discover(signal?: AbortSignal): Promise<ManagerDiscovery> {
    const reading = await usage(signal);
    if (reading.discovery !== undefined) {
      return reading.discovery;
    }
    const estimate = reading.bytes === undefined ? undefined : reading.bytes > ports.keepBytes ? reading.bytes - ports.keepBytes : 0n;
    const proposal: ManagerProposal = {
      action: "journald.vacuum",
      title: "Archived systemd journal files",
      evidence: [
        reading.bytes === undefined
          ? "journalctl answered in a form Disktop could not read a size from."
          : `journalctl reports ${reading.bytes} bytes of journal; the vacuum keeps ${ports.keepBytes}.`,
        "Only sealed, archived journal files are removed; the one being written stays.",
      ],
      items: [],
      count: { kind: "unknown" },
      ...(estimate === undefined ? {} : { estimatedBytes: estimate }),
      bytesBasis: estimate === undefined ? "unknown" : "manager-reported",
      preview: "none",
      offered: estimate !== undefined && estimate > 0n,
      parameters: { keepBytes: ports.keepBytes.toString(10) },
    };
    return {
      adapter: "journald",
      capability: { status: "available", explanation: "journalctl answered." },
      proposals: [proposal],
      warnings: [],
    };
  }

  return {
    id: "journald",
    discover,
    async preview(action, _parameters, signal) {
      const discovery = await discover(signal);
      const proposal = discovery.proposals.find((candidate) => candidate.action === action);
      return proposal === undefined
        ? { kind: "refused", message: discovery.capability.explanation, capability: discovery.capability }
        : { kind: "proposal", proposal };
    },
    async preflight(scope: ManagerScope, signal) {
      before.set(scope.action, (await usage(signal)).bytes);
      return { skipped: new Map() };
    },
    async verify(scope) {
      const after = (await usage()).bytes;
      const earlier = before.get(scope.action);
      if (after === undefined || earlier === undefined) {
        return {
          verdicts: new Map(),
          observed: [],
          checks: [{ check: "manager-verified", outcome: "unavailable", detail: "The journal's size could not be read on both sides of the vacuum." }],
        };
      }
      return {
        verdicts: new Map(),
        observed: [],
        checks: [
          after <= earlier
            ? {
                check: "manager-verified",
                outcome: "passed",
                detail: `The journal is ${after < earlier ? "smaller" : "no larger"}: ${earlier} bytes before, ${after} after.`,
              }
            : { check: "manager-verified", outcome: "failed", detail: `The journal grew from ${earlier} to ${after} bytes during the vacuum.` },
        ],
      };
    },
    async spacePath() {
      return "/var/log/journal";
    },
  };
}
