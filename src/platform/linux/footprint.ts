import { CapabilityUnavailable } from "../../domain/errors.js";
import type { RawPath, Warning } from "../../domain/models.js";
import { isWithin, pathBytes } from "../../domain/paths.js";
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
  readonly scanner: ScanPort;
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
        for await (const event of options.scanner.run(
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
        const measurement = await readRow(options.index, scanId, accounting, path);
        measurements.push(measurement.measurement);
        if (measurement.crowdedOut) {
          warnings.push({
            code: "measurement-crowded-out",
            message: `${path.display} has more entries of its own size than one page holds, so its footprint was not read.`,
            path,
          });
        }
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
        const page = await options.index.query({
          scanId: covering,
          filter: { underPath: home, nameContains: name, kinds: ["directory"] },
          sort: "allocated",
          order: "descending",
          limit: Math.min(share, 1000),
        });
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

      const page = await options.index.query({
        scanId: covering.scanId,
        filter: { underPath: home },
        sort: "allocated",
        order: "descending",
        // The page itself is not wanted; the aggregate is.
        limit: 1,
        includeOwnerTotals: true,
      });

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

/**
 * One path's own row in the index.
 *
 * The subtree filter includes the path itself, and a directory's row carries
 * its whole subtree, so the path's own row is at or near the top of a listing
 * ranked by size. It is not reliably *first*: a directory holding one large
 * file ties with that file, and a chain of single-child directories ties all
 * the way down. So a bounded page is read and the row whose bytes are the ones
 * asked about is picked out of it. A row for some other path is never accepted
 * as this path's size, and a path the page does not reach is reported unknown
 * rather than guessed at.
 */
const ROW_PAGE = 256;

/** What the helper's own owner-totals aggregate is bounded to. */
const OWNER_TOTALS_CAP = 64;

async function readRow(
  index: FileIndexPort,
  scanId: string,
  accounting: Accounting,
  path: RawPath,
): Promise<{ readonly measurement: FootprintMeasurement; readonly crowdedOut: boolean }> {
  let page;
  try {
    page = await index.query({
      scanId,
      filter: { underPath: path },
      sort: accounting === "apparent" ? "apparent" : "allocated",
      order: "descending",
      limit: ROW_PAGE,
    });
  } catch (error) {
    const detail =
      error instanceof CapabilityUnavailable ? error.capability.explanation : "The index could not answer the query.";
    return { measurement: unmeasured(path, detail), crowdedOut: false };
  }

  const row = page.entries.find((entry) => entry.path.bytesBase64 === path.bytesBase64);
  if (row === undefined) {
    // A full page means the row may exist and be ranked below the page: a tree
    // of hardlinks to one file ties with the directory holding them. That is a
    // different fact from a path the scan never reached, and it is reported.
    const crowdedOut = page.nextCursor !== undefined;
    return {
      measurement: unmeasured(
        path,
        crowdedOut
          ? "The scan index holds more entries of this size than one page holds, so this path's own row was not reached."
          : "The scan index holds no row for this path.",
      ),
      crowdedOut,
    };
  }
  return {
    measurement: {
      path,
      bytes: accounting === "apparent" ? row.apparentBytes : row.allocatedBytes,
      basis: accounting === "apparent" ? "measured-apparent" : "measured-allocated",
      explanation:
        accounting === "apparent"
          ? "The size the files claim, measured by the scan that covered this path."
          : "Blocks on disk, measured by the scan that covered this path.",
    },
    crowdedOut: false,
  };
}

function unmeasured(path: RawPath, reason: string): FootprintMeasurement {
  return { path, basis: "unknown", explanation: reason };
}

/** The newest snapshot one of whose roots is the path or an ancestor of it. */
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
  const target = pathBytes(wanted);
  const stored = await snapshots.list();
  const covering = stored.find((snapshot) =>
    snapshot.scope.roots.some((root) => isWithin(pathBytes(root), target)),
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
