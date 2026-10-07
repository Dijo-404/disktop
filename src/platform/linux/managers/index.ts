import { MANAGER_ACTIONS } from "../../../domain/managers.js";
import { sanitizeText } from "../../../domain/paths.js";
import type { ManagerAdapter, ManagerDiscovery, ManagerInventoryPort } from "../../../ports/managers.js";

export function createManagerInventory(adapters: readonly Pick<ManagerAdapter, "id" | "discover" | "preview">[]): ManagerInventoryPort {
  let reading: Promise<readonly ManagerDiscovery[]> | undefined;
  const tasks = new WeakMap<AbortSignal, Promise<readonly ManagerDiscovery[]>>();
  return {
    async discover(signal) {
      signal?.throwIfAborted();
      const previous = signal === undefined ? reading : tasks.get(signal);
      if (previous !== undefined) return previous;
      const current = Promise.all(
        adapters.map(async (adapter): Promise<ManagerDiscovery> => {
          try {
            return await adapter.discover(signal);
          } catch (error) {
            const code = typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
            const explanation = `${adapter.id} could not be read: ${sanitizeText(error instanceof Error ? error.message : String(error))}`;
            return {
              adapter: adapter.id,
              capability: {
                status: code === "EACCES" || code === "EPERM" ? "permission-denied" : "missing-tool",
                explanation,
              },
              proposals: [],
              warnings: code === "EACCES" || code === "EPERM" ? [] : [{ code: "manager-failed", message: explanation }],
            };
          }
        }),
      );
      if (signal === undefined) reading = current;
      else tasks.set(signal, current);
      return current;
    },
    async preview(action, parameters, signal) {
      signal?.throwIfAborted();
      const adapter = adapters.find((candidate) => candidate.id === MANAGER_ACTIONS[action].adapter);
      if (adapter === undefined) {
        return { kind: "refused", message: `Disktop has no adapter for ${action} on this machine.` };
      }
      return adapter.preview(action, parameters, signal);
    },
  };
}
