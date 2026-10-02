import type { ManagerActionId } from "../../../domain/managers.js";
import { sanitizeText } from "../../../domain/paths.js";
import type { ManagerAdapter, ManagerDiscovery, ManagerProposal } from "../../../ports/managers.js";
import type { ToolPort } from "../../../ports/providers.js";
import { previewFrom } from "./support.js";

export interface FlatpakPorts {
  readonly tools: ToolPort;
  readonly home: string;
}

const INSTALLATIONS: readonly { readonly flag: "--user" | "--system"; readonly action: ManagerActionId; readonly title: string }[] = [
  { flag: "--user", action: "flatpak.remove-unused-user", title: "Unused Flatpak runtimes in your installation" },
  { flag: "--system", action: "flatpak.remove-unused-system", title: "Unused Flatpak runtimes in the system installation" },
];

export function createFlatpakAdapter(ports: FlatpakPorts): ManagerAdapter {
  const before = new Map<string, ReadonlySet<string> | undefined>();

  async function refs(flag: "--user" | "--system"): Promise<ReadonlySet<string> | undefined> {
    const answer = await ports.tools.run("flatpak", ["list", flag, "--columns=ref"]);
    if (answer.capability.status !== "available") {
      return undefined;
    }
    return new Set(
      answer.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && line.length <= 256 && !/[\u0000-\u001f\u007f]/.test(line)),
    );
  }

  async function discover(): Promise<ManagerDiscovery> {
    const proposals: ManagerProposal[] = [];
    for (const installation of INSTALLATIONS) {
      const installed = await refs(installation.flag);
      if (installed === undefined) {
        continue;
      }
      proposals.push({
        action: installation.action,
        title: installation.title,
        evidence: [
          `${installed.size} ref(s) are installed in this installation.`,
          "Flatpak decides which runtimes and extensions no installed application uses; Disktop lists what it removed afterwards.",
        ],
        items: [],
        count: { kind: "unknown" },
        bytesBasis: "unknown",
        preview: "none",
        offered: [...installed].some((ref) => ref.startsWith("runtime/")),
        parameters: {},
      });
    }
    if (proposals.length === 0) {
      return {
        adapter: "flatpak",
        capability: { status: "missing-tool", explanation: "flatpak is not installed or did not answer." },
        proposals: [],
        warnings: [],
      };
    }
    return { adapter: "flatpak", capability: { status: "available", explanation: "flatpak answered." }, proposals, warnings: [] };
  }

  const flagFor = (action: string): "--user" | "--system" =>
    action === "flatpak.remove-unused-user" ? "--user" : "--system";

  return {
    id: "flatpak",
    discover,
    preview: (action) => previewFrom(discover, action),
    async preflight(scope) {
      before.set(scope.action, await refs(flagFor(scope.action)));
      return { skipped: new Map() };
    },
    async verify(scope) {
      const earlier = before.get(scope.action);
      const after = await refs(flagFor(scope.action));
      if (earlier === undefined || after === undefined) {
        return {
          verdicts: new Map(),
          observed: [],
          checks: [{ check: "manager-verified", outcome: "unavailable", detail: "Flatpak's installed refs could not be listed on both sides." }],
        };
      }
      const removed = [...earlier].filter((ref) => !after.has(ref));
      return {
        verdicts: new Map(),
        observed: removed.map((ref) => ({ id: ref })),
        checks: [
          {
            check: "manager-verified",
            outcome: "passed",
            detail: removed.length === 0 ? "Flatpak found nothing unused." : `Flatpak removed ${removed.length} ref(s): ${sanitizeText(removed.slice(0, 3).join(", "))}${removed.length > 3 ? ", …" : ""}.`,
          },
        ],
      };
    },
    async spacePath(scope) {
      return scope.action === "flatpak.remove-unused-user" ? `${ports.home}/.local/share/flatpak` : "/var/lib/flatpak";
    },
  };
}
