import type { Warning } from "../../../domain/models.js";
import { sanitizeText } from "../../../domain/paths.js";

/** One row of `lsblk --json --bytes` with the columns Disktop asks for by name. */
export interface BlockDevice {
  readonly name: string;
  readonly kernelName: string;
  readonly type: string;
  readonly sizeBytes: bigint;
  readonly rotational: boolean | undefined;
  readonly removable: boolean;
  readonly model: string | undefined;
  readonly transport: string | undefined;
  readonly major: number | undefined;
  readonly minor: number | undefined;
  readonly parentName: string | undefined;
  /** The node under `/dev`, which is how a mount names its source. */
  readonly path: string | undefined;
}

export interface LsblkResult {
  readonly devices: readonly BlockDevice[];
  readonly warnings: readonly Warning[];
}

/** Asked for by name so a future lsblk column order cannot shift a value. */
export const LSBLK_COLUMNS = "NAME,KNAME,PATH,TYPE,SIZE,ROTA,RM,MODEL,TRAN,MAJ:MIN,PKNAME";

export const LSBLK_ARGUMENTS: readonly string[] = ["--json", "--bytes", "--output", LSBLK_COLUMNS];

/**
 * Flatten `lsblk`'s nested tree into one row per block device.
 *
 * `--bytes` writes sizes as JSON numbers, which an IEEE 754 double can only
 * represent exactly below 2^53. A larger value is refused with a warning rather
 * than silently rounded, because every byte count Disktop reports is exact.
 */
export function parseLsblk(source: string): LsblkResult {
  const devices: BlockDevice[] = [];
  const warnings: Warning[] = [];

  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch {
    return {
      devices: [],
      warnings: [{ code: "lsblk-invalid-json", message: "lsblk did not produce readable JSON; no block topology is available." }],
    };
  }

  if (!isRecord(document) || !Array.isArray(document["blockdevices"])) {
    return {
      devices: [],
      warnings: [{ code: "lsblk-unexpected-shape", message: "lsblk JSON has no blockdevices array; no block topology is available." }],
    };
  }

  visit(document["blockdevices"], undefined, devices, warnings);
  return { devices, warnings };
}

function visit(rows: readonly unknown[], parentName: string | undefined, devices: BlockDevice[], warnings: Warning[]): void {
  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }

    const name = text(row["name"]);
    if (name === undefined) {
      warnings.push({ code: "lsblk-unnamed-device", message: "An lsblk row has no name and was skipped." });
      continue;
    }

    const size = exactBytes(row["size"]);
    if (size === undefined) {
      warnings.push({
        code: "lsblk-unreadable-size",
        message: `lsblk reported a size for ${name} that cannot be represented exactly; the device is omitted rather than rounded.`,
      });
    } else {
      const deviceNumber = splitDeviceNumber(text(row["maj:min"]));
      devices.push({
        name,
        kernelName: text(row["kname"]) ?? name,
        type: text(row["type"]) ?? "unknown",
        sizeBytes: size,
        rotational: tristateBoolean(row["rota"]),
        removable: tristateBoolean(row["rm"]) ?? false,
        model: text(row["model"]),
        transport: text(row["tran"]),
        major: deviceNumber?.major,
        minor: deviceNumber?.minor,
        parentName: text(row["pkname"]) ?? parentName,
        path: text(row["path"]),
      });
    }

    const children = row["children"];
    if (Array.isArray(children)) {
      visit(children, name, devices, warnings);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A text column, made safe to print where it is read.
 *
 * A device's model and transport come from the device itself, so a USB stick
 * can name itself with an escape sequence; `disktop devices` would otherwise
 * send it straight to the terminal. Every column is treated the same way, so
 * the names that join one row to another still match after sanitizing.
 */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? sanitizeText(value) : undefined;
}

/** lsblk has reported booleans as `true`, as `"1"`, and as `null` across releases. */
function tristateBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "1" || value === 1) {
    return true;
  }
  if (value === "0" || value === 0) {
    return false;
  }
  return undefined;
}

function exactBytes(value: unknown): bigint | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
  }
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    return BigInt(value);
  }
  return undefined;
}

function splitDeviceNumber(value: string | undefined): { major: number; minor: number } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.exec(value);
  return match === null ? undefined : { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * RAM-backed block devices. zram and ramdisks are `disk` to lsblk and are not
 * rotational, so without this they would be counted and shown as solid-state
 * storage the user could clean up. They hold no persistent bytes.
 */
export function isMemoryBackedDevice(device: BlockDevice): boolean {
  return /^(zram|ram)[0-9]+$/.test(device.kernelName);
}

/**
 * Rotation is a hint the kernel does not always have. When it is absent the
 * device kind is `unknown`; it is never guessed from a name or a transport.
 */
export function deviceKindOf(device: BlockDevice): "ssd" | "hdd" | "unknown" {
  if (device.rotational === undefined) {
    return "unknown";
  }
  return device.rotational ? "hdd" : "ssd";
}
