import type { RawPath, Warning } from "../../../domain/models.js";
import { rawPathFromBytes, sanitizeText } from "../../../domain/paths.js";

/** One line of `/proc/self/mountinfo`, kept as bytes because a mount point is bytes. */
export interface MountEntry {
  readonly mountId: number;
  readonly parentId: number;
  readonly major: number;
  readonly minor: number;
  readonly root: RawPath;
  readonly mountPoint: RawPath;
  readonly options: readonly string[];
  readonly optionalFields: readonly string[];
  readonly filesystemType: string;
  readonly source: RawPath;
  readonly superOptions: readonly string[];
}

export interface MountinfoResult {
  readonly mounts: readonly MountEntry[];
  readonly warnings: readonly Warning[];
}

const NEWLINE = 0x0a;
const SPACE = 0x20;
const BACKSLASH = 0x5c;
const HYPHEN = 0x2d;

/**
 * Parse `/proc/self/mountinfo` from raw bytes.
 *
 * The kernel writes mount points and sources with `\040`, `\011`, `\012`, and
 * `\134` escaped, so a field never contains a literal space and splitting on
 * space is exact. Decoding those escapes is what makes a mount point under a
 * directory named with a newline addressable at all.
 */
export function parseMountinfo(bytes: Uint8Array): MountinfoResult {
  const mounts: MountEntry[] = [];
  const warnings: Warning[] = [];

  for (const [index, line] of splitLines(bytes).entries()) {
    const fields = splitFields(line);
    const separator = fields.findIndex((field) => isSeparator(field));

    if (separator < 6 || fields.length - separator < 4) {
      warnings.push({
        code: "mountinfo-malformed-line",
        message: `Line ${index + 1} of /proc/self/mountinfo has no recognizable field layout and was skipped.`,
      });
      continue;
    }

    const entry = parseFields(fields, separator);
    if (entry === undefined) {
      warnings.push({
        code: "mountinfo-unparsable-identity",
        message: `Line ${index + 1} of /proc/self/mountinfo has an unreadable mount or device ID and was skipped.`,
      });
      continue;
    }
    mounts.push(entry);
  }

  return { mounts, warnings };
}

function parseFields(fields: readonly Uint8Array[], separator: number): MountEntry | undefined {
  const mountId = parseDecimal(fields[0]);
  const parentId = parseDecimal(fields[1]);
  const deviceNumber = parseDeviceNumber(fields[2]);
  const root = fields[3];
  const mountPoint = fields[4];
  const options = fields[5];
  const filesystemType = fields[separator + 1];
  const source = fields[separator + 2];
  const superOptions = fields[separator + 3];

  if (
    mountId === undefined ||
    parentId === undefined ||
    deviceNumber === undefined ||
    root === undefined ||
    mountPoint === undefined ||
    options === undefined ||
    filesystemType === undefined ||
    source === undefined ||
    superOptions === undefined
  ) {
    return undefined;
  }

  return {
    mountId,
    parentId,
    major: deviceNumber.major,
    minor: deviceNumber.minor,
    root: rawPathFromBytes(unescapeOctal(root)),
    mountPoint: rawPathFromBytes(unescapeOctal(mountPoint)),
    options: commaList(options),
    optionalFields: fields.slice(6, separator).map((field) => decodeField(field)),
    // Any user who can mount FUSE chooses the subtype in `fuse.<subtype>`, and
    // the kernel escapes only whitespace and backslashes in it. The type is
    // printed in every user's dashboard, so it is made safe to print here.
    filesystemType: sanitizeText(decodeField(unescapeOctal(filesystemType))),
    source: rawPathFromBytes(unescapeOctal(source)),
    superOptions: commaList(superOptions),
  };
}

function splitLines(bytes: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index === bytes.length || bytes[index] === NEWLINE) {
      if (index > start) {
        lines.push(bytes.subarray(start, index));
      }
      start = index + 1;
    }
  }
  return lines;
}

function splitFields(line: Uint8Array): Uint8Array[] {
  const fields: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index <= line.length; index += 1) {
    if (index === line.length || line[index] === SPACE) {
      if (index > start) {
        fields.push(line.subarray(start, index));
      }
      start = index + 1;
    }
  }
  return fields;
}

function isSeparator(field: Uint8Array): boolean {
  return field.length === 1 && field[0] === HYPHEN;
}

/** `\040` style escapes only; a lone backslash is kept as itself. */
function unescapeOctal(field: Uint8Array): Uint8Array {
  if (!field.includes(BACKSLASH)) {
    return field;
  }
  const out: number[] = [];
  for (let index = 0; index < field.length; index += 1) {
    const byte = field[index] as number;
    if (byte === BACKSLASH && index + 3 < field.length) {
      const digits = [field[index + 1], field[index + 2], field[index + 3]];
      if (digits.every((digit) => digit !== undefined && digit >= 0x30 && digit <= 0x37)) {
        out.push((((digits[0] as number) - 0x30) << 6) | (((digits[1] as number) - 0x30) << 3) | ((digits[2] as number) - 0x30));
        index += 3;
        continue;
      }
    }
    out.push(byte);
  }
  return Uint8Array.from(out);
}

function decodeField(field: Uint8Array): string {
  return Buffer.from(field).toString("utf8");
}

function commaList(field: Uint8Array): string[] {
  const value = decodeField(field);
  return value === "" ? [] : value.split(",");
}

function parseDecimal(field: Uint8Array | undefined): number | undefined {
  if (field === undefined) {
    return undefined;
  }
  const value = decodeField(field);
  return /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : undefined;
}

function parseDeviceNumber(field: Uint8Array | undefined): { major: number; minor: number } | undefined {
  if (field === undefined) {
    return undefined;
  }
  const match = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.exec(decodeField(field));
  if (match === null) {
    return undefined;
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** The kernel's own identity for a mounted filesystem, shared by its bind mounts. */
export function filesystemIdOf(entry: Pick<MountEntry, "major" | "minor">): string {
  return `fs-${entry.major}-${entry.minor}`;
}
