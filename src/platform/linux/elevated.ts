import { spawn as spawnProcess } from "node:child_process";
import type { RawPath, Warning } from "../../domain/models.js";
import { bytesEqual, isAbsoluteNormalized, pathBytes, rawPathFromBytes, sanitizeText } from "../../domain/paths.js";
import type { ElevatedMeasurement, ElevatedMeasurePort, ElevatedReading } from "../../ports/elevated.js";
import type { Accounting } from "../../ports/scan.js";
import { deniedByEscalation } from "./privilege.js";
import { resolveTrustedExecutable, toolEnvironment } from "./process.js";

/** More paths than this in one request is a request somebody should look at first. */
export const MAX_ELEVATED_PATHS = 4096;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MILLISECONDS = 30 * 60_000;

export interface Elevation {
  readonly kind: "none" | "sudo" | "pkexec";
  readonly argv: readonly string[];
}

export interface ElevationFacts {
  readonly euid: number;
  readonly interactive: boolean;
  /** A desktop session is running, so pkexec's password dialog can appear in it. */
  readonly graphical: boolean;
  readonly sudo?: string;
  readonly pkexec?: string;
}

/**
 * How the measuring tool is raised.
 *
 * At a desktop, pkexec asks through the session's own password dialog, which
 * is the prompt a person expects there; at a bare terminal, sudo asks on the
 * terminal. Without anybody to answer, only sudo's cached credentials can be
 * used, and `-n` makes it fail rather than wait for a password nobody types.
 */
export function elevationFor(facts: ElevationFacts): Elevation | { readonly refusal: string } {
  if (facts.euid === 0) {
    return { kind: "none", argv: [] };
  }
  if (!facts.interactive) {
    if (facts.sudo !== undefined) {
      return { kind: "sudo", argv: [facts.sudo, "-n", "--"] };
    }
    return { refusal: "Measuring unreadable directories needs administrator rights, and nobody is here to enter a password." };
  }
  if (facts.graphical && facts.pkexec !== undefined) {
    return { kind: "pkexec", argv: [facts.pkexec] };
  }
  if (facts.sudo !== undefined) {
    return { kind: "sudo", argv: [facts.sudo, "--"] };
  }
  if (facts.pkexec !== undefined) {
    return { kind: "pkexec", argv: [facts.pkexec] };
  }
  return { refusal: "Measuring unreadable directories needs administrator rights, and neither sudo nor pkexec is installed." };
}

export interface ElevatedSpawnResult {
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly error?: string;
}

export type ElevatedSpawn = (
  program: string,
  argv: readonly string[],
  options: { readonly interactive: boolean; readonly signal: AbortSignal; readonly env: Readonly<Record<string, string>> },
) => Promise<ElevatedSpawnResult>;

export interface ElevatedDuOptions {
  readonly spawn?: ElevatedSpawn;
  readonly resolve?: (name: string) => Promise<string | undefined>;
  readonly euid?: number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** The fixed flags: one filesystem, NUL-separated records, each path and every entry directly inside it, files included. */
export function duArguments(accounting: Accounting, paths: readonly string[]): readonly string[] {
  return ["-x", "-a", "-0", "-d", "1", accounting === "apparent" ? "-b" : "-B1", "--", ...paths];
}

/**
 * `du`, run as root through pkexec or sudo, over directories a scan could not
 * read.
 *
 * The raised program is the system's own root-owned `du`, never anything
 * Disktop ships, so a user-writable installation never has its code run as
 * root. `-x` keeps it on each directory's own filesystem, which also stops it
 * at a container's overlay mounts that would count an image twice.
 */
export function createElevatedDu(options: ElevatedDuOptions = {}): ElevatedMeasurePort {
  const spawn = options.spawn ?? spawnElevated;
  const resolve = options.resolve ?? resolveTrustedExecutable;
  const euid = options.euid ?? process.geteuid?.() ?? -1;
  const environment = options.environment ?? process.env;

  return {
    async measure(paths, accounting, runOptions): Promise<ElevatedReading> {
      const du = await resolve("du");
      if (du === undefined) {
        return { kind: "unavailable", capability: { status: "missing-tool", explanation: "du is not installed in a trusted system directory." } };
      }
      const sudo = await resolve("sudo");
      const pkexec = await resolve("pkexec");
      const elevation = elevationFor({
        euid,
        interactive: runOptions.interactive,
        graphical: (environment.DISPLAY ?? "") !== "" || (environment.WAYLAND_DISPLAY ?? "") !== "",
        ...(sudo === undefined ? {} : { sudo }),
        ...(pkexec === undefined ? {} : { pkexec }),
      });
      if ("refusal" in elevation) {
        return { kind: "unavailable", capability: { status: "permission-denied", explanation: elevation.refusal } };
      }

      // Only a name that survives as text can be handed to a program, and only
      // an absolute, normalised one is a path rather than something du could
      // read as an option.
      const asked: RawPath[] = [];
      const skipped: RawPath[] = [];
      for (const path of paths.slice(0, MAX_ELEVATED_PATHS)) {
        if (path.utf8 !== undefined && isAbsoluteNormalized(pathBytes(path)) && !path.utf8.includes("\0")) {
          asked.push(path);
        } else {
          skipped.push(path);
        }
      }
      skipped.push(...paths.slice(MAX_ELEVATED_PATHS));
      if (asked.length === 0) {
        return { kind: "measured", accounting, measurements: [], skipped, warnings: [] };
      }
      if (runOptions.signal.aborted) {
        return { kind: "denied", explanation: "Stopped before administrator rights were asked for; nothing was measured." };
      }

      const [program, ...prefix] = elevation.kind === "none" ? [du] : [...elevation.argv, du];
      const env = toolEnvironment(environment);
      // pkexec reads these to find the session whose dialog should ask.
      for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"] as const) {
        const value = environment[name];
        if (value !== undefined && elevation.kind === "pkexec") {
          env[name] = value;
        }
      }
      const result = await spawn(program as string, [...prefix, ...duArguments(accounting, asked.map((path) => path.utf8 as string))], {
        interactive: runOptions.interactive,
        signal: runOptions.signal,
        env,
      });

      if (runOptions.signal.aborted) {
        return { kind: "denied", explanation: "Stopped while measuring; nothing was kept." };
      }
      if (elevation.kind !== "none" && deniedByEscalation(elevation.kind, result.exitCode, result.stderr)) {
        const reason = result.stderr.split("\n").find((line) => line.startsWith("sudo:"));
        return { kind: "denied", explanation: sanitizeText(reason ?? "The request for administrator rights was refused or cancelled; nothing was measured.") };
      }
      if (result.error !== undefined) {
        return { kind: "unavailable", capability: { status: "missing-tool", explanation: sanitizeText(result.error) } };
      }

      const warnings: Warning[] = [];
      if (result.truncated) {
        warnings.push({ code: "elevated-output-truncated", message: "du wrote more than Disktop reads; the last directories were not measured." });
      }
      for (const line of result.stderr.split("\n").filter((text) => text.startsWith("du:")).slice(0, 20)) {
        warnings.push({ code: "elevated-partial", message: sanitizeText(line) });
      }
      const measurements = measurementsFrom(parseDuOutput(result.stdout), asked);
      const measured = new Set(measurements.map((entry) => entry.path.bytesBase64));
      skipped.push(...asked.filter((path) => !measured.has(path.bytesBase64)));
      return { kind: "measured", accounting, measurements, skipped, warnings };
    },
  };
}

/** `SIZE\tPATH\0` records, with the path kept as the bytes du wrote. */
export function parseDuOutput(output: Buffer): readonly { readonly path: Uint8Array; readonly bytes: bigint }[] {
  const records: { path: Uint8Array; bytes: bigint }[] = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    if (end === -1) {
      // The last record lost its terminator to a cut: it is not trusted.
      break;
    }
    const record = output.subarray(start, end);
    start = end + 1;
    const tab = record.indexOf(0x09);
    if (tab <= 0) {
      continue;
    }
    const size = record.subarray(0, tab).toString("ascii");
    if (!/^(0|[1-9][0-9]*)$/.test(size)) {
      continue;
    }
    records.push({ path: new Uint8Array(record.subarray(tab + 1)), bytes: BigInt(size) });
  }
  return records;
}

/** Each asked-for directory with its own total and the totals of what is directly inside it. */
export function measurementsFrom(
  records: readonly { readonly path: Uint8Array; readonly bytes: bigint }[],
  asked: readonly RawPath[],
): readonly ElevatedMeasurement[] {
  const measurements: ElevatedMeasurement[] = [];
  for (const path of asked) {
    const bytes = pathBytes(path);
    const own = records.find((record) => bytesEqual(record.path, bytes));
    if (own === undefined) {
      continue;
    }
    const children = records
      .filter((record) => isDirectChild(bytes, record.path))
      .sort((left, right) => (left.bytes === right.bytes ? 0 : left.bytes > right.bytes ? -1 : 1))
      .map((record) => ({ path: rawPathFromBytes(record.path), bytes: record.bytes }));
    measurements.push({ path, bytes: own.bytes, children });
  }
  return measurements;
}

function isDirectChild(parent: Uint8Array, candidate: Uint8Array): boolean {
  const base = parent.length === 1 ? 0 : parent.length;
  if (candidate.length <= base + 1 || candidate[base] !== 0x2f) {
    return false;
  }
  if (!bytesEqual(candidate.subarray(0, base), parent.subarray(0, base))) {
    return false;
  }
  return !candidate.subarray(base + 1).includes(0x2f);
}

/**
 * Run the raised tool with its output kept as bytes and bounded.
 *
 * An abort sends SIGTERM, which sudo relays to the tool it started. pkexec
 * becomes the tool itself, a root process this one may not signal, so the
 * pipes are closed as well and the tool stops at its next write.
 */
export const spawnElevated: ElevatedSpawn = (program, argv, options) =>
  new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = "";
    const child = spawnProcess(program, [...argv], {
      shell: false,
      env: { ...options.env },
      stdio: [options.interactive ? "inherit" : "ignore", "pipe", "pipe"],
    });
    const stop = (): void => {
      child.kill("SIGTERM");
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const timer = setTimeout(stop, TIMEOUT_MILLISECONDS);
    if (options.signal.aborted) {
      stop();
    } else {
      options.signal.addEventListener("abort", stop, { once: true });
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (size + chunk.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        stop();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-64 * 1024);
    });
    let settled = false;
    const finish = (result: ElevatedSpawnResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", stop);
      resolvePromise(result);
    };
    child.on("error", (error) => finish({ exitCode: null, stdout: Buffer.concat(chunks), stderr, truncated, error: error.message }));
    child.on("close", (code) => finish({ exitCode: code, stdout: Buffer.concat(chunks), stderr, truncated }));
  });
