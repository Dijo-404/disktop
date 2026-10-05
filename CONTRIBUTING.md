# Contributing to Disktop

Disktop is being built toward one initial public npm release, `1.0.0`. The phases in [PLAN.md](PLAN.md) are internal gates. No partial npm versions should be published while features or safety checks remain unfinished.

## Start here

Read [AGENTS.md](AGENTS.md) and [PLAN.md](PLAN.md) before changing code. The plan defines module ownership, platform boundaries, protocol and CLI contracts, and the feature acceptance matrix. For a change, identify the owning folder, affected port or schema, acceptance row, fixture, and relevant test.

The Linux application uses Node.js 24 LTS as its baseline, checks Node 26 compatibility in CI, and uses a Rust helper. Use a current patched release within the supported Node lines and the pinned dependencies in `package.json`, `package-lock.json`, and `rust-toolchain.toml`. Install dependencies with `npm ci`; keep both npm and Cargo lockfiles committed. The checks are:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:integration
npm run test:recovery
npm run test:pty
npm run test:performance
npm run fixtures -- standard
npm run check
cargo fmt --manifest-path native/disktop-fs/Cargo.toml --all -- --check
cargo clippy --manifest-path native/disktop-fs/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path native/disktop-fs/Cargo.toml
```

The packed package has its own smoke test, which needs this machine's release helper in
`vendor/bin/` and the npm registry for `terminal-kit`:

```sh
node scripts/build-release.mjs --target host
npm run test:package
node scripts/build-release.mjs --clean
```

A helper in `vendor/bin/` takes precedence over the `build:native` debug build, exactly as
in an installed package, which is why the last line is there. See
[vendor/bin/README.md](vendor/bin/README.md) for the release build itself.

Passing a smoke test is not evidence that a feature row is complete: a change to behaviour comes with a behaviour-based fixture and a test that fails without it.

## Code boundaries

- `src/domain` contains pure models and policy; `src/application` uses ports. Platform adapters, providers, and storage implement ports. CLI and TUI call application services.
- The Rust helper owns arbitrary-path traversal, the detailed index, hashing, user-file mutation, and the durable action journal. Keep raw paths lossless and separate from sanitized display text.
- Providers detect findings and propose actions. They do not perform cleanup. All mutations go through a reviewed plan, confirmation, revalidation, and journaled result.
- Surface unsupported tools, permissions, partial results, and filesystem uncertainty explicitly. Never convert missing evidence into a zero-byte claim.

Do not add `rm -rf`, shell-built cleanup commands, or direct file mutation to a provider, CLI handler, or TUI view. Changes to a public CLI output or helper protocol require updated schemas in `schemas/cli/v1/` or `schemas/native/v1/`, a valid example, an invalid example where a new rule needs proving, and contract tests. The layering in `docs/architecture.md` is enforced by `eslint.config.mjs`; add a case to `tests/unit/dependency-rules.test.mjs` when you add a rule. Document reversibility, capability requirements, cancellation, and incomplete-result behavior for each new action.

## Test safety

Create destructive test trees under isolated temporary directories. Never aim cleanup tests at a developer's home, the CI runner home, or a real system cache. Use mount namespaces or VMs for bind mounts, symlink races, and privileged manager behavior. Test odd byte filenames, hardlinks, sparse files, permission failures, interruptions, and journal recovery for affected code. The Ubuntu, Fedora, and Arch CI container jobs are smoke checks of the build, the terminal tests, and the packed package; they are not a substitute for the host and VM checks in the support matrix.

Keep read-only fixtures independent of host state too. Swap-provider tests restrict
path facts to their temporary tree so `/swapfile` on a runner cannot become a fixture
finding. The terminal scan-interruption test uses a temporary tree and `--throttle 1`
to keep the real helper running until Ctrl+C arrives, including release builds in
minimal containers where `/usr` can be scanned before the key is sent.
Live inventory tests allow documented warnings about unreadable mounts while still
rejecting broken-pipe errors and stack traces when an output reader exits early.

## Pull requests

Keep a change focused on an owning module and its contracts. Include the relevant acceptance evidence in the pull request description. Update user documentation, schemas, and the support matrix alongside behavior changes. CI checks TypeScript, Rust, recovery, the performance budget, the four release helpers, the packed package on x86-64, ARM64, glibc, and musl, and Linux distribution smoke tests; all must pass before a phase gate can be claimed complete.

## One initial publication

`package.json` is the public `disktop@1.0.0` package: version `1.0.0`, `private: false`, and `files` limited to the compiled JavaScript, the four helpers and their `SHA256SUMS`, the CLI JSON schemas, `README.md`, `LICENSE`, and `CHANGELOG.md`. `tests/package/` holds the exact allowlist and fails on anything else. `1.0.0` must contain the complete Linux scope and pass the full Phase 8 checklist before publication. Create a reviewed `v1.0.0` tag only after the full acceptance matrix has evidence.

Being publishable is not the same as being published. `prepublishOnly` runs `scripts/prepublish-guard.mjs`, which refuses `npm publish` anywhere but `.github/workflows/publish.yml` dispatched on the default branch for the tag matching the version. It is a seatbelt against an accidental publish from a checkout, not a control: environment variables can be set by anyone and `--ignore-scripts` skips it. What controls publication is that the only token able to publish lives in the protected environment below. The workflow publishes the exact tarball it tested with `npm publish <tarball> --ignore-scripts`, and npm runs no lifecycle scripts for a tarball anyway, so the workflow runs the guard as an explicit step instead.

Configure a GitHub `npm-publish` environment with required reviewer approval, restrict it to the release branch, and put a one-time granular npm publish token in its `NPM_TOKEN` secret. The token needs **Read and write (publish and stage)** and **Bypass two-factor authentication** for non-interactive CI publishing; give it the shortest practical expiration and revoke it after publication. [npm's token setup guide](https://docs.npmjs.com/creating-and-viewing-access-tokens/) explains these controls. Dispatch `.github/workflows/publish.yml` from the default branch while its tip is still the exact tagged commit, supplying that full SHA and the confirmation text. The workflow checks the workflow event SHA against the tag so provenance identifies the reviewed source.

The workflow has three jobs and one artifact. `build` checks the tag and package metadata, runs every gate, builds the four helpers with `scripts/build-release.mjs` exactly as CI does, packs the tarball once, records its SHA-256, and runs the package smoke test against that file. `verify` runs the same smoke test on the same file, checked by that SHA-256, on ARM64 glibc and on x86-64 and ARM64 musl. Only then does `publish` start; it is the only job in the `npm-publish` environment and the only one with `id-token: write`, it installs and builds nothing, and it publishes the file with the recorded SHA-256 with `--provenance --access public`. The token is supplied only to the publication step and its presence check.

This one-time token is necessary because npm currently [requires the package to exist](https://github.com/npm/cli/issues/8544) before a trusted publisher can be registered. [npm's first-publication guidance](https://docs.npmjs.com/generating-provenance-statements/) supports token-backed GitHub Actions publishing with provenance. A placeholder public package would violate the one-release contract. After `1.0.0` exists, configure npm trusted publishing for `publish.yml` and restrict token publishing for any later maintenance release; no second public release is planned here.

## Tests that need a second filesystem

`disktop clean plan --operation move` refuses a destination on the source's own
filesystem, so the end-to-end move tests in `tests/integration/actions.test.mjs` need two.
Most development hosts have only one that Disktop is willing to publish into: `/dev/shm`
and `/run/user` are usually the other writable mounts and both sit below a protected
root. Those tests skip out loud rather than passing silently.

Set `DISKTOP_TEST_DESTINATION_FS` to a writable directory on a second filesystem to run
them:

~~~bash
DISKTOP_TEST_DESTINATION_FS=/mnt/scratch npm run test:integration
~~~

The copy, verification, publication, and source-disposal sequence itself is covered
without this by the helper's own tests in `native/disktop-fs/src/protocol.rs`, which run
within one filesystem; what the variable adds is the real cross-device path end to end.
