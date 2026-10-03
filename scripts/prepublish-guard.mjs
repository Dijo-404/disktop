/**
 * `prepublishOnly`: refuse `npm publish` anywhere but the reviewed workflow.
 *
 * Disktop has one public release, published by `.github/workflows/publish.yml`
 * from a reviewed tag on the default branch. A plain `npm publish` from a
 * checkout runs this first and stops.
 *
 * It is a seatbelt, not the control. Environment variables can be set by
 * anyone and `--ignore-scripts` skips lifecycle scripts entirely; what keeps a
 * release safe is that the only token able to publish lives in the protected
 * `npm-publish` environment. The workflow publishes the exact tarball it
 * tested with `npm publish <tarball> --ignore-scripts`, and npm runs no
 * lifecycle scripts for a tarball in any case, so this never runs on its own
 * there: the workflow runs it as an explicit step instead, where it checks
 * that the publish step is running where and how the release says it must.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WORKFLOW = ".github/workflows/publish.yml";
const BRANCH = "refs/heads/main";

/** `git+https://github.com/<owner>/<name>.git` to `<owner>/<name>`. */
export function repositorySlug(manifest) {
  const match = /^git\+https:\/\/github\.com\/([^/]+\/[^/]+?)\.git$/.exec(manifest.repository?.url ?? "");
  return match?.[1];
}

/** Why this publish must not happen, or `undefined` if it is the reviewed one. */
export function publishRefusal(environment, manifest) {
  const slug = repositorySlug(manifest);
  if (slug === undefined) {
    return "package.json has no GitHub repository URL to check the workflow against.";
  }
  if (manifest.private !== false || typeof manifest.version !== "string") {
    return "package.json is not a public package with a version.";
  }
  const expected = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: slug,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: BRANCH,
    GITHUB_WORKFLOW_REF: `${slug}/${WORKFLOW}@${BRANCH}`,
    DISKTOP_RELEASE_TAG: `v${manifest.version}`,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (environment[name] !== value) {
      return `${name} is ${JSON.stringify(environment[name] ?? null)}, not ${JSON.stringify(value)}.`;
    }
  }
  return undefined;
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const refusal = publishRefusal(process.env, manifest);
  if (refusal !== undefined) {
    console.error(
      [
        `Refusing to publish disktop@${manifest.version}: ${refusal}`,
        `Disktop is published only by ${WORKFLOW}, dispatched from the default branch for a reviewed tag.`,
        "See CONTRIBUTING.md, \"One initial publication\".",
      ].join("\n"),
    );
    process.exitCode = 1;
  } else {
    console.log(`disktop@${manifest.version} is being published by ${WORKFLOW} on ${BRANCH}.`);
  }
}
