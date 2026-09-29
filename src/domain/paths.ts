import type { RawPath } from "./models.js";

const SLASH = 0x2f;
const DOT = 0x2e;
const DELETE_PICTURE = "␡";
const CONTROL_PICTURES = 0x2400;

/** Build the lossless path value used for every filesystem operation. */
export function rawPathFromBytes(bytes: Uint8Array): RawPath {
  const buffer = Buffer.from(bytes);
  const utf8 = decodeUtf8(buffer);
  const path: RawPath = {
    bytesBase64: buffer.toString("base64"),
    display: sanitizeForDisplay(bytes),
  };
  return utf8 === undefined ? path : { ...path, utf8 };
}

export function rawPathFromUtf8(value: string): RawPath {
  return rawPathFromBytes(Buffer.from(value, "utf8"));
}

export function pathBytes(path: RawPath): Uint8Array {
  const buffer = Buffer.from(path.bytesBase64, "base64");
  if (buffer.toString("base64") !== path.bytesBase64) {
    throw new RangeError("Path bytes are not canonical base64");
  }
  return new Uint8Array(buffer);
}

/**
 * Render bytes for terminals, HTML, CSV, and logs. C0 controls become their
 * Unicode Control Pictures, DEL becomes its picture, and every other character
 * that can command a terminal or reorder what follows it becomes `<U+XXXX>`.
 * Invalid UTF-8 becomes U+FFFD. Never resolve a target from this text.
 *
 * This makes the text safe to print; it does not make it unique. Distinct byte
 * sequences can still render the same, so an operation is identified by its
 * bytes and never by what the user reads.
 */
export function sanitizeForDisplay(bytes: Uint8Array): string {
  let display = "";
  for (const character of Buffer.from(bytes).toString("utf8")) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x7f) {
      display += DELETE_PICTURE;
    } else if (code < 0x20) {
      display += String.fromCodePoint(CONTROL_PICTURES + code);
    } else if (isDisplayUnsafe(code)) {
      display += `<U+${code.toString(16).toUpperCase().padStart(4, "0")}>`;
    } else {
      display += character;
    }
  }
  return display;
}

/**
 * C1 controls (U+009B is CSI and U+009D is OSC to a terminal reading UTF-8),
 * line and paragraph separators, and the bidirectional marks, embeddings,
 * overrides, and isolates that let one name render as another. Zero-width
 * joiners are left alone: they carry meaning inside real emoji sequences.
 */
function isDisplayUnsafe(code: number): boolean {
  return (
    (code >= 0x80 && code <= 0x9f) ||
    code === 0x061c ||
    (code >= 0x200e && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** Absolute, no empty segment, no `.` or `..`, no trailing slash except the root. */
export function isAbsoluteNormalized(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes[0] !== SLASH) {
    return false;
  }
  if (bytes.length === 1) {
    return true;
  }
  for (const segment of pathSegments(bytes)) {
    if (segment.length === 0) {
      return false;
    }
    if (segment[0] === DOT && (segment.length === 1 || (segment.length === 2 && segment[1] === DOT))) {
      return false;
    }
  }
  return true;
}

export function pathSegments(bytes: Uint8Array): Uint8Array[] {
  const segments: Uint8Array[] = [];
  let start = 1;
  for (let index = 1; index <= bytes.length; index += 1) {
    if (index === bytes.length || bytes[index] === SLASH) {
      segments.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  return segments;
}

/** True when `child` is `parent` or below it, compared segment by segment. */
export function isWithin(parent: Uint8Array, child: Uint8Array): boolean {
  if (child.length < parent.length) {
    return false;
  }
  for (let index = 0; index < parent.length; index += 1) {
    if (parent[index] !== child[index]) {
      return false;
    }
  }
  return (
    child.length === parent.length ||
    parent[parent.length - 1] === SLASH ||
    child[parent.length] === SLASH
  );
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function decodeUtf8(buffer: Buffer): string | undefined {
  const decoded = buffer.toString("utf8");
  return Buffer.from(decoded, "utf8").equals(buffer) ? decoded : undefined;
}
