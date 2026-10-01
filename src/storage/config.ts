import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { isRefusedAsAllowedRoot } from "../domain/protected-paths.js";
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
    /** Byte budget for the helper's index; older scans are dropped to fit. */
    readonly maxIndexBytes: number;
    /** How many scans the index retains, newest first. */
    readonly keepScans: number;
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
  readonly providers: {
    /** Directories holding AppImages, which no package manager knows about. */
    readonly appImageRoots: readonly string[];
    /** Directory names that mark regenerable build output. Names, never paths. */
    readonly artifactDirectories: readonly string[];
    /** The size above which a log file is worth reporting on its own. */
    readonly largeLogBytes: number;
    /** The cap that keeps one noisy detector from flooding the list. */
    readonly maxFindingsPerProvider: number;
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
    maxIndexBytes: 2 * 1024 * 1024 * 1024,
    keepScans: 3,
  },
  find: { staleAfterDays: 183 },
  snapshots: { keepLatest: 20 },
  cleanup: { defaultOperation: "trash", planExpiryMinutes: 60, additionalAllowedRoots: [] },
  providers: {
    appImageRoots: [],
    artifactDirectories: ["node_modules", "target", "__pycache__", ".next", ".nuxt", "build", "dist"],
    largeLogBytes: 128 * 1024 * 1024,
    maxFindingsPerProvider: 50,
  },
};

const KNOWN_TABLES = new Set(["alerts", "scan", "find", "snapshots", "cleanup", "providers"]);

export function parseConfigDocument(source: string): DisktopConfig {
  const document = parseToml(source);
  const reader = new Reader(document);

  const config: DisktopConfig = {
    units: reader.enumeration("", "units", ["iec", "si"], DEFAULT_CONFIG.units),
    alerts: {
      spaceThresholdPercent: reader.integer("alerts", "space_threshold_percent", DEFAULT_CONFIG.alerts.spaceThresholdPercent, 0, 100),
      inodeThresholdPercent: reader.integer("alerts", "inode_threshold_percent", DEFAULT_CONFIG.alerts.inodeThresholdPercent, 0, 100),
      notify: reader.boolean("alerts", "notify", DEFAULT_CONFIG.alerts.notify),
    },
    scan: {
      crossFilesystems: reader.boolean("scan", "cross_filesystems", DEFAULT_CONFIG.scan.crossFilesystems),
      accounting: reader.enumeration("scan", "accounting", ["allocated", "apparent"], DEFAULT_CONFIG.scan.accounting),
      excludeWindowsMounts: reader.boolean("scan", "exclude_windows_mounts", DEFAULT_CONFIG.scan.excludeWindowsMounts),
      excludes: reader.absolutePaths("scan", "excludes", DEFAULT_CONFIG.scan.excludes, false),
      maxIndexBytes: reader.integer("scan", "max_index_bytes", DEFAULT_CONFIG.scan.maxIndexBytes, 16 * 1024 * 1024, 1024 ** 4),
      keepScans: reader.integer("scan", "keep_scans", DEFAULT_CONFIG.scan.keepScans, 1, 100),
    },
    find: { staleAfterDays: reader.integer("find", "stale_after_days", DEFAULT_CONFIG.find.staleAfterDays, 1, 3650) },
    snapshots: { keepLatest: reader.integer("snapshots", "keep_latest", DEFAULT_CONFIG.snapshots.keepLatest, 1, 1000) },
    cleanup: {
      defaultOperation: DEFAULT_CONFIG.cleanup.defaultOperation,
      planExpiryMinutes: reader.integer("cleanup", "plan_expiry_minutes", DEFAULT_CONFIG.cleanup.planExpiryMinutes, 1, 1440),
      additionalAllowedRoots: reader.absolutePaths(
        "cleanup",
        "additional_allowed_roots",
        DEFAULT_CONFIG.cleanup.additionalAllowedRoots,
        true,
      ),
    },
    providers: {
      // Discovery roots, never cleanup roots: what may be acted on is decided
      // by the finding, so a system directory is a legitimate place to look.
      appImageRoots: reader.absolutePaths("providers", "app_image_roots", DEFAULT_CONFIG.providers.appImageRoots, false),
      artifactDirectories: reader.names(
        "providers",
        "artifact_directories",
        DEFAULT_CONFIG.providers.artifactDirectories,
      ),
      largeLogBytes: reader.integer(
        "providers",
        "large_log_bytes",
        DEFAULT_CONFIG.providers.largeLogBytes,
        1024,
        1024 ** 4,
      ),
      maxFindingsPerProvider: reader.integer(
        "providers",
        "max_findings_per_provider",
        DEFAULT_CONFIG.providers.maxFindingsPerProvider,
        1,
        1000,
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

  /** Every integer setting is bounded, so a typo cannot disable a guard. */
  integer(table: string, key: string, fallback: number, minimum: number, maximum: number): number {
    const value = this.#take(table, key);
    if (value === undefined) {
      return fallback;
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw invalid(table, key, "expected an integer");
    }
    if (value < minimum || value > maximum) {
      throw invalid(table, key, `expected an integer between ${minimum} and ${maximum}`);
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
      if (refuseProtected && isRefusedAsAllowedRoot(path)) {
        throw invalid(
          table,
          key,
          `'${path}' is a protected system root or a shared container root and cannot be allowed for cleanup`,
        );
      }
    }
    return paths;
  }

  /**
   * Plain directory names, never paths.
   *
   * A detector matches these against the name of a directory a scan found. A
   * value with a slash in it would read as a path and invite somebody to point
   * a detector at `/etc`, so it is refused here rather than handled later.
   */
  names(table: string, key: string, fallback: readonly string[]): readonly string[] {
    const value = this.#take(table, key);
    if (value === undefined) {
      return fallback;
    }
    if (!Array.isArray(value) || value.some((element) => typeof element !== "string")) {
      throw invalid(table, key, "expected an array of quoted directory names");
    }
    const names = value as readonly string[];
    for (const name of names) {
      if (name === "" || name.includes("/") || name === "." || name === "..") {
        throw invalid(table, key, `'${name}' must be a plain directory name, not a path`);
      }
    }
    return names;
  }

  rejectUnread(): void {
    for (const [name, value] of Object.entries(this.#document)) {
      if (!isTable(value)) {
        if (!this.#read.has(`.${name}`)) {
          throw new RangeError(`config.toml: unknown setting '${name}'`);
        }
        continue;
      }
      if (!KNOWN_TABLES.has(name)) {
        throw new RangeError(`config.toml: unknown section '${name}'`);
      }
      for (const key of Object.keys(value)) {
        if (!this.#read.has(`${name}.${key}`)) {
          throw new RangeError(`config.toml: unknown setting '${name}.${key}'`);
        }
      }
    }
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

function isTable(value: TomlValue | TomlTable | undefined): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(table: string, key: string, message: string): RangeError {
  const name = table === "" ? key : `${table}.${key}`;
  return new RangeError(`config.toml: '${name}' ${message}`);
}

export interface LoadedConfig {
  readonly config: DisktopConfig;
  readonly source: "file" | "defaults";
  readonly problem?: string;
}

/**
 * Read `config.toml` when it exists.
 *
 * A missing file is normal and yields the defaults. A file that exists but
 * cannot be parsed is reported rather than ignored: silently falling back to
 * defaults would run with thresholds and excludes the user did not choose.
 */
export async function loadConfigFile(configFile: string): Promise<LoadedConfig> {
  let source: string;
  try {
    source = await readFile(configFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: DEFAULT_CONFIG, source: "defaults" };
    }
    return { config: DEFAULT_CONFIG, source: "defaults", problem: `${configFile} could not be read: ${describeError(error)}` };
  }

  try {
    return { config: parseConfigDocument(source), source: "file" };
  } catch (error) {
    return { config: DEFAULT_CONFIG, source: "defaults", problem: `${configFile} was not applied: ${describeError(error)}` };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
