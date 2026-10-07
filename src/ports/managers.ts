import type { VerificationCheck } from "../domain/actions.js";
import type {
  ManagerActionId,
  ManagerAdapterId,
  ManagerCommand,
  ManagerCount,
  ManagerItem,
  ManagerPreview,
  ManagerPrivilege,
  ManagerScope,
} from "../domain/managers.js";
import type { Capability, Warning } from "../domain/models.js";

export interface CommandRun {
  /**
   * `cancelled` ran and was stopped, so what it did has to be asked about;
   * `not-started` was stopped before anything was spawned, so it did nothing.
   */
  readonly status: "ran" | "denied" | "missing-tool" | "cancelled" | "not-started";
  readonly exitCode: number | null;
  /** The last 4 KiB of what the command printed, sanitized. */
  readonly output: string;
  readonly explanation: string;
}

export interface RunOptions {
  readonly interactive: boolean;
  readonly signal: AbortSignal;
}

/** Runs one derived manager command, escalating only that command when it needs root. */
export interface CommandRunner {
  run(command: ManagerCommand, privilege: ManagerPrivilege, options: RunOptions): Promise<CommandRun>;
}

export interface ManagerProposal {
  readonly action: ManagerActionId;
  /** Distinguishes a reported-only proposal from the offered one sharing its action. */
  readonly slug?: string;
  readonly title: string;
  readonly evidence: readonly string[];
  readonly items: readonly ManagerItem[];
  readonly count: ManagerCount;
  readonly estimatedBytes?: bigint;
  readonly bytesBasis: "manager-reported" | "stat" | "unknown";
  readonly preview: ManagerPreview;
  /** False for something reported and never offered, such as a named volume. */
  readonly offered: boolean;
  readonly parameters: Readonly<Record<string, string>>;
}

export interface ManagerDiscovery {
  readonly adapter: ManagerAdapterId;
  readonly capability: Capability;
  readonly proposals: readonly ManagerProposal[];
  readonly warnings: readonly Warning[];
}

export type ManagerPreviewOutcome =
  | { readonly kind: "proposal"; readonly proposal: ManagerProposal }
  | { readonly kind: "refused"; readonly message: string; readonly capability?: Capability };

export interface PreflightResult {
  /** Present when the whole action may not run now. */
  readonly refusal?: string;
  /** Item positions that may not be acted on now, with why. */
  readonly skipped: ReadonlyMap<number, string>;
}

export interface ItemVerdict {
  readonly outcome: "completed" | "failed";
  readonly message?: string;
}

export interface ManagerVerification {
  readonly verdicts: ReadonlyMap<number, ItemVerdict>;
  /** What the manager removed of its own choosing, for an action that names no items. */
  readonly observed: readonly ManagerItem[];
  readonly checks: readonly VerificationCheck[];
}

export interface ManagerAdapter {
  readonly id: ManagerAdapterId;
  discover(signal?: AbortSignal): Promise<ManagerDiscovery>;
  preview(action: ManagerActionId, parameters: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<ManagerPreviewOutcome>;
  preflight(scope: ManagerScope, signal?: AbortSignal): Promise<PreflightResult>;
  verify(scope: ManagerScope, attempted: ReadonlySet<number>, runs: readonly CommandRun[]): Promise<ManagerVerification>;
  spacePath(scope: ManagerScope): Promise<string | undefined>;
}

export interface ManagerInventoryPort {
  discover(signal?: AbortSignal): Promise<readonly ManagerDiscovery[]>;
  preview(action: ManagerActionId, parameters: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<ManagerPreviewOutcome>;
}
