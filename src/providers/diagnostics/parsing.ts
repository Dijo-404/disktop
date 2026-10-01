/**
 * Parsers for the diagnostic tools' output.
 *
 * Each one is total. `lsof` and `smartctl` change their output between
 * versions and between devices, and a parser that threw on an unfamiliar line
 * would take a whole discovery run with it.
 */

/**
 * Roots whose entries are not files on a filesystem.
 *
 * `lsof +L1` reports memfds, shared memory, and anonymous inodes alongside
 * real unlinked files. Adding their sizes into a total would tell somebody
 * that restarting a process returns gigabytes of disk, when those bytes were
 * never on a disk at all.
 */
const PSEUDO_PREFIXES: readonly string[] = [
  "/memfd:",
  "/dev/shm/",
  "/dev/zero",
  "/drm mm object",
  "/[",
  "anon_inode:",
  "/proc/",
  "/sys/",
  "/run/user/",
  "socket:",
  "pipe:",
];

/** Whether a name lsof printed is a path on a filesystem at all. */
export function isFilesystemPath(path: string): boolean {
  if (!path.startsWith("/")) {
    return false;
  }
  return !PSEUDO_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export interface OpenDeletedFile {
  readonly command: string;
  readonly processId: string;
  readonly path: string;
  readonly bytes?: bigint;
}

/**
 * `lsof +L1 -F pcnsk`: one field per line, keyed by its first character.
 *
 * The field format is used rather than the table, because a path containing a
 * space breaks a column split and a path is exactly what this reports.
 *
 * `k` is the link count. `L` is the process login name, which lsof prints once
 * per process; keying on it would make the first file of every process look as
 * though it still had links.
 */
export function parseOpenDeleted(text: string): readonly OpenDeletedFile[] {
  const files: OpenDeletedFile[] = [];
  let command = "";
  let processId = "";
  let size: bigint | undefined;
  let links: string | undefined;

  for (const line of text.split("\n")) {
    const kind = line[0];
    const value = line.slice(1);
    if (kind === "p") {
      processId = value;
      command = "";
      continue;
    }
    if (kind === "c") {
      command = value;
      continue;
    }
    if (kind === "s") {
      size = /^[0-9]+$/.test(value) ? BigInt(value) : undefined;
      continue;
    }
    if (kind === "k") {
      links = value;
      continue;
    }
    if (kind !== "n") {
      continue;
    }
    // A name line closes a file record. `+L1` already filters to unlinked
    // files, but the link count is checked again so a build that ignores the
    // flag cannot turn every open file into a finding.
    const unlinked = links === undefined || links === "0";
    if (value !== "" && unlinked && isFilesystemPath(stripDeleted(value))) {
      files.push({
        command,
        processId,
        path: stripDeleted(value),
        ...(size === undefined ? {} : { bytes: size }),
      });
    }
    size = undefined;
    links = undefined;
  }
  return files;
}

function stripDeleted(value: string): string {
  return value.replace(/\s*\(deleted\)\s*$/, "");
}

export interface SmartDevice {
  readonly name: string;
  readonly type?: string;
}

/** `smartctl --scan -j`. */
export function parseSmartScan(text: string): readonly SmartDevice[] {
  const document = parseJson(text);
  const devices = isRecord(document) ? document["devices"] : undefined;
  if (!Array.isArray(devices)) {
    return [];
  }
  const found: SmartDevice[] = [];
  for (const device of devices) {
    if (!isRecord(device) || typeof device["name"] !== "string") {
      continue;
    }
    const type = device["type"];
    found.push({ name: device["name"], ...(typeof type === "string" ? { type } : {}) });
  }
  return found;
}

export interface SmartHealth {
  readonly passed?: boolean;
  readonly model?: string;
  readonly reallocatedSectors?: bigint;
  readonly powerOnHours?: bigint;
  readonly percentageUsed?: bigint;
}

/** `smartctl -H -A -j DEVICE`, for both ATA and NVMe shapes. */
export function parseSmartHealth(text: string): SmartHealth | undefined {
  const document = parseJson(text);
  if (!isRecord(document)) {
    return undefined;
  }

  const status = document["smart_status"];
  const passed = isRecord(status) && typeof status["passed"] === "boolean" ? status["passed"] : undefined;
  const model = typeof document["model_name"] === "string" ? document["model_name"] : undefined;

  const nvme = document["nvme_smart_health_information_log"];
  const powerOnHours = isRecord(nvme) ? wholeNumber(nvme["power_on_hours"]) : undefined;
  const percentageUsed = isRecord(nvme) ? wholeNumber(nvme["percentage_used"]) : undefined;

  let reallocated: bigint | undefined;
  const table = document["ata_smart_attributes"];
  const rows = isRecord(table) ? table["table"] : undefined;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!isRecord(row) || row["id"] !== 5) {
        continue;
      }
      const raw = row["raw"];
      reallocated = isRecord(raw) ? wholeNumber(raw["value"]) : undefined;
    }
  }

  const health: SmartHealth = {
    ...(passed === undefined ? {} : { passed }),
    ...(model === undefined ? {} : { model }),
    ...(reallocated === undefined ? {} : { reallocatedSectors: reallocated }),
    ...(powerOnHours === undefined ? {} : { powerOnHours }),
    ...(percentageUsed === undefined ? {} : { percentageUsed }),
  };
  return Object.keys(health).length === 0 ? undefined : health;
}

/**
 * `journalctl --disk-usage`: one sentence with a size in it.
 *
 * The trailing `B` is optional because journalctl prints `1.2G`, while other
 * builds and locales print `1.2GB` or `4.0GiB`.
 */
export function parseJournalUsage(text: string): bigint | undefined {
  const match = /([0-9]+(?:[.,][0-9]+)?)\s*([KMGTP]?)(i?)B?\b/i.exec(text);
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

function wholeNumber(value: unknown): bigint | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return BigInt(value);
  }
  return undefined;
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

export interface SmartMessages {
  readonly denied: boolean;
  readonly message?: string;
}

/**
 * smartctl's own report of how it got on.
 *
 * It exits non-zero and writes nothing to stderr when it cannot open a device,
 * putting the reason in the JSON document instead. Without reading that, a
 * permission problem looks like a tool that is simply not working.
 */
export function parseSmartMessages(text: string): SmartMessages {
  const document = parseJson(text);
  const smartctl = isRecord(document) ? document["smartctl"] : undefined;
  const messages = isRecord(smartctl) ? smartctl["messages"] : undefined;
  if (!Array.isArray(messages)) {
    return { denied: false };
  }
  const strings = messages
    .map((entry) => (isRecord(entry) && typeof entry["string"] === "string" ? entry["string"] : undefined))
    .filter((entry): entry is string => entry !== undefined);
  const first = strings[0];
  return {
    denied: strings.some((entry) => /permission denied|not permitted|operation not permitted/i.test(entry)),
    ...(first === undefined ? {} : { message: first }),
  };
}
