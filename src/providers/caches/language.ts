import type { FindingProvider } from "../../ports/providers.js";
import { createRootsProvider, type CacheRoot } from "./roots.js";

const ID = "cache.language";
const VERSION = 1;

const ROOTS: readonly CacheRoot[] = [
  {
    slug: "npm",
    segments: [".npm", "_cacache"],
    title: "npm cache",
    evidence: ["Package tarballs and metadata npm keeps so a reinstall skips the registry."],
    regenerationCost: "Re-downloaded on the next install that needs a package.",
  },
  {
    slug: "yarn-classic",
    segments: [".cache", "yarn"],
    title: "Yarn 1 cache",
    evidence: ["Unpacked packages Yarn 1 reuses across projects."],
    regenerationCost: "Re-downloaded on the next install.",
  },
  {
    slug: "yarn-berry",
    segments: [".yarn", "berry", "cache"],
    title: "Yarn Berry cache",
    evidence: ["Zipped packages Yarn Berry shares between projects."],
    regenerationCost: "Re-downloaded on the next install.",
  },
  {
    slug: "pnpm-store",
    segments: [".local", "share", "pnpm", "store"],
    title: "pnpm content store",
    evidence: [
      "pnpm hardlinks project dependencies out of this store, so removing it forces every project to reinstall.",
    ],
    regenerationCost: "Re-downloaded, and every existing node_modules has to be rebuilt from it.",
  },
  {
    slug: "pnpm-store-legacy",
    segments: [".pnpm-store"],
    title: "pnpm content store (older location)",
    evidence: ["The store location older pnpm versions used."],
    regenerationCost: "Re-downloaded, and every existing node_modules has to be rebuilt from it.",
  },
  {
    slug: "pip",
    segments: [".cache", "pip"],
    title: "pip cache",
    evidence: ["Wheels and HTTP responses pip keeps so a reinstall skips the index."],
    regenerationCost: "Re-downloaded, and any wheel that had to be built is built again.",
  },
  {
    slug: "uv",
    segments: [".cache", "uv"],
    title: "uv cache",
    evidence: ["Packages and build artifacts uv keeps between resolutions."],
    regenerationCost: "Re-downloaded on the next resolution.",
  },
  {
    slug: "cargo-registry",
    segments: [".cargo", "registry"],
    title: "Cargo registry cache",
    evidence: ["Downloaded crate sources and the registry index."],
    regenerationCost: "Re-downloaded on the next build that needs a crate.",
  },
  {
    slug: "cargo-git",
    segments: [".cargo", "git"],
    title: "Cargo git dependency checkouts",
    evidence: ["Cloned repositories for dependencies that come from git rather than the registry."],
    regenerationCost: "Re-cloned on the next build that needs them.",
  },
  {
    slug: "go-mod",
    segments: ["go", "pkg", "mod"],
    title: "Go module cache",
    evidence: [
      "Go writes this cache read-only, so ordinary removal fails; `go clean -modcache` is how it is meant to go.",
    ],
    actions: ["manager"],
    regenerationCost: "Re-downloaded on the next build.",
  },
  {
    slug: "go-build",
    segments: [".cache", "go-build"],
    title: "Go build cache",
    evidence: ["Compiled package objects Go reuses between builds."],
    regenerationCost: "Rebuilt on the next build, which will be slower once.",
  },
  {
    slug: "maven",
    segments: [".m2", "repository"],
    title: "Maven local repository",
    evidence: [
      "Downloaded dependencies, and anything installed locally by `mvn install`, which has no other copy.",
    ],
    regenerationCost: "Re-downloaded, except for artifacts that were only ever installed locally.",
  },
  {
    slug: "gradle",
    segments: [".gradle", "caches"],
    title: "Gradle cache",
    evidence: ["Downloaded dependencies and compiled build scripts."],
    regenerationCost: "Re-downloaded, and the next build runs without its incremental state.",
  },
  {
    slug: "composer",
    segments: [".cache", "composer"],
    title: "Composer cache",
    evidence: ["Package archives and metadata Composer reuses between projects."],
    regenerationCost: "Re-downloaded on the next install.",
  },
  {
    slug: "nuget",
    segments: [".nuget", "packages"],
    title: "NuGet package cache",
    evidence: ["Extracted packages shared between .NET projects."],
    regenerationCost: "Re-downloaded on the next restore.",
  },
];

/** The caches language package managers keep, and what losing each one costs. */
export function createLanguageCacheProvider(): FindingProvider {
  return createRootsProvider({
    id: ID,
    version: VERSION,
    category: "language-cache",
    what: "language package caches",
    roots: ROOTS,
  });
}
