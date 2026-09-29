# Contributing to Disktop

Disktop is being built toward one initial public npm release, `1.0.0`. The phases in [PLAN.md](PLAN.md) are internal gates. No partial npm versions should be published while features or safety checks remain unfinished.

## Start here

Read [AGENTS.md](AGENTS.md) and [PLAN.md](PLAN.md) before changing code. The plan defines module ownership, platform boundaries, protocol and CLI contracts, and the feature acceptance matrix. For a change, identify the owning folder, affected port or schema, acceptance row, fixture, and relevant test.

The Linux application uses Node.js 24 LTS and a Rust helper. Use the pinned versions in `package.json`, `package-lock.json`, and `rust-toolchain.toml`. Install dependencies with `npm ci`; keep both npm and Cargo lockfiles committed. The current scaffold checks are:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:integration
npm run test:pty
npm run fixtures -- standard
npm run check
cargo fmt --manifest-path native/disktop-fs/Cargo.toml --all -- --check
cargo clippy --manifest-path native/disktop-fs/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path native/disktop-fs/Cargo.toml
```

Early scaffolding may implement only smoke coverage. Passing a smoke test is not evidence that a feature row is complete. Add behavior-based fixtures and tests as each module is built.

## Code boundaries

- `src/domain` contains pure models and policy; `src/application` uses ports. Platform adapters, providers, and storage implement ports. CLI and TUI call application services.
- The Rust helper owns arbitrary-path traversal, the detailed index, hashing, user-file mutation, and the durable action journal. Keep raw paths lossless and separate from sanitized display text.
- Providers detect findings and propose actions. They do not perform cleanup. All mutations go through a reviewed plan, confirmation, revalidation, and journaled result.
- Surface unsupported tools, permissions, partial results, and filesystem uncertainty explicitly. Never convert missing evidence into a zero-byte claim.

Do not add `rm -rf`, shell-built cleanup commands, or direct file mutation to a provider, CLI handler, or TUI view. Changes to a public CLI output or helper protocol require updated schemas in `schemas/cli/v1/` or `schemas/native/v1/`, a valid example, an invalid example where a new rule needs proving, and contract tests. The layering in `docs/architecture.md` is enforced by `eslint.config.mjs`; add a case to `tests/unit/dependency-rules.test.mjs` when you add a rule. Document reversibility, capability requirements, cancellation, and incomplete-result behavior for each new action.

## Test safety

Create destructive test trees under isolated temporary directories. Never aim cleanup tests at a developer's home, the CI runner home, or a real system cache. Use mount namespaces or VMs for bind mounts, symlink races, and privileged manager behavior. Test odd byte filenames, hardlinks, sparse files, permission failures, interruptions, and journal recovery for affected code. The Fedora and Arch CI container jobs are smoke checks until those fixtures and manager adapters are implemented; they are not a substitute for the Phase 8 matrix in the plan.

## Pull requests

Keep a change focused on an owning module and its contracts. Include the relevant acceptance evidence in the pull request description. Update user documentation, schemas, and the support matrix alongside behavior changes. CI checks TypeScript, Rust, package layout, and Linux distribution smoke tests; all must pass before a phase gate can be claimed complete.

## One initial publication

`package.json` remains `private: true` before the release gate. `1.0.0` must contain the complete Linux scope and pass the full Phase 8 checklist before publication. Create a reviewed `v1.0.0` tag only after the package is changed to version `1.0.0` and `private: false`, the four helper binaries and checksums are complete, and the full acceptance matrix has evidence.

Configure a GitHub `npm-publish` environment with required reviewer approval, restrict it to the release branch, and put a one-time granular npm publish token in its `NPM_TOKEN` secret. The token needs **Read and write (publish and stage)** and **Bypass two-factor authentication** for non-interactive CI publishing; give it the shortest practical expiration and revoke it after publication. [npm's token setup guide](https://docs.npmjs.com/creating-and-viewing-access-tokens/) explains these controls. Dispatch `.github/workflows/publish.yml` from the default branch while its tip is still the exact tagged commit, supplying that full SHA and the confirmation text. The workflow checks the workflow event SHA against the tag so provenance identifies the reviewed source. It also checks package metadata, tests, executable checksums, and the packed artifact before publishing that artifact with `--provenance --access public`. The token is supplied only to the final publication step and its presence check.

This one-time token is necessary because npm currently [requires the package to exist](https://github.com/npm/cli/issues/8544) before a trusted publisher can be registered. [npm's first-publication guidance](https://docs.npmjs.com/generating-provenance-statements/) supports token-backed GitHub Actions publishing with provenance. A placeholder public package would violate the one-release contract. After `1.0.0` exists, configure npm trusted publishing for `publish.yml` and restrict token publishing for any later maintenance release; no second public release is planned here.
