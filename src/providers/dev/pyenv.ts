import type { Finding } from "../../domain/findings.js";
import type { FindingProvider } from "../../ports/providers.js";
import {
  basename,
  buildFinding,
  childDirectories,
  exists,
  rootsCapability,
  slugForPath,
  underHome,
} from "../support.js";

const ID = "dev.pyenv";
const VERSION = 1;

/**
 * The Python interpreters pyenv built.
 *
 * Each one is a compiled toolchain, not a cache: rebuilding costs a long
 * compile and the matching build dependencies. The version named in
 * `~/.pyenv/version` is the global default and is marked in use.
 */
export function createPyenvProvider(): FindingProvider {
  return {
    id: ID,
    version: VERSION,
    categories: ["dev-environment"],

    async probe(environment) {
      const root = underHome(environment, ".pyenv", "versions");
      return (await exists(environment, root))
        ? { status: "available", explanation: "A pyenv versions directory exists." }
        : rootsCapability([], "pyenv installations");
    },

    async discover(environment) {
      const root = underHome(environment, ".pyenv", "versions");
      const selected = (await environment.paths.readText(underHome(environment, ".pyenv", "version"), 256))
        ?.trim()
        .split("\n")[0];

      const findings: Finding[] = [];
      for (const version of await childDirectories(environment, root)) {
        const name = basename(version);
        const active = name === selected;
        findings.push(
          buildFinding({
            providerId: ID,
            providerVersion: VERSION,
            category: "dev-environment",
            slug: slugForPath(version),
            title: `Python ${name} built by pyenv`,
            evidence: [
              "A compiled interpreter, not a cache: rebuilding it is a full compile.",
              active
                ? "~/.pyenv/version names it, so it is the global default."
                : "Nothing in pyenv's configuration names it as the default.",
            ],
            paths: [version],
            active,
            actions: active ? [] : ["trash"],
            regenerationCost: "pyenv install rebuilds it, which takes minutes and the build dependencies.",
          }),
        );
      }

      // The build cache pyenv keeps between installs.
      const cache = underHome(environment, ".pyenv", "cache");
      if (await exists(environment, cache)) {
        findings.push(
          buildFinding({
            providerId: ID,
            providerVersion: VERSION,
            category: "dev-environment",
            slug: slugForPath(cache),
            title: "pyenv source cache",
            evidence: ["Downloaded interpreter sources kept so a reinstall skips the download."],
            paths: [cache],
            actions: ["trash"],
            regenerationCost: "Re-downloaded on the next install.",
          }),
        );
      }

      return { findings, warnings: [], complete: true };
    },
  };
}
