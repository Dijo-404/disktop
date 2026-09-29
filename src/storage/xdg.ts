import { posix } from "node:path";

export interface DisktopLocations {
  readonly configDirectory: string;
  readonly configFile: string;
  readonly dataDirectory: string;
  readonly cacheDirectory: string;
  readonly stateDirectory: string;
}

/** Directories Disktop creates for itself are private to the user. */
export const PRIVATE_DIRECTORY_MODE = 0o700;

/**
 * Resolve the XDG locations without touching the filesystem. A relative XDG
 * value is ignored, as the specification requires.
 */
export function resolveLocations(
  environment: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
): DisktopLocations {
  if (!posix.isAbsolute(homeDirectory)) {
    throw new RangeError("Disktop needs an absolute home directory to place its files");
  }

  const base = (variable: string, fallback: string): string => {
    const value = environment[variable];
    return value !== undefined && posix.isAbsolute(value)
      ? posix.join(value, "disktop")
      : posix.join(homeDirectory, fallback, "disktop");
  };

  const configDirectory = base("XDG_CONFIG_HOME", ".config");
  return {
    configDirectory,
    configFile: posix.join(configDirectory, "config.toml"),
    dataDirectory: base("XDG_DATA_HOME", ".local/share"),
    cacheDirectory: base("XDG_CACHE_HOME", ".cache"),
    stateDirectory: base("XDG_STATE_HOME", ".local/state"),
  };
}
