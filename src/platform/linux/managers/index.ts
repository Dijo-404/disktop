import { MANAGER_ACTIONS } from "../../../domain/managers.js";
import { sanitizeText } from "../../../domain/paths.js";
import type { ManagerAdapter, ManagerDiscovery, ManagerInventoryPort } from "../../../ports/managers.js";

export function createManagerInventory(adapters: readonly Pick<ManagerAdapter, "id" | "discover" | "preview">[]): ManagerInventoryPort {
  let reading: Promise<readonly ManagerDiscovery[]> | undefined;
  return {
    async discover() {
      reading ??= Promise.all(
        adapters.map(async (adapter): Promise<ManagerDiscovery> => {
          try {
            return await adapter.discover();
          } catch (error) {
            return {
              adapter: adapter.id,
              capability: {
                status: "missing-tool",
                explanation: `${adapter.id} could not be read: ${sanitizeText(error instanceof Error ? error.message : String(error))}`,
              },
              proposals: [],
              warnings: [],
            };
          }
        }),
      );
      return reading;
    },
    async preview(action, parameters) {
      const adapter = adapters.find((candidate) => candidate.id === MANAGER_ACTIONS[action].adapter);
      if (adapter === undefined) {
        return { kind: "refused", message: `Disktop has no adapter for ${action} on this machine.` };
      }
      return adapter.preview(action, parameters);
    },
  };
}
