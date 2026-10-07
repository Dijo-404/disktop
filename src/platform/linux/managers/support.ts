import type { VerificationCheck } from "../../../domain/actions.js";
import type { ManagerScope } from "../../../domain/managers.js";
import type { ItemVerdict, ManagerAdapter, ManagerDiscovery, ManagerPreviewOutcome } from "../../../ports/managers.js";

export async function previewFrom(
  discover: ManagerAdapter["discover"],
  action: string,
  signal?: AbortSignal,
): Promise<ManagerPreviewOutcome> {
  signal?.throwIfAborted();
  const discovery: ManagerDiscovery = await discover(signal);
  signal?.throwIfAborted();
  const proposal = discovery.proposals.find((candidate) => candidate.action === action);
  return proposal === undefined
    ? { kind: "refused", message: discovery.capability.explanation, capability: discovery.capability }
    : { kind: "proposal", proposal };
}

/** Items still listed after the manager ran failed; the rest are gone. */
export function listedAgain(
  scope: ManagerScope,
  attempted: ReadonlySet<number>,
  stillThere: ReadonlySet<string> | undefined,
  what: string,
): { readonly verdicts: ReadonlyMap<number, ItemVerdict>; readonly observed: []; readonly checks: readonly VerificationCheck[] } {
  const verdicts = new Map<number, ItemVerdict>();
  if (stillThere === undefined) {
    return {
      verdicts,
      observed: [],
      checks: [{ check: "manager-verified", outcome: "unavailable", detail: `${what} could not be listed again afterwards.` }],
    };
  }
  let left = 0;
  for (const position of attempted) {
    const item = scope.items[position];
    if (item === undefined) {
      continue;
    }
    if (stillThere.has(item.id)) {
      left += 1;
      verdicts.set(position, { outcome: "failed", message: `It is still listed by ${what}.` });
    } else {
      verdicts.set(position, { outcome: "completed" });
    }
  }
  return {
    verdicts,
    observed: [],
    checks: [
      left === 0
        ? { check: "manager-verified", outcome: "passed", detail: `${what} was listed again and no reviewed item remains.` }
        : { check: "manager-verified", outcome: "failed", detail: `${left} reviewed item(s) are still listed by ${what}.` },
    ],
  };
}
