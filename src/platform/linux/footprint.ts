import { CapabilityUnavailable } from "../../domain/errors.js";
import type { RawPath, Warning } from "../../domain/models.js";
import { scanReaches } from "../../domain/paths.js";
import type { Accounting, FileIndexPort, ScanPort } from "../../ports/scan.js";
import type {
  FootprintMeasurement,
  FootprintPort,
  FootprintReading,
  IndexSearchPort,
  OwnerUsageReading,
} from "../../ports/providers.js";
import type { SnapshotStore } from "../../ports/snapshots.js";

export interface IndexFootprintOptions {
  /**
   * Where measuring scans are written and read back.
   *
   * It must not be the index a person's own scans live in. That index keeps a
   * few scans and prunes the oldest, so every measurement written there would
   * push out a scan somebody is still exploring, and two runs of
   * `disktop clean` would be enough to lose it.
   */
  readonly measurement: ScanPort & FileIndexPort;
  /** The index a person's own scans live in, which `snapshots` describe. Only read. */
  readonly index: FileIndexPort;
  readonly snapshots: Pick<SnapshotStore, "list">;
  /** The root a name search is answered from. */
  readonly home?: RawPath;
  readonly accounting: Accounting;
  readonly crossFilesystems: boolean;
  readonly excludes: readonly RawPath[];
}

/**
 * Footprints, measured by the helper rather than by a provider.
 *
 * One scan covers every candidate at once, which is the whole reason this sits
 * between the detectors and the helper: twenty providers each measuring their
 * own directories would be twenty traversals, and the numbers they produced
 * would not share an accounting mode.
 *
 * A directory's index row already carries its subtree total, so reading a
 * footprint afterwards is one bounded query per path and no second walk.
 */
export function createIndexFootprint(options: IndexFootprintOptions): FootprintPort & IndexSearchPort {
  return {
    async measure(paths, signal): Promise<FootprintReading> {
      if (paths.length === 0) {
        return { measurements: [], warnings: [] };
      }

      let scanId: string | undefined;
      let accounting: Accounting = options.accounting;
      const warnings: Warning[] = [];

      try {
        for await (const event of options.measurement.run(
          {
            roots: [...paths],
            crossFilesystems: options.crossFilesystems,
            excludes: [...options.excludes],
            accounting: options.accounting,
          },
          signal,
        )) {
          if (event.kind === "warning") {
            warnings.push(event.warning);
            continue;
          }
          if (event.kind === "complete") {
            scanId = event.scanId;
            accounting = event.accounting;
            warnings.push(...event.completeness.warnings);
          }
        }
      } catch (error) {
        if (!(error instanceof CapabilityUnavailable)) {
          throw error;
        }
        // Nothing was measured. Reporting zero here would be a lie that looks
        // like a clean machine, so every path comes back unknown instead.
        return {
          measurements: paths.map((path) => unmeasured(path, error.capability.explanation)),
          warnings: [
            {
              code: "measurement-unavailable",
              message: `Footprints could not be measured: ${error.capability.explanation}`,
            },
          ],
        };
      }

      if (scanId === undefined) {
        return {
          measurements: paths.map((path) => unmeasured(path, "The measuring scan ended without a result.")),
          warnings: [{ code: "measurement-unavailable", message: "The measuring scan ended without a result." }],
        };
      }

      const measurements: FootprintMeasurement[] = [];
      for (const path of paths) {
        measurements.push(await readRow(options.measurement, scanId, accounting, path));
      }
      return { measurements, warnings };
    },

    /**
     * Directories matching any of these names, with a budget for each.
     *
     * The budget is per name rather than shared, because a shared one is spent
     * in list order: a machine with fifty `node_modules` directories would
     * never hear about its Rust `target` directories, which are usually the
     * larger of the two. A name that had more matches than its share sets
     * `truncated`, so the caller says so instead of listing fewer in silence.
     */
    async entriesUnder(root, limit) {
      const covering = await newestCovering(options.snapshots, root);
      if (covering === undefined) {
        // No stored scan reaches this path. "Nothing is there" and "nobody
        // looked" must not read the same, so the caller is told which it is.
        return { entries: [], searched: false, truncated: false };
      }
      const page = await unlessUnheld(() =>
        options.index.query({
          scanId: covering,
          filter: { underPath: root },
          sort: "allocated",
          order: "descending",
          limit: Math.min(Math.max(1, limit), 1000),
        }),
      );
      if (page === undefined) {
        return { entries: [], searched: false, truncated: false };
      }
      return {
        entries: page.entries,
        searched: true,
        truncated: page.nextCursor !== undefined,
      };
    },

    async directoriesNamed(names, limit) {
      const home = options.home;
      if (home === undefined) {
        return { paths: [], searched: false, truncated: false };
      }
      const covering = await newestCovering(options.snapshots, home);
      if (covering === undefined) {
        // No stored scan reaches this tree. "Nothing found" and "nobody
        // looked" must not read the same, so the caller is told which it is.
        return { paths: [], searched: false, truncated: false };
      }

      const share = Math.max(1, Math.floor(limit / Math.max(1, names.length)));
      const found: RawPath[] = [];
      let truncated = false;
      for (const name of names) {
        const page = await unlessUnheld(() =>
          options.index.query({
            scanId: covering,
            filter: { underPath: home, nameContains: name, kinds: ["directory"] },
            sort: "allocated",
            order: "descending",
            limit: Math.min(share, 1000),
          }),
        );
        if (page === undefined) {
          return { paths: [], searched: false, truncated: false };
        }
        const matching = page.entries.filter((entry) => lastSegment(entry.path) === name);
        found.push(...matching.map((entry) => entry.path));
        truncated ||= page.nextCursor !== undefined;
      }
      return { paths: found.slice(0, limit), searched: true, truncated: truncated || found.length > limit };
    },

    async ownerTotals(limit): Promise<OwnerUsageReading> {
      const home = options.home;
      if (home === undefined) {
        return { owners: [], searched: false, complete: false, truncated: false };
      }
      const covering = await newestCoveringSnapshot(options.snapshots, home);
      if (covering === undefined) {
        return { owners: [], searched: false, complete: false, truncated: false };
      }

      const page = await unlessUnheld(() =>
        options.index.query({
          scanId: covering.scanId,
          filter: { underPath: home },
          sort: "allocated",
          order: "descending",
          // The page itself is not wanted; the aggregate is.
          limit: 1,
          includeOwnerTotals: true,
        }),
      );
      if (page === undefined) {
        return { owners: [], searched: false, complete: false, truncated: false };
      }

      const owners = page.ownerTotals ?? [];
      return {
        owners: owners.slice(0, limit),
        searched: true,
        complete: covering.complete,
        // The helper caps the aggregate too, so a full list may be a cut one.
        truncated: owners.length > limit || owners.length >= OWNER_TOTALS_CAP,
      };
    },
  };
}

/** What the helper's own owner-totals aggregate is bounded to. */
const OWNER_TOTALS_CAP = 64;

/**
 * One path's own row in the index, asked for by the path itself.
 *
 * A directory's row carries its whole subtree, so it is at or near the top of
 * a listing ranked by size, but not reliably first: a directory whose own
 * inode holds no blocks ties with the files below it, and a few hundred empty
 * files under one Btrfs directory would push its row off any page. `atPath`
 * returns exactly the one row. A row for some other path is still never
 * accepted as this path's size, and a path the index does not hold is
 * reported unknown rather than guessed at.
 */
async function readRow(
  index: FileIndexPort,
  scanId: string,
  accounting: Accounting,
  path: RawPath,
): Promise<FootprintMeasurement> {
  let page;
  try {
    page = await index.query({
      scanId,
      filter: { atPath: path },
      sort: accounting === "apparent" ? "apparent" : "allocated",
      order: "descending",
      limit: 1,
    });
  } catch (error) {
    // The helper refuses a path the scan never saw rather than answering with
    // an empty page; either way there is no row for it.
    const detail =
      error instanceof CapabilityUnavailable
        ? error.capability.explanation
        : "The scan index holds no row for this path.";
    return unmeasured(path, detail);
  }

  const row = page.entries.find((entry) => entry.path.bytesBase64 === path.bytesBase64);
  if (row === undefined) {
    return unmeasured(path, "The scan index holds no row for this path.");
  }
  return {
    path,
    bytes: accounting === "apparent" ? row.apparentBytes : row.allocatedBytes,
    basis: accounting === "apparent" ? "measured-apparent" : "measured-allocated",
    explanation:
      accounting === "apparent"
        ? "The size the files claim, measured by the scan that covered this path."
        : "Blocks on disk, measured by the scan that covered this path.",
  };
}

function unmeasured(path: RawPath, reason: string): FootprintMeasurement {
  return { path, basis: "unknown", explanation: reason };
}

/**
 * A page, or nothing when the index no longer holds that scan or that path.
 *
 * A snapshot outlives its detailed index, which keeps only the newest few
 * scans, and the helper refuses a path a scan never reached rather than
 * answering with an empty page. Either way nobody looked, which the caller
 * reports as a search that did not happen, never as a detector that failed or
 * as nothing found.
 */
async function unlessUnheld<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof CapabilityUnavailable) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The newest snapshot that really reached the path: one of its roots is the
 * path or an ancestor, and neither an exclude nor a mount the walk stayed out
 * of sits between the two. A scan of `/` that refused `/home` as another
 * filesystem names an ancestor of every home directory and holds none of them.
 */
async function newestCovering(
  snapshots: Pick<SnapshotStore, "list">,
  wanted: RawPath,
): Promise<string | undefined> {
  return (await newestCoveringSnapshot(snapshots, wanted))?.scanId;
}

async function newestCoveringSnapshot(
  snapshots: Pick<SnapshotStore, "list">,
  wanted: RawPath,
): Promise<{ readonly scanId: string; readonly complete: boolean } | undefined> {
  const stored = await snapshots.list();
  const covering = stored.find((snapshot) =>
    scanReaches(snapshot.scope.roots, [...snapshot.scope.excludes, ...(snapshot.completeness?.excludedMounts ?? [])], wanted),
  );
  if (covering === undefined) {
    return undefined;
  }
  return { scanId: covering.scanId, complete: covering.completeness?.complete ?? true };
}

function lastSegment(path: RawPath): string {
  const text = path.utf8 ?? path.display;
  return text.slice(text.lastIndexOf("/") + 1);
}
