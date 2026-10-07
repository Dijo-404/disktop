import {
  categoryTotals,
  deduplicateFindings,
  orderFindings,
  type CategoryTotal,
  type Finding,
  type FindingCategory,
} from "../domain/findings.js";
import type { Capability, RawPath, Warning } from "../domain/models.js";
import { sanitizeText } from "../domain/paths.js";
import type {
  DiscoveryEnvironment,
  FindingProvider,
  FootprintMeasurement,
  FootprintPort,
} from "../ports/providers.js";

/** How many providers may be discovering at once. */
const CONCURRENCY = 4;

export interface ProviderReport {
  readonly providerId: string;
  readonly version: number;
  readonly capability: Capability;
  readonly findings: number;
  readonly complete: boolean;
  /** False when the detector never answered: it was absent, denied, or it threw. */
  readonly ran: boolean;
}

export interface FootprintSummary {
  readonly findings: readonly Finding[];
  readonly providers: readonly ProviderReport[];
  readonly warnings: readonly Warning[];
  readonly complete: boolean;
  readonly categoryTotals: readonly CategoryTotal[];
  /** False when sizes were not measured, which is why a size may be unknown. */
  readonly measured: boolean;
  readonly capability: Capability;
}

export interface FootprintRequest {
  readonly categories?: readonly FindingCategory[];
  readonly measureSizes: boolean;
}

export interface FootprintService {
  discover(request: FootprintRequest, signal: AbortSignal): Promise<FootprintSummary>;
}

/**
 * Ask every provider what it can see, then merge the answers.
 *
 * Three things make this more than a loop. A provider that cannot look is
 * listed with the reason, so a short list is never read as an empty disk. A
 * provider that fails does not take the others with it. And no provider
 * measures its own directories: they name paths, and one port measures all of
 * them at the end, so the byte counts in a result all come from the same
 * reading and carry the same basis.
 */
export function createFootprintService(
  providers: readonly FindingProvider[],
  environment: DiscoveryEnvironment,
  footprints: FootprintPort,
): FootprintService {
  return {
    async discover(request, signal) {
      const selected = providers.filter((provider) => matchesRequest(provider, request.categories));

      if (signal.aborted) {
        return summarize({
          findings: [],
          reports: [],
          warnings: [{ code: "cancelled", message: "Discovery was cancelled before any detector ran." }],
          complete: false,
          measured: false,
          selected,
        });
      }

      const reports: ProviderReport[] = [];
      const warnings: Warning[] = [];
      const found: Finding[] = [];
      let complete = true;
      // Every detector's query belongs to this discovery task, including its
      // capability probe. The immutable wrapper keeps simultaneous requests
      // independent and means a provider cannot forget to carry cancellation.
      const scopedEnvironment: DiscoveryEnvironment = {
        ...environment,
        tools: { run: (name, args) => environment.tools.run(name, args, signal) },
        index: {
          directoriesNamed: (names, limit) => environment.index.directoriesNamed(names, limit, signal),
          ownerTotals: (limit) => environment.index.ownerTotals(limit, signal),
          entriesUnder: (root, limit) => environment.index.entriesUnder(root, limit, signal),
        },
      };

      const outcomes = await mapWithLimit(selected, CONCURRENCY, signal, (provider) =>
        ask(provider, scopedEnvironment, signal),
      );
      for (const outcome of outcomes) {
        if (outcome === undefined) {
          // Cancelled before this detector was asked.
          continue;
        }
        reports.push(outcome.report);
        warnings.push(...outcome.warnings);
        found.push(...outcome.findings);
        complete &&= outcome.report.complete;
      }

      if (signal.aborted) {
        warnings.push({ code: "cancelled", message: "Discovery was cancelled before every detector answered." });
        complete = false;
      }

      const wanted = request.categories;
      const merged = deduplicateFindings(
        wanted === undefined || wanted.length === 0
          ? found
          : found.filter((entry) => wanted.includes(entry.category)),
      );
      const measurement = request.measureSizes
        ? await measure(merged.kept, footprints, signal)
        : { findings: merged.kept, warnings: [], measured: true, complete: true };

      return summarize({
        findings: measurement.findings,
        reports,
        warnings: [...warnings, ...measurement.warnings],
        // Sizes that were asked for and could not be established are a short
        // answer, not a complete one. Sizes nobody asked for are neither.
        complete: complete && measurement.complete,
        measured: request.measureSizes && measurement.measured,
        selected,
      });
    },
  };
}

/** Probe, then discover. A provider that cannot look is never asked to. */
async function ask(
  provider: FindingProvider,
  environment: DiscoveryEnvironment,
  signal: AbortSignal,
): Promise<{ report: ProviderReport; findings: readonly Finding[]; warnings: readonly Warning[] }> {
  let capability: Capability;
  try {
    capability = await provider.probe(environment, signal);
  } catch (error) {
    return failed(provider, error, "could not be probed");
  }

  if (capability.status !== "available") {
    // A tool that is absent, or a kernel that cannot do this, is a fact about
    // the machine. A denial is data this machine holds that Disktop could not
    // read, and that makes the whole answer short.
    const hidden = capability.status === "permission-denied";
    return {
      report: { providerId: provider.id, version: provider.version, capability, findings: 0, complete: !hidden, ran: false },
      findings: [],
      warnings: hidden
        ? [{ code: "provider-denied", message: `${provider.id} was denied: ${capability.explanation}` }]
        : [],
    };
  }

  try {
    const result = await provider.discover(environment, signal);
    const bounded = result.findings.slice(0, environment.maxFindingsPerProvider);
    const truncated = bounded.length < result.findings.length;
    return {
      report: {
        providerId: provider.id,
        version: provider.version,
        capability,
        findings: bounded.length,
        complete: result.complete && !truncated,
        ran: true,
      },
      findings: bounded,
      warnings: truncated
        ? [
            ...result.warnings,
            {
              code: "findings-truncated",
              message: `${provider.id} found ${result.findings.length} items; only the first ${bounded.length} are listed.`,
            },
          ]
        : result.warnings,
    };
  } catch (error) {
    return failed(provider, error, "failed while discovering");
  }
}

function failed(
  provider: FindingProvider,
  error: unknown,
  what: string,
): { report: ProviderReport; findings: readonly Finding[]; warnings: readonly Warning[] } {
  const detail = sanitizeText(error instanceof Error ? error.message : "unknown error");
  const code = typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  const denied = code === "EACCES" || code === "EPERM";
  return {
    report: {
      providerId: provider.id,
      version: provider.version,
      capability: { status: denied ? "permission-denied" : "available", explanation: `${provider.id} ${what} and reported nothing: ${detail}` },
      findings: 0,
      complete: false,
      ran: false,
    },
    findings: [],
    warnings: [{ code: denied ? "provider-denied" : "provider-failed", message: `${provider.id} ${what}: ${detail}` }],
  };
}

/**
 * Fill in every size nothing has established yet, in one reading.
 *
 * A measurement that comes back unknown leaves the finding unknown. Nothing
 * here turns an unmeasured directory into zero bytes.
 */
async function measure(
  findings: readonly Finding[],
  footprints: FootprintPort,
  signal: AbortSignal,
): Promise<{ findings: readonly Finding[]; warnings: readonly Warning[]; measured: boolean; complete: boolean }> {
  const wanted = new Map<string, RawPath>();
  for (const finding of findings) {
    if (finding.size.basis !== "unknown") {
      continue;
    }
    for (const path of finding.paths) {
      wanted.set(path.bytesBase64, path);
    }
  }

  if (wanted.size === 0) {
    return { findings, warnings: [], measured: true, complete: true };
  }

  const reading = await footprints.measure([...wanted.values()], signal);
  const byPath = new Map<string, FootprintMeasurement>(
    reading.measurements.map((measurement) => [measurement.path.bytesBase64, measurement]),
  );
  const anyMeasured = reading.measurements.some((measurement) => measurement.bytes !== undefined);
  const unmeasured = [...wanted.values()].filter((path) => byPath.get(path.bytesBase64)?.bytes === undefined);

  return {
    findings: findings.map((finding) => {
      if (finding.size.basis !== "unknown" || finding.paths.length === 0) {
        return finding;
      }
      const parts = finding.paths.map((path) => byPath.get(path.bytesBase64));
      if (parts.some((part) => part === undefined || part.bytes === undefined)) {
        return finding;
      }
      const measured = parts as readonly FootprintMeasurement[];
      const total = measured.reduce((sum, part) => sum + (part.bytes ?? 0n), 0n);
      const first = measured[0] as FootprintMeasurement;
      return {
        ...finding,
        size: { bytes: total, basis: first.basis, explanation: first.explanation },
      };
    }),
    warnings: unmeasured.length > 0 && reading.warnings.length === 0
      ? [{ code: "measurement-incomplete", message: `${unmeasured.length} requested footprint(s) could not be measured; their sizes remain unknown.`, ...(unmeasured.length === 1 ? { path: unmeasured[0] as RawPath } : {}) }]
      : reading.warnings,
    measured: anyMeasured,
    complete: unmeasured.length === 0,
  };
}

function summarize(input: {
  findings: readonly Finding[];
  reports: readonly ProviderReport[];
  warnings: readonly Warning[];
  complete: boolean;
  measured: boolean;
  selected: readonly FindingProvider[];
}): FootprintSummary {
  const ordered = orderFindings(input.findings);
  const ran = input.reports.filter((report) => report.ran).length;
  return {
    findings: ordered,
    providers: input.reports,
    warnings: input.warnings,
    complete: input.complete,
    categoryTotals: categoryTotals(ordered),
    measured: input.measured,
    capability: {
      status: "available",
      explanation: `${ran} of ${input.selected.length} detectors ran.`,
    },
  };
}

function matchesRequest(provider: FindingProvider, categories: readonly FindingCategory[] | undefined): boolean {
  if (categories === undefined || categories.length === 0) {
    return true;
  }
  return provider.categories.some((category) => categories.includes(category));
}

/**
 * Run at most `limit` at a time, keeping the results in the input's order.
 *
 * A cancelled run stops asking. Ctrl+C during discovery would otherwise wait
 * for every remaining detector to finish spawning its commands, which on a
 * machine with a package manager and a disk full of caches is a long time to
 * ignore somebody who asked for it to stop.
 */
async function mapWithLimit<Input, Output>(
  inputs: readonly Input[],
  limit: number,
  signal: AbortSignal,
  work: (input: Input) => Promise<Output>,
): Promise<readonly (Output | undefined)[]> {
  const results: (Output | undefined)[] = new Array(inputs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, inputs.length) }, async () => {
    for (let index = next; index < inputs.length && !signal.aborted; index = next) {
      next += 1;
      results[index] = await work(inputs[index] as Input);
    }
  });
  await Promise.all(workers);
  return results;
}
