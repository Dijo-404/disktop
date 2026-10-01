import type { FindingProvider } from "../ports/providers.js";
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

/**
 * Every detector Disktop ships, in one list.
 *
 * A provider receives its environment on each call, so the list itself needs
 * nothing: registration happens here and nowhere else, which keeps the set a
 * release discovers readable in one place.
 */
export function createBuiltInProviders(): readonly FindingProvider[] {
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
  ];
}
