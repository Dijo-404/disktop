import { CapabilityUnavailable } from "../../domain/errors.js";
import type { RawPath, Warning } from "../../domain/models.js";
import { isWithin, pathBytes } from "../../domain/paths.js";
import type { Accounting, FileIndexPort, ScanPort } from "../../ports/scan.js";
import type { FootprintMeasurement, FootprintPort, FootprintReading, IndexSearchPort } from "../../ports/providers.js";
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
        measurements.push(await readRow(options.index, scanId, accounting, path));
      }
      return { measurements, warnings };
    },

    async directoriesNamed(names, limit) {
      const home = options.home;
      if (home === undefined) {
        return { paths: [], searched: false };
      }
      const covering = await newestCovering(options.snapshots, home);
      if (covering === undefined) {
        // No stored scan reaches this tree. "Nothing found" and "nobody
        // looked" must not read the same, so the caller is told which it is.
        return { paths: [], searched: false };
      }

      const found: RawPath[] = [];
      for (const name of names) {
        if (found.length >= limit) {
          break;
        }
        const page = await options.index.query({
          scanId: covering,
          filter: { underPath: home, nameContains: name, kinds: ["directory"] },
          sort: "allocated",
          order: "descending",
          limit: Math.min(limit - found.length, 1000),
        });
        for (const entry of page.entries) {
          if (lastSegment(entry.path) === name) {
            found.push(entry.path);
          }
        }
      }
      return { paths: found.slice(0, limit), searched: true };
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
      filter: { underPath: path },
      sort: accounting === "apparent" ? "apparent" : "allocated",
      order: "descending",
      limit: ROW_PAGE,
    });
  } catch (error) {
    const detail = error instanceof CapabilityUnavailable ? error.capability.explanation : "the index refused the query";
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

/** The newest snapshot one of whose roots is the path or an ancestor of it. */
async function newestCovering(
  snapshots: Pick<SnapshotStore, "list">,
  wanted: RawPath,
): Promise<string | undefined> {
  const target = pathBytes(wanted);
  const stored = await snapshots.list();
  const covering = stored.find((snapshot) =>
    snapshot.scope.roots.some((root) => isWithin(pathBytes(root), target)),
  );
  return covering?.scanId;
}

function lastSegment(path: RawPath): string {
  const text = path.utf8 ?? path.display;
  return text.slice(text.lastIndexOf("/") + 1);
}
