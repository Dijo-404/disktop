import { posix } from "node:path";
import { PROTECTED_ROOTS } from "../domain/protected-paths.js";
import { parseToml, type TomlTable, type TomlValue } from "./toml.js";

export interface DisktopConfig {
  readonly units: "iec" | "si";
  readonly alerts: {
    readonly spaceThresholdPercent: number;
    readonly inodeThresholdPercent: number;
    readonly notify: boolean;
  };
  readonly scan: {
    readonly crossFilesystems: boolean;
    readonly accounting: "allocated" | "apparent";
    readonly excludeWindowsMounts: boolean;
    readonly excludes: readonly string[];
  };
  readonly find: {
    readonly staleAfterDays: number;
  };
  readonly snapshots: {
    readonly keepLatest: number;
  };
  readonly cleanup: {
    readonly defaultOperation: "trash";
    readonly planExpiryMinutes: number;
    readonly additionalAllowedRoots: readonly string[];
  };
}

export const DEFAULT_CONFIG: DisktopConfig = {
  units: "iec",
  alerts: { spaceThresholdPercent: 90, inodeThresholdPercent: 90, notify: false },
  scan: {
    crossFilesystems: false,
    accounting: "allocated",
    excludeWindowsMounts: true,
    excludes: ["/proc", "/sys", "/dev", "/run"],
  },
  find: { staleAfterDays: 183 },
  snapshots: { keepLatest: 20 },
  cleanup: { defaultOperation: "trash", planExpiryMinutes: 60, additionalAllowedRoots: [] },
};

export function parseConfigDocument(source: string): DisktopConfig {
  const document = parseToml(source);
  const reader = new Reader(document);

  const config: DisktopConfig = {
    units: reader.enumeration("", "units", ["iec", "si"], DEFAULT_CONFIG.units),
    alerts: {
      spaceThresholdPercent: reader.percent("alerts", "space_threshold_percent", DEFAULT_CONFIG.alerts.spaceThresholdPercent),
      inodeThresholdPercent: reader.percent("alerts", "inode_threshold_percent", DEFAULT_CONFIG.alerts.inodeThresholdPercent),
      notify: reader.boolean("alerts", "notify", DEFAULT_CONFIG.alerts.notify),
    },
    scan: {
      crossFilesystems: reader.boolean("scan", "cross_filesystems", DEFAULT_CONFIG.scan.crossFilesystems),
      accounting: reader.enumeration("scan", "accounting", ["allocated", "apparent"], DEFAULT_CONFIG.scan.accounting),
      excludeWindowsMounts: reader.boolean("scan", "exclude_windows_mounts", DEFAULT_CONFIG.scan.excludeWindowsMounts),
      excludes: reader.absolutePaths("scan", "excludes", DEFAULT_CONFIG.scan.excludes, false),
    },
    find: { staleAfterDays: reader.positiveInteger("find", "stale_after_days", DEFAULT_CONFIG.find.staleAfterDays) },
    snapshots: { keepLatest: reader.positiveInteger("snapshots", "keep_latest", DEFAULT_CONFIG.snapshots.keepLatest) },
    cleanup: {
      defaultOperation: DEFAULT_CONFIG.cleanup.defaultOperation,
      planExpiryMinutes: reader.positiveInteger("cleanup", "plan_expiry_minutes", DEFAULT_CONFIG.cleanup.planExpiryMinutes),
      additionalAllowedRoots: reader.absolutePaths(
        "cleanup",
        "additional_allowed_roots",
        DEFAULT_CONFIG.cleanup.additionalAllowedRoots,
        true,
      ),
    },
  };

  reader.rejectUnread();
  return config;
}

/** Tracks which keys were consumed so an unknown or misspelled key is an error. */
class Reader {
  readonly #document: TomlTable;
  readonly #read = new Set<string>();

  constructor(document: TomlTable) {
    this.#document = document;
  }

  boolean(table: string, key: string, fallback: boolean): boolean {
    const value = this.#take(table, key);
    if (value === undefined) {
      return fallback;
    }
    if (typeof value !== "boolean") {
      throw invalid(table, key, "expected true or false");
    }
    return value;
  }

  percent(table: string, key: string, fallback: number): number {
    const value = this.#integer(table, key, fallback);
    if (value < 0 || value > 100) {
      throw invalid(table, key, "expected an integer between 0 and 100");
    }
    return value;
  }

  positiveInteger(table: string, key: string, fallback: number): number {
    const value = this.#integer(table, key, fallback);
    if (value < 1) {
      throw invalid(table, key, "expected at least 1");
    }
    return value;
  }

  enumeration<T extends string>(table: string, key: string, allowed: readonly T[], fallback: T): T {
    const value = this.#take(table, key);
    if (value === undefined) {
      return fallback;
    }
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      throw invalid(table, key, `expected one of ${allowed.join(", ")}`);
    }
    return value as T;
  }

  absolutePaths(table: string, key: string, fallback: readonly string[], refuseProtected: boolean): readonly string[] {
    const value = this.#take(table, key);
    if (value === undefined) {
      return fallback;
    }
    if (!Array.isArray(value) || value.some((element) => typeof element !== "string")) {
      throw invalid(table, key, "expected an array of quoted paths");
    }
    const paths = value as readonly string[];
    for (const path of paths) {
      if (!posix.isAbsolute(path) || posix.normalize(path) !== path || (path !== "/" && path.endsWith("/"))) {
        throw invalid(table, key, `'${path}' must be an absolute, normalized path`);
      }
      if (refuseProtected && isProtected(path)) {
        throw invalid(table, key, `'${path}' is a protected system root and cannot be allowed for cleanup`);
      }
    }
    return paths;
  }

  rejectUnread(): void {
    for (const [name, value] of Object.entries(this.#document)) {
      if (isTable(value)) {
        for (const key of Object.keys(value)) {
          if (!this.#read.has(`${name}.${key}`)) {
            throw new RangeError(`config.toml: unknown setting '${name}.${key}'`);
          }
        }
      } else if (!this.#read.has(`.${name}`)) {
        throw new RangeError(`config.toml: unknown setting '${name}'`);
      }
    }
  }

  #integer(table: string, key: string, fallback: number): number {
    const value = this.#take(table, key);
    if (value === undefined) {
      return fallback;
    }
    if (typeof value !== "number") {
      throw invalid(table, key, "expected an integer");
    }
    return value;
  }

  #take(table: string, key: string): TomlValue | undefined {
    this.#read.add(`${table}.${key}`);
    if (table === "") {
      const value = this.#document[key];
      return isTable(value) ? undefined : value;
    }
    const section = this.#document[table];
    if (section === undefined) {
      return undefined;
    }
    if (!isTable(section)) {
      throw new RangeError(`config.toml: '${table}' must be a table`);
    }
    const value = section[key];
    return isTable(value) ? undefined : value;
  }
}

function isProtected(path: string): boolean {
  return PROTECTED_ROOTS.some((root) => path === root || (root !== "/" && path.startsWith(`${root}/`)));
}

function isTable(value: TomlValue | TomlTable | undefined): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(table: string, key: string, message: string): RangeError {
  const name = table === "" ? key : `${table}.${key}`;
  return new RangeError(`config.toml: '${name}' ${message}`);
}
