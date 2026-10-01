import { findingSize, type Finding } from "../../domain/findings.js";
import type { RawPath, Warning } from "../../domain/models.js";
import { isAbsoluteNormalized, pathBytes } from "../../domain/paths.js";
import type { DiscoveryEnvironment, FindingProvider } from "../../ports/providers.js";
import {
  absolutePath,
  basename,
  buildFinding,
  childDirectories,
  exists,
  existingPaths,
  joinPath,
  safeSlug,
  safeText,
  underHome,
} from "../support.js";

const ID = "storage.steam";
const VERSION = 1;

/** A manifest is a few hundred bytes; a library file is a few thousand. */
const MANIFEST_BYTES = 64 * 1024;

const LIBRARY_ROOTS: readonly (readonly string[])[] = [
  [".local", "share", "Steam", "steamapps"],
  [".steam", "steam", "steamapps"],
  [".steam", "root", "steamapps"],
  [".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam", "steamapps"],
];

/**
 * Installed Steam games, and the Proton prefixes they run inside.
 *
 * The size comes from the game's own manifest, which is Steam's figure rather
 * than a measurement: it is what Steam downloaded, not what the filesystem
 * allocated, and a manifest Disktop cannot parse becomes an unknown size and a
 * warning. Reporting a zero there would put the game at the bottom of a list
 * sorted by size and make it look like it had already been removed.
 */
export function createSteamProvider(): FindingProvider {
  return {
    id: ID,
    version: VERSION,
    categories: ["game-data"],

    async probe(environment) {
      const libraries = await libraryRoots(environment);
      return libraries.length > 0
        ? { status: "available", explanation: `${libraries.length} Steam library directories exist.` }
        : { status: "missing-tool", explanation: "No Steam library exists under this home directory." };
    },

    async discover(environment) {
      const findings: Finding[] = [];
      const warnings: Warning[] = [];

      for (const library of await libraryRoots(environment)) {
        for (const entry of await environment.paths.list(library)) {
          const name = basename(entry);
          if (!name.startsWith("appmanifest_") || !name.endsWith(".acf")) {
            continue;
          }
          const manifest = parseManifest(await environment.paths.readText(entry, MANIFEST_BYTES));
          if (manifest === undefined) {
            warnings.push({ code: "unreadable-manifest", message: `${entry.display} could not be read as a Steam manifest.`, path: entry });
            continue;
          }
          const directory = joinPath(library, "common", manifest.installDirectory);
          if (manifest.sizeOnDisk === undefined) {
            warnings.push({
              code: "unreadable-manifest",
              message: `${entry.display} does not state a usable SizeOnDisk, so ${manifest.name} has no size from Steam.`,
              path: entry,
            });
          }
          findings.push(gameFinding(directory, manifest));
        }

        for (const prefix of await childDirectories(environment, joinPath(library, "compatdata"))) {
          findings.push(prefixFinding(prefix));
        }
      }

      return { findings, warnings, complete: true };
    },
  };
}

interface Manifest {
  readonly appId: string;
  readonly name: string;
  readonly installDirectory: string;
  readonly sizeOnDisk?: bigint;
}

function gameFinding(path: RawPath, manifest: Manifest): Finding {
  return buildFinding({
    providerId: ID,
    providerVersion: VERSION,
    category: "game-data",
    slug: `app-${manifest.appId}`,
    title: `Steam game ${safeText(manifest.name)}`,
    evidence: [
      `appmanifest_${manifest.appId}.acf names ${safeText(manifest.installDirectory)} as its install directory.`,
      "Reinstalling means downloading the whole game again; saved games usually live elsewhere.",
    ],
    paths: [path],
    size:
      manifest.sizeOnDisk === undefined
        ? findingSize(undefined, "unknown", "Steam's manifest does not state a usable size for this game.")
        : findingSize(
            manifest.sizeOnDisk,
            "manager-reported",
            "Steam's own SizeOnDisk figure: what it downloaded, not what the filesystem allocated.",
          ),
    actions: ["manager"],
    regenerationCost: "Re-downloaded through Steam, at the size above.",
  });
}

function prefixFinding(path: RawPath): Finding {
  return buildFinding({
    providerId: ID,
    providerVersion: VERSION,
    category: "game-data",
    slug: `compatdata-${safeSlug(basename(path), 48)}`,
    title: `Proton prefix for app ${basename(path)}`,
    evidence: [
      "A Windows environment Proton built for one game, with whatever that game wrote into it.",
      "Some games keep their saves here rather than in the Steam cloud.",
    ],
    paths: [path],
    confidence: "uncertain",
    actions: ["trash"],
    regenerationCost: "Rebuilt on the next launch, losing anything the game stored inside it.",
  });
}

/**
 * The fields this detector needs, out of Valve's key-value format.
 *
 * Only quoted scalars at any depth are read, because that is all a manifest
 * holds that matters here; anything missing makes the manifest unusable rather
 * than partially trusted.
 */
function parseManifest(text: string | undefined): Manifest | undefined {
  if (text === undefined) {
    return undefined;
  }
  const fields = new Map<string, string>();
  for (const match of text.matchAll(/"([^"\n]+)"\s*"([^"\n]*)"/g)) {
    fields.set((match[1] as string).toLowerCase(), match[2] as string);
  }
  const appId = fields.get("appid");
  const name = fields.get("name");
  const installDirectory = fields.get("installdir");
  if (appId === undefined || name === undefined || installDirectory === undefined || !/^[0-9]+$/.test(appId)) {
    return undefined;
  }
  // An install directory is one name inside the library. A manifest is a file
  // anyone with write access to the library can edit, and a value carrying a
  // separator or a `..` would send the measuring scan somewhere else entirely.
  if (installDirectory === "" || /[/\\]/.test(installDirectory) || installDirectory === "." || installDirectory === "..") {
    return undefined;
  }
  const size = fields.get("sizeondisk");
  return {
    appId,
    name,
    installDirectory,
    ...(size !== undefined && /^[0-9]+$/.test(size) ? { sizeOnDisk: BigInt(size) } : {}),
  };
}

/**
 * Every library directory, including the ones `libraryfolders.vdf` names on
 * other disks: a second drive is where the large games usually are.
 */
async function libraryRoots(environment: DiscoveryEnvironment): Promise<readonly RawPath[]> {
  const known = await existingPaths(
    environment,
    LIBRARY_ROOTS.map((segments) => underHome(environment, ...segments)),
  );
  const roots: RawPath[] = [...known];
  const seen = new Set(roots.map((root) => root.bytesBase64));

  for (const library of known) {
    const text = await environment.paths.readText(joinPath(library, "libraryfolders.vdf"), MANIFEST_BYTES);
    if (text === undefined) {
      continue;
    }
    for (const match of text.matchAll(/"path"\s*"([^"\n]+)"/g)) {
      const declared = absolutePath((match[1] as string).replace(/\\\\/g, "/"));
      // A declared library path is text from the same editable file.
      if (declared === undefined || !isAbsoluteNormalized(pathBytes(declared))) {
        continue;
      }
      const steamapps = joinPath(declared, "steamapps");
      if (!seen.has(steamapps.bytesBase64) && (await exists(environment, steamapps))) {
        seen.add(steamapps.bytesBase64);
        roots.push(steamapps);
      }
    }
  }
  return roots;
}
