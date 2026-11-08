/** A minimal reader for the gzip ustar files `npm pack` writes. */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

/** Every entry of the tarball at `path`: regular files, with PAX headers for long names. */
export function readTarball(path) {
  const bytes = gunzipSync(readFileSync(path));
  const entries = [];
  let pending = {};
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const data = bytes.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === "x" || type === "g") {
      for (const record of data.toString("utf8").split("\n").filter(Boolean)) {
        const [, key, value] = /^\d+ ([^=]+)=(.*)$/s.exec(record) ?? [];
        if (type === "x" && key === "path") pending.path = value;
      }
      continue;
    }
    const prefix = field(345, 155);
    const name = pending.path ?? (prefix === "" ? field(0, 100) : `${prefix}/${field(0, 100)}`);
    entries.push({ name, type, mode: Number.parseInt(field(100, 8).trim(), 8) & 0o7777, size, data: Buffer.from(data) });
    pending = {};
  }
  return entries;
}
