import type { Finding } from "../../domain/findings.js";
import type { RawPath } from "../../domain/models.js";
import type { DiscoveryEnvironment, FindingProvider } from "../../ports/providers.js";
import {
  basename,
  buildFinding,
  childDirectories,
  exists,
  existingPaths,
  joinPath,
  slugForPath,
  underHome,
} from "../support.js";

const ID = "cache.browser";
const VERSION = 1;

/** The cache subdirectories a Chromium profile keeps. */
const CHROMIUM_CACHES: readonly string[] = ["Cache", "Code Cache", "GPUCache", "Service Worker", "DawnCache"];

/** A file that only a real profile has, so a stray directory is not reported as one. */
const CHROMIUM_PROFILE_MARKERS: readonly string[] = ["History", "Preferences", "Bookmarks"];
const FIREFOX_PROFILE_MARKERS: readonly string[] = ["places.sqlite", "prefs.js", "logins.json"];

interface Chromium {
  readonly name: string;
  readonly config: readonly string[];
  readonly cache: readonly string[];
}

const CHROMIUM_BROWSERS: readonly Chromium[] = [
  { name: "Google Chrome", config: [".config", "google-chrome"], cache: [".cache", "google-chrome"] },
  { name: "Chromium", config: [".config", "chromium"], cache: [".cache", "chromium"] },
  { name: "Brave", config: [".config", "BraveSoftware", "Brave-Browser"], cache: [".cache", "BraveSoftware", "Brave-Browser"] },
  { name: "Microsoft Edge", config: [".config", "microsoft-edge"], cache: [".cache", "microsoft-edge"] },
  { name: "Vivaldi", config: [".config", "vivaldi"], cache: [".cache", "vivaldi"] },
];

/**
 * Browser caches, and the profiles they are not.
 *
 * This distinction is the whole provider. A Chromium profile directory holds
 * the cache alongside history, bookmarks, cookies and saved passwords; a
 * detector that reported the profile as a cache would be proposing to sign
 * somebody out of everything. So a profile is reported as in use with no
 * action, and each cache directory inside it is reported separately.
 */
export function createBrowserCacheProvider(): FindingProvider {
  return {
    id: ID,
    version: VERSION,
    categories: ["browser-cache"],

    async probe(environment) {
      const roots = await browserRoots(environment);
      return roots.length > 0
        ? { status: "available", explanation: `${roots.length} browser directories exist.` }
        : { status: "missing-tool", explanation: "No browser profile or cache directory exists under this home directory." };
    },

    async discover(environment) {
      const findings: Finding[] = [];

      for (const browser of CHROMIUM_BROWSERS) {
        const config = underHome(environment, ...browser.config);
        for (const profile of await chromiumProfiles(environment, config)) {
          findings.push(profileFinding(profile, browser.name, "history, bookmarks, cookies and saved passwords"));
          for (const cache of CHROMIUM_CACHES) {
            const path = joinPath(profile, cache);
            if (await exists(environment, path)) {
              findings.push(cacheFinding(path, `${browser.name} ${cache} for ${basename(profile)}`));
            }
          }
        }

        // The separate cache tree outside the profile directory.
        const cacheRoot = underHome(environment, ...browser.cache);
        for (const profileCache of await childDirectories(environment, cacheRoot)) {
          for (const cache of CHROMIUM_CACHES) {
            const path = joinPath(profileCache, cache);
            if (await exists(environment, path)) {
              findings.push(cacheFinding(path, `${browser.name} ${cache} for ${basename(profileCache)}`));
            }
          }
        }
      }

      findings.push(...(await firefoxFindings(environment)));
      return { findings, warnings: [], complete: true };
    },
  };
}

async function firefoxFindings(environment: DiscoveryEnvironment): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  for (const [profileRoot, cacheRoot] of [
    [underHome(environment, ".mozilla", "firefox"), underHome(environment, ".cache", "mozilla", "firefox")],
    [underHome(environment, ".librewolf"), underHome(environment, ".cache", "librewolf")],
  ] as const) {
    for (const profile of await childDirectories(environment, profileRoot)) {
      if (!(await hasAnyMarker(environment, profile, FIREFOX_PROFILE_MARKERS))) {
        continue;
      }
      findings.push(profileFinding(profile, "Firefox", "history, bookmarks, cookies and saved logins"));
    }
    for (const profileCache of await childDirectories(environment, cacheRoot)) {
      findings.push(cacheFinding(profileCache, `Firefox cache for ${basename(profileCache)}`));
    }
  }
  return findings;
}

function profileFinding(path: RawPath, browser: string, holds: string): Finding {
  return buildFinding({
    providerId: ID,
    providerVersion: VERSION,
    category: "browser-cache",
    slug: slugForPath(path),
    title: `${browser} profile ${basename(path)}`,
    evidence: [
      `A profile, not a cache: it holds ${holds}.`,
      "Its cache directories are reported separately, and only those can be cleared.",
    ],
    paths: [path],
    active: true,
    actions: [],
  });
}

function cacheFinding(path: RawPath, title: string): Finding {
  return buildFinding({
    providerId: ID,
    providerVersion: VERSION,
    category: "browser-cache",
    slug: slugForPath(path),
    title,
    evidence: ["Cached responses and compiled scripts the browser refetches or rebuilds when it needs them."],
    paths: [path],
    actions: ["trash"],
    regenerationCost: "Refetched as pages are visited again; the first visit to each site is slower.",
  });
}

async function chromiumProfiles(
  environment: DiscoveryEnvironment,
  config: RawPath,
): Promise<readonly RawPath[]> {
  const profiles: RawPath[] = [];
  for (const candidate of await childDirectories(environment, config)) {
    if (await hasAnyMarker(environment, candidate, CHROMIUM_PROFILE_MARKERS)) {
      profiles.push(candidate);
    }
  }
  return profiles;
}

async function hasAnyMarker(
  environment: DiscoveryEnvironment,
  directory: RawPath,
  markers: readonly string[],
): Promise<boolean> {
  for (const marker of markers) {
    if (await exists(environment, joinPath(directory, marker))) {
      return true;
    }
  }
  return false;
}

async function browserRoots(environment: DiscoveryEnvironment): Promise<readonly RawPath[]> {
  const candidates = [
    ...CHROMIUM_BROWSERS.flatMap((browser) => [
      underHome(environment, ...browser.config),
      underHome(environment, ...browser.cache),
    ]),
    underHome(environment, ".mozilla", "firefox"),
    underHome(environment, ".cache", "mozilla", "firefox"),
    underHome(environment, ".librewolf"),
  ];
  return existingPaths(environment, candidates);
}
