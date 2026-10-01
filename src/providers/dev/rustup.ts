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

const ID = "dev.rustup";
const VERSION = 1;

/** Enough of settings.toml to read one key; the file is small and simple. */
const SETTINGS_BYTES = 8192;

/**
 * The Rust toolchains rustup installed, and the downloads it kept.
 *
 * A toolchain carries its own standard library and every component added to
 * it, so the one named by `settings.toml` is marked in use: removing it breaks
 * `cargo` for every project that does not pin its own.
 */
export function createRustupProvider(): FindingProvider {
  return {
    id: ID,
    version: VERSION,
    categories: ["dev-environment"],

    async probe(environment) {
      const root = underHome(environment, ".rustup");
      return (await exists(environment, root))
        ? { status: "available", explanation: "A rustup directory exists." }
        : rootsCapability([], "rustup installations");
    },

    async discover(environment) {
      const settings = await environment.paths.readText(underHome(environment, ".rustup", "settings.toml"), SETTINGS_BYTES);
      const selected = defaultToolchain(settings);
      const findings: Finding[] = [];

      for (const toolchain of await childDirectories(environment, underHome(environment, ".rustup", "toolchains"))) {
        const name = basename(toolchain);
        const active = selected !== undefined && name === selected;
        findings.push(
          buildFinding({
            providerId: ID,
            providerVersion: VERSION,
            category: "dev-environment",
            slug: slugForPath(toolchain),
            title: `Rust toolchain ${name}`,
            evidence: [
              "A toolchain carries its own standard library and every component added to it.",
              active
                ? "settings.toml names it as the default, so cargo would stop working without it."
                : "settings.toml does not name it as the default.",
            ],
            paths: [toolchain],
            active,
            actions: active ? [] : ["manager"],
            regenerationCost: "rustup toolchain install downloads it again, with its components.",
          }),
        );
      }

      for (const [name, title, note] of [
        ["downloads", "rustup download cache", "Installer archives kept after a toolchain was unpacked."],
        ["tmp", "rustup temporary directory", "Working files left behind by an install."],
      ] as const) {
        const path = underHome(environment, ".rustup", name);
        if (await exists(environment, path)) {
          findings.push(
            buildFinding({
              providerId: ID,
              providerVersion: VERSION,
              category: "dev-environment",
              slug: slugForPath(path),
              title,
              evidence: [note],
              paths: [path],
              actions: ["trash"],
              regenerationCost: "Re-downloaded on the next toolchain install.",
            }),
          );
        }
      }

      return { findings, warnings: [], complete: true };
    },
  };
}

/** `default_toolchain = "stable-x86_64-unknown-linux-gnu"`, and nothing else. */
function defaultToolchain(settings: string | undefined): string | undefined {
  if (settings === undefined) {
    return undefined;
  }
  const match = /^\s*default_toolchain\s*=\s*"([^"\n]+)"\s*$/m.exec(settings);
  return match?.[1];
}
