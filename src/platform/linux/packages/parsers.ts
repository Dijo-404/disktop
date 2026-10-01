/**
 * Parsers for what each package manager prints.
 *
 * Every one of these is total: a line it does not understand is skipped, and a
 * size it cannot read is absent rather than zero. A package manager's output
 * changes between releases, and a parser that threw would take a whole
 * discovery run down with it; one that invented a zero would report an
 * installed kernel as occupying nothing.
 */

import type { InstalledPackage } from "../../../ports/packages.js";

export type { InstalledPackage };

/** `dpkg-query -W -f=${Package}\t${Installed-Size}\t${Status}\n`. */
export function parseDpkg(text: string): readonly InstalledPackage[] {
  const packages: InstalledPackage[] = [];
  for (const line of lines(text)) {
    const columns = line.split("\t");
    if (columns.length < 3) {
      continue;
    }
    const [name, size, status] = columns as [string, string, string];
    // `deinstall ok config-files` is a package that is gone but left settings.
    if (name === "" || !status.startsWith("install ok")) {
      continue;
    }
    const kibibytes = wholeNumber(size);
    packages.push({
      name,
      ...(kibibytes === undefined ? {} : { reportedBytes: kibibytes * 1024n }),
    });
  }
  return packages;
}

/** `rpm -qa --qf %{NAME}\t%{SIZE}\n`, where SIZE is already bytes. */
export function parseRpm(text: string): readonly InstalledPackage[] {
  const packages: InstalledPackage[] = [];
  for (const line of lines(text)) {
    const [name, size] = line.split("\t");
    if (name === undefined || name === "") {
      continue;
    }
    const bytes = size === undefined ? undefined : wholeNumber(size);
    packages.push({ name, ...(bytes === undefined ? {} : { reportedBytes: bytes }) });
  }
  return packages;
}

/** `pacman -Qi`: blocks of `Key : Value` separated by blank lines. */
export function parsePacman(text: string): readonly InstalledPackage[] {
  const packages: InstalledPackage[] = [];
  let name: string | undefined;
  let version: string | undefined;
  let size: bigint | undefined;

  const flush = (): void => {
    if (name !== undefined) {
      packages.push({
        name,
        ...(version === undefined ? {} : { version }),
        ...(size === undefined ? {} : { reportedBytes: size }),
      });
    }
    name = undefined;
    version = undefined;
    size = undefined;
  };

  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "Name" && value !== "") {
      flush();
      name = value;
    } else if (key === "Version") {
      version = value;
    } else if (key === "Installed Size") {
      size = humanSize(value);
    }
  }
  flush();
  return packages;
}

/** `snap list`: a fixed-width table whose first row is a header. */
export function parseSnap(text: string): readonly InstalledPackage[] {
  const packages: InstalledPackage[] = [];
  for (const line of lines(text).slice(1)) {
    const columns = line.trim().split(/\s+/);
    const [name, version] = columns as [string | undefined, string | undefined];
    if (name === undefined || name === "" || columns.length < 2) {
      continue;
    }
    packages.push({ name, ...(version === undefined ? {} : { version }) });
  }
  return packages;
}

/** `flatpak list --columns=application,size,origin`, tab separated. */
export function parseFlatpak(text: string): readonly InstalledPackage[] {
  const packages: InstalledPackage[] = [];
  for (const line of lines(text)) {
    const columns = line.split("\t");
    if (columns.length < 2) {
      continue;
    }
    const [name, size] = columns as [string, string];
    if (name === "") {
      continue;
    }
    const bytes = humanSize(size);
    packages.push({ name, ...(bytes === undefined ? {} : { reportedBytes: bytes }) });
  }
  return packages;
}

/** `npm ls -g --depth=0 --json`. */
export function parseNpmGlobal(text: string): readonly InstalledPackage[] {
  const document = parseJson(text);
  const dependencies = isRecord(document) ? document["dependencies"] : undefined;
  if (!isRecord(dependencies)) {
    return [];
  }
  return Object.entries(dependencies).map(([name, value]) => {
    const version = isRecord(value) ? value["version"] : undefined;
    return { name, ...(typeof version === "string" ? { version } : {}) };
  });
}

/** `pip list --format=json`. */
export function parsePip(text: string): readonly InstalledPackage[] {
  const document = parseJson(text);
  if (!Array.isArray(document)) {
    return [];
  }
  const packages: InstalledPackage[] = [];
  for (const entry of document) {
    if (!isRecord(entry) || typeof entry["name"] !== "string") {
      continue;
    }
    const version = entry["version"];
    packages.push({ name: entry["name"], ...(typeof version === "string" ? { version } : {}) });
  }
  return packages;
}

function lines(text: string): readonly string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

function wholeNumber(value: string): bigint | undefined {
  const trimmed = value.trim();
  return /^[0-9]+$/.test(trimmed) ? BigInt(trimmed) : undefined;
}

/**
 * `8.52 MiB`, `1.2 GB`, `612.4 MB`.
 *
 * IEC suffixes are powers of 1024 and SI suffixes powers of 1000, which is
 * what each manager means by them. The result is rounded to whole bytes, and a
 * value that is not a size at all is absent.
 */
function humanSize(value: string): bigint | undefined {
  const match = /^([0-9]+(?:[.,][0-9]+)?)\s*([KMGTP]?)(i?)B?$/i.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  const amount = Number((match[1] as string).replace(",", "."));
  if (!Number.isFinite(amount)) {
    return undefined;
  }
  const prefix = (match[2] as string).toUpperCase();
  const base = (match[3] as string).toLowerCase() === "i" ? 1024 : 1000;
  const exponent = prefix === "" ? 0 : "KMGTP".indexOf(prefix) + 1;
  return BigInt(Math.round(amount * base ** exponent));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
