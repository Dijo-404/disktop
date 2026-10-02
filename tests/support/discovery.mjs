/**
 * A discovery environment backed by a real fixture tree.
 *
 * Providers are driven through the same ports the composition root builds, so
 * a test exercises the real path probe against a throwaway directory rather
 * than a mock of the filesystem.
 */
import { createPathProbe } from "../../dist/platform/linux/probe.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";

export function discoveryEnvironment(home, overrides = {}) {
  const recorded = { tools: [] };
  const environment = {
    home: rawPathFromUtf8(home),
    variables: overrides.variables ?? {},
    userId: 1000n,
    now: overrides.now ?? new Date("2026-10-01T00:00:00.000Z"),
    staleAfterDays: 183,
    rules: [],
    appImageRoots: overrides.appImageRoots ?? [],
    artifactDirectories: overrides.artifactDirectories ?? [
      "node_modules",
      "target",
      "__pycache__",
      ".next",
      ".nuxt",
      "build",
      "dist",
    ],
    largeLogBytes: overrides.largeLogBytes ?? 134_217_728n,
    maxFindingsPerProvider: overrides.maxFindingsPerProvider ?? 50,
    paths: overrides.paths ?? createPathProbe(),
    tools: {
      async run(name, commandArguments) {
        recorded.tools.push([name, [...commandArguments]]);
        const reply = overrides.tools?.[name];
        if (reply === undefined) {
          return {
            capability: { status: "missing-tool", explanation: `${name} is not installed.` },
            stdout: "",
            stderr: "",
            exitCode: null,
          };
        }
        return {
          capability: reply.capability ?? { status: "available", explanation: `${name} responded.` },
          stdout: reply.stdout ?? "",
          stderr: reply.stderr ?? "",
          exitCode: reply.exitCode ?? 0,
        };
      },
    },
    index: overrides.index ?? { async directoriesNamed() { return { paths: [], searched: false }; } },
  };
  environment.recorded = recorded;
  return environment;
}

/** Index search answering with fixed paths, as a stored scan of home would. */
export function storedScan(paths) {
  return {
    async directoriesNamed(names, limit) {
      const found = paths
        .filter((path) => names.some((name) => path.endsWith(`/${name}`)))
        .slice(0, limit)
        .map(rawPathFromUtf8);
      return { paths: found, searched: true };
    },
  };
}

export async function discover(provider, environment) {
  const capability = await provider.probe(environment);
  if (capability.status !== "available") {
    return { capability, findings: [], warnings: [], complete: true };
  }
  const result = await provider.discover(environment, new AbortController().signal);
  return { capability, ...result };
}

export function byId(findings) {
  return new Map(findings.map((finding) => [finding.id, finding]));
}

export function displays(findings) {
  return findings.flatMap((finding) => finding.paths.map((path) => path.display));
}
