import type { PackageInventoryPort } from "../ports/packages.js";
import type { FindingProvider } from "../ports/providers.js";
import { createInstalledAppsProvider } from "./apps/index.js";
import {
  createCondaProvider,
  createNodeVersionsProvider,
  createProjectArtifactsProvider,
  createPyenvProvider,
  createPythonEnvsProvider,
  createRustupProvider,
} from "./dev/index.js";
import {
  createAiCacheProvider,
  createBrowserCacheProvider,
  createElectronCacheProvider,
  createIdeCacheProvider,
  createLanguageCacheProvider,
} from "./caches/index.js";
import {
  createSteamProvider,
  createSwapProvider,
  createSystemSnapshotsProvider,
  createVirtualMachineProvider,
  createWineProvider,
} from "./storage/index.js";
import {
  createCrashProvider,
  createLogProvider,
  createOpenDeletedProvider,
  createSmartProvider,
  createWindowsSubsystemProvider,
} from "./diagnostics/index.js";

/**
 * Every detector Disktop ships, in one list.
 *
 * A provider receives its environment on each call, so the list itself needs
 * nothing: registration happens here and nowhere else, which keeps the set a
 * release discovers readable in one place.
 */
export interface BuiltInProviderPorts {
  readonly packages: PackageInventoryPort;
}

export function createBuiltInProviders(ports: BuiltInProviderPorts): readonly FindingProvider[] {
  return [
    createCondaProvider(),
    createPythonEnvsProvider(),
    createPyenvProvider(),
    createNodeVersionsProvider(),
    createRustupProvider(),
    createProjectArtifactsProvider(),
    createLanguageCacheProvider(),
    createAiCacheProvider(),
    createIdeCacheProvider(),
    createBrowserCacheProvider(),
    createElectronCacheProvider(),
    createSteamProvider(),
    createWineProvider(),
    createVirtualMachineProvider(),
    createSystemSnapshotsProvider(),
    createSwapProvider(),
    createInstalledAppsProvider(ports.packages),
    createLogProvider(),
    createCrashProvider(),
    createOpenDeletedProvider(),
    createSmartProvider(),
    createWindowsSubsystemProvider(),
  ];
}
