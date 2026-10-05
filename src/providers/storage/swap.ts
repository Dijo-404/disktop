import { findingSize, type Finding } from "../../domain/findings.js";
import type { RawPath } from "../../domain/models.js";
import type { FindingProvider } from "../../ports/providers.js";
import { absolutePath, buildFinding, exists, slugForPath } from "../support.js";

const ID = "storage.swap";
const VERSION = 1;

const SWAPS = "/proc/swaps";
const HIBERNATION_CANDIDATES: readonly string[] = ["/swapfile", "/swap.img", "/var/swap"];

/** Swap devices that live in memory, not on a disk. */
const MEMORY_BACKED = /^\/dev\/(zram|ram)[0-9]+$/;

/** /proc/swaps is a handful of lines. */
const SWAPS_BYTES = 64 * 1024;

export interface SwapOptions {
  readonly swapsPath?: RawPath;
}

/**
 * Swap areas, reported and nothing else.
 *
 * A swap file is often one of the largest files on a machine, which is exactly
 * why it shows up in a list sorted by size and exactly why it must not be
 * offered for deletion: removing it does not reclaim usable space, it removes
 * the memory overflow the running system depends on, and on a machine that
 * hibernates it removes where memory is written. Every finding here has no
 * action at all.
 */
export function createSwapProvider(options: SwapOptions = {}): FindingProvider {
  const swapsPath = options.swapsPath ?? (absolutePath(SWAPS) as RawPath);

  return {
    id: ID,
    version: VERSION,
    categories: ["swap"],

    async probe(environment) {
      if (!(await exists(environment, swapsPath))) {
        return { status: "unsupported-kernel", explanation: `${swapsPath.display} is not readable on this machine.` };
      }
      const areas = parseSwaps(await environment.paths.readText(swapsPath, SWAPS_BYTES));
      return areas.length > 0
        ? { status: "available", explanation: `${areas.length} swap areas are active.` }
        : { status: "missing-tool", explanation: "No swap area is active on this machine." };
    },

    async discover(environment) {
      // zram and RAM disks are memory: a swap area there holds no byte of any
      // disk, and listing its size beside caches would add memory to disk use.
      const areas = parseSwaps(await environment.paths.readText(swapsPath, SWAPS_BYTES)).filter(
        (area) => !MEMORY_BACKED.test(area.filename),
      );
      const findings: Finding[] = areas.map((area) => {
        const path = absolutePath(area.filename);
        return buildFinding({
          providerId: ID,
          providerVersion: VERSION,
          category: "swap",
          slug: slugForPath(path ?? swapsPath),
          title: `Swap ${area.kind} ${area.filename}`,
          evidence: [
            `${swapsPath.display} reports it as an active swap ${area.kind} at priority ${area.priority}.`,
            `${area.usedKibibytes} KiB of ${area.sizeKibibytes} KiB are in use right now.`,
            "Removing it frees no usable space: it is where memory overflows, and on a machine that hibernates it is where memory is written.",
          ],
          ...(path === undefined ? {} : { paths: [path] }),
          size: findingSize(
            area.sizeKibibytes * 1024n,
            "stat",
            `The size ${swapsPath.display} reports, in bytes.`,
          ),
          active: true,
          actions: [],
        });
      });

      // A hibernation image that is not currently swapped on is still not spare space.
      for (const candidate of HIBERNATION_CANDIDATES) {
        const path = absolutePath(candidate) as RawPath;
        if (areas.some((area) => area.filename === candidate) || !(await exists(environment, path))) {
          continue;
        }
        const facts = await environment.paths.facts(path);
        if (facts === undefined || facts.kind !== "file") {
          continue;
        }
        findings.push(
          buildFinding({
            providerId: ID,
            providerVersion: VERSION,
            category: "swap",
            slug: slugForPath(path),
            title: `Inactive swap file ${candidate}`,
            evidence: [
              `${candidate} exists but ${swapsPath.display} does not list it as active.`,
              "It may still be the hibernation target, so it is reported rather than offered.",
            ],
            paths: [path],
            size: findingSize(facts.allocatedBytes, "stat", "Blocks on disk from one stat call."),
            confidence: "uncertain",
            active: true,
            actions: [],
          }),
        );
      }

      return { findings, warnings: [], complete: true };
    },
  };
}

interface SwapArea {
  readonly filename: string;
  readonly kind: string;
  readonly sizeKibibytes: bigint;
  readonly usedKibibytes: bigint;
  readonly priority: string;
}

/** The fixed five columns of /proc/swaps, with the header row skipped. */
function parseSwaps(text: string | undefined): readonly SwapArea[] {
  if (text === undefined) {
    return [];
  }
  const areas: SwapArea[] = [];
  for (const line of text.split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5) {
      continue;
    }
    const [filename, kind, size, used, priority] = columns as [string, string, string, string, string];
    if (!/^[0-9]+$/.test(size) || !/^[0-9]+$/.test(used)) {
      continue;
    }
    areas.push({
      filename,
      kind,
      sizeKibibytes: BigInt(size),
      usedKibibytes: BigInt(used),
      priority,
    });
  }
  return areas;
}
