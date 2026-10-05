import type { Bytes, Capability, RawPath, Warning } from "../domain/models.js";
import type { Accounting } from "./scan.js";

/** One directory measured with administrator rights, and what is directly inside it. */
export interface ElevatedMeasurement {
  readonly path: RawPath;
  readonly bytes: Bytes;
  /** Each entry directly inside, largest first, so the directory can be opened one level. */
  readonly children: readonly { readonly path: RawPath; readonly bytes: Bytes }[];
}

export type ElevatedReading =
  | {
      readonly kind: "measured";
      readonly accounting: Accounting;
      readonly measurements: readonly ElevatedMeasurement[];
      /** Asked about and not measured: a name the tool cannot be given, or one that vanished. */
      readonly skipped: readonly RawPath[];
      readonly warnings: readonly Warning[];
    }
  /** The request for administrator rights was refused or cancelled; nothing was measured. */
  | { readonly kind: "denied"; readonly explanation: string }
  | { readonly kind: "unavailable"; readonly capability: Capability };

export interface ElevatedRunOptions {
  /** True when a person is at a terminal or desktop and can answer a password prompt. */
  readonly interactive: boolean;
  readonly signal: AbortSignal;
}

/**
 * Sizes of directories an ordinary user cannot read, measured read-only by a
 * root-owned system tool through `pkexec` or `sudo`.
 *
 * Nothing Disktop ships runs as root: the program raised is the system's own
 * `du`, its arguments are fixed flags and the absolute paths asked about, and
 * it reads names and sizes only.
 */
export interface ElevatedMeasurePort {
  measure(paths: readonly RawPath[], accounting: Accounting, options: ElevatedRunOptions): Promise<ElevatedReading>;
}

/** What one scan's unreadable directories were found to hold, kept beside the scan. */
export interface ElevatedRecord {
  readonly scanId: string;
  readonly measuredAt: string;
  readonly accounting: Accounting;
  readonly measurements: readonly ElevatedMeasurement[];
  readonly skipped: readonly RawPath[];
}

export interface ElevatedStore {
  save(record: ElevatedRecord): Promise<void>;
  get(scanId: string): Promise<ElevatedRecord | undefined>;
}
