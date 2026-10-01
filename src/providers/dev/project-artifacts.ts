import type { Finding, FindingConfidence } from "../../domain/findings.js";
import type { RawPath } from "../../domain/models.js";
import type { DiscoveryEnvironment, FindingProvider } from "../../ports/providers.js";
import {
  basename,
  buildFinding,
  exists,
  joinPath,
  noStoredScan,
  parentOf,
  slugForPath,
} from "../support.js";

const ID = "dev.project-artifacts";
const VERSION = 1;

/**
 * What proves a directory is build output rather than a directory with a
 * common name, and what rebuilding it costs.
 */
const EVIDENCE: Readonly<Record<string, { readonly sibling?: string; readonly rebuild: string }>> = {
  node_modules: { sibling: "package.json", rebuild: "Reinstalled by npm, yarn, or pnpm, which needs the network." },
  target: { sibling: "Cargo.toml", rebuild: "Rebuilt by cargo, which recompiles every dependency." },
  __pycache__: { rebuild: "Rewritten by the interpreter the next time the module is imported." },
  ".next": { sibling: "package.json", rebuild: "Rebuilt by the next build step." },
  ".nuxt": { sibling: "package.json", rebuild: "Rebuilt by the next build step." },
  build: { rebuild: "Rebuilt by whatever produced it." },
  dist: { rebuild: "Rebuilt by whatever produced it." },
};

/**
 * Build output scattered through a person's projects.
 *
 * These directories are found through a stored scan rather than by walking:
 * traversal belongs to the helper, and a detector that walked every project
 * would be a second scan with no index to show for it. When no scan covers the
 * home directory, the result says the projects were not looked at — which is
 * not the same as saying there is no build output.
 *
 * A name alone is weak evidence. `target` beside a `Cargo.toml` is a Rust
 * build directory; `target` on its own is a directory called target, and is
 * reported as uncertain so nobody deletes a design asset folder.
 */
export function createProjectArtifactsProvider(): FindingProvider {
  return {
    id: ID,
    version: VERSION,
    categories: ["project-artifact"],

    async probe() {
      return { status: "available", explanation: "Build output is read from the stored scan index." };
    },

    async discover(environment) {
      const names = environment.artifactDirectories;
      const search = await environment.index.directoriesNamed(names, environment.maxFindingsPerProvider);
      if (!search.searched) {
        return { findings: [], warnings: [noStoredScan("build output inside projects")], complete: false };
      }

      const findings: Finding[] = [];
      for (const path of search.paths) {
        findings.push(await artifactFinding(environment, path));
      }
      return { findings, warnings: [], complete: true };
    },
  };
}

async function artifactFinding(environment: DiscoveryEnvironment, path: RawPath): Promise<Finding> {
  const name = basename(path);
  const rule = EVIDENCE[name] ?? { rebuild: "Rebuilt by whatever produced it." };
  const project = parentOf(path);

  let confidence: FindingConfidence = "likely";
  const evidence = [`${name} under ${project.display}.`];
  if (rule.sibling !== undefined) {
    const proof = await exists(environment, joinPath(project, rule.sibling));
    confidence = proof ? "likely" : "uncertain";
    evidence.push(
      proof
        ? `A ${rule.sibling} beside it shows what builds it.`
        : `No ${rule.sibling} beside it, so the name is the only evidence that this is build output.`,
    );
  }

  return buildFinding({
    providerId: ID,
    providerVersion: VERSION,
    category: "project-artifact",
    slug: slugForPath(path),
    title: `${name} in ${basename(project)}`,
    evidence,
    paths: [path],
    confidence,
    actions: ["trash"],
    regenerationCost: rule.rebuild,
  });
}
