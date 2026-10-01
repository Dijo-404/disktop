import type { ActionPlan } from "../domain/actions.js";
import type { Finding } from "../domain/findings.js";
import type { Capability } from "../domain/models.js";

export interface ProviderContext {
  readonly scanId?: string;
  readonly rootIds: readonly string[];
}

export interface FindingProvider {
  readonly id: string;
  probe(): Promise<Capability>;
  discover(context: ProviderContext, signal: AbortSignal): AsyncIterable<Finding>;
}

export interface ManagedActionProvider {
  readonly id: string;
  preview(findingId: string, operation: string): Promise<ActionPlan>;
}
