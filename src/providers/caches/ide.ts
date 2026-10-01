import type { FindingProvider } from "../../ports/providers.js";
import { createRootsProvider, type CacheRoot } from "./roots.js";

const ID = "cache.ide";
const VERSION = 1;

const ROOTS: readonly CacheRoot[] = [
  {
    slug: "jetbrains-cache",
    segments: [".cache", "JetBrains"],
    title: "JetBrains IDE caches",
    evidence: ["Project indexes and compiler caches an IDE rebuilds on the next open."],
    regenerationCost: "Re-indexed when the project is next opened, which takes minutes on a large project.",
  },
  {
    slug: "jetbrains-data",
    segments: [".local", "share", "JetBrains"],
    title: "JetBrains plugins and local history",
    evidence: [
      "Installed plugins and local file history, not cache: local history is the only copy of changes never committed.",
    ],
    active: true,
    regenerationCost: "Plugins reinstall; local history does not come back.",
  },
  {
    slug: "vscode-cache",
    segments: [".config", "Code", "Cache"],
    title: "VS Code network cache",
    evidence: ["Responses VS Code caches between launches."],
    regenerationCost: "Refetched on the next launch.",
  },
  {
    slug: "vscode-cached-data",
    segments: [".config", "Code", "CachedData"],
    title: "VS Code compiled script cache",
    evidence: ["Compiled script data for the installed version; rebuilt on the next launch."],
    regenerationCost: "Rebuilt on the next launch, which is slower once.",
  },
  {
    slug: "vscode-extensions",
    segments: [".vscode", "extensions"],
    title: "VS Code extensions",
    evidence: ["Installed extensions, with whatever state each one keeps. Not cache."],
    active: true,
    regenerationCost: "Reinstalled one by one, losing any extension state that was not synced.",
  },
  {
    slug: "android-sdk",
    segments: ["Android", "Sdk"],
    title: "Android SDK",
    evidence: ["Platforms, build tools, and system images a project builds against. Not cache."],
    active: true,
    regenerationCost: "Re-downloaded through the SDK manager, which is gigabytes.",
  },
  {
    slug: "android-avd",
    segments: [".android", "avd"],
    title: "Android virtual devices",
    evidence: ["Emulator images with their installed applications and data. Not cache."],
    active: true,
    regenerationCost: "Recreated empty: anything installed inside an emulator is gone.",
  },
  {
    slug: "android-caches",
    segments: [".android", "cache"],
    title: "Android tooling cache",
    evidence: ["Downloaded tooling metadata the SDK manager refetches."],
    regenerationCost: "Refetched on the next SDK operation.",
  },
];

/** IDE, SDK, and emulator directories, and which of them are not cache. */
export function createIdeCacheProvider(): FindingProvider {
  return createRootsProvider({
    id: ID,
    version: VERSION,
    category: "ide-cache",
    what: "IDE and SDK directories",
    roots: ROOTS,
  });
}
