# Contributing to Disktop

Disktop's initial public npm release, `1.0.0`, was published and independently
verified on 2026-10-07. The phases in [PLAN.md](PLAN.md) are internal gates. The
`v1.0.0` source and npm artifact are immutable; later repository documentation and
verification tooling do not replace them. No additional release is authorized by
these contribution instructions.

On 2026-10-07 the release owner assigned the remaining manual SMART, ZFS, WSL and
non-cache manager checks to testers after initial publication. Automated safety
and release gates still apply. See the [release record](docs/release-readiness.md),
[support matrix](docs/support-matrix.md) and [tester guide](docs/tester-guide.md).

## Start here

Read [AGENTS.md](AGENTS.md) and [PLAN.md](PLAN.md) before changing code. The plan defines module ownership, platform boundaries, protocol and CLI contracts, and the feature acceptance matrix. For a change, identify the owning folder, affected port or schema, acceptance row, fixture, and relevant test.

The Linux application uses Node.js 24 LTS as its baseline, checks Node 26 compatibility in CI, and uses a Rust helper. Use a current patched release within the supported Node lines and the pinned dependencies in `package.json`, `package-lock.json`, and `rust-toolchain.toml`. Install dependencies with `npm ci`; keep both npm and Cargo lockfiles committed.

Builds and type checks use TypeScript 7's native `tsc`. The `@typescript/native`
npm alias supplies that executable; the `typescript` alias supplies Microsoft's
TypeScript 6 compatibility API for `typescript-eslint`. This is the
[supported side-by-side setup](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60).
Keep both aliases when updating the compiler, and verify with a clean `npm ci`,
type checking, and linting. Do not bypass incompatible peer dependencies.

The checks are:

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
npm audit
cargo install --locked cargo-audit --version 0.22.2
cargo audit --file native/disktop-fs/Cargo.lock --deny warnings
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

`node tests/support/managers-disposable.mjs apt` runs the real privileged
package-cache gate in a disposable Ubuntu/Fedora/Arch container. It mounts the repository
read-only, extracts the supported official Node runtime, certifies a fixture-only cache
and grants the ordinary account sudo for the one fixed command. It verifies the reviewed
plan, durable journal, live removal and unchanged package database/sentinel. Docker is
required. Never enable `DISKTOP_TEST_REAL_MANAGER` directly on a host; the integration
test refuses that environment. CI and publication require all three enabled gates;
wrapper interrupt/cleanup tests use a non-mutating Docker fixture.
Run the same command with `dnf` and `pacman` in place of `apt` for the other managers.

Keep read-only fixtures independent of host state too. Swap-provider tests restrict
path facts to their temporary tree so `/swapfile` on a runner cannot become a fixture
finding. The terminal scan-interruption test uses a temporary tree and `--throttle 1`
to keep the real helper running until Ctrl+C arrives, including release builds in
minimal containers where `/usr` can be scanned before the key is sent.
Live inventory tests allow documented warnings about unreadable mounts while still
rejecting broken-pipe errors and stack traces when an output reader exits early.
The distro jobs copy Node from setup-node's shared tool cache into a root-owned
container path before the administrator inventory check. Disktop requires both its
package and its Node executable to be root-owned when running under EUID 0.

Filesystem fault tests create private mount namespaces and disposable tmpfs filesystems.
They test full destinations, full journals, read-only sources and cross-device moves
without touching host mounts. A user namespace that hides the root-owned ancestors of
the journal is unsupported for mutation and explicitly skipped. Dedicated CI and publish
gates keep those identities visible in a disposable container, retain only mount
capability for the ordinary test account, mount the checkout read-only, and require
all fault cases without skips.

For the host's systemd user instance, run
`DISKTOP_TEST_SYSTEMD=1 node --test tests/integration/timer-host.test.mjs` after a build.
This uses throwaway unit files and runtime links, executes a fixture alert command,
then disables and removes its own links. It leaves an existing Disktop timer alone.

`DISKTOP_TEST_SSH=1 node --test tests/pty/ssh.test.mjs` exercises a real loopback SSH
PTY with temporary keys and a private, public-key-only sshd. It requires OpenSSH and
an ordinary user account; it never changes the system's SSH configuration. Quit and
SIGINT must restore every terminal setting at 80×24 with ASCII and `NO_COLOR`.

CI and the publish workflow both run `npm audit` and check the native lockfile with
the pinned Cargo advisory checker. RustSec warnings and vulnerabilities block the
release; advisories are never suppressed just to obtain a passing gate.

## Pull requests

Keep a change focused on an owning module and its contracts. Include the relevant acceptance evidence in the pull request description. Update user documentation, schemas, and the support matrix alongside behavior changes. CI checks TypeScript, Rust, recovery, the performance budget, the four release helpers, the packed package on x86-64, ARM64, glibc, and musl, and Linux distribution smoke tests; all must pass before a phase gate can be claimed complete.

## One initial publication

`package.json` describes the public `disktop@1.0.0` package: version `1.0.0`, `private: false`, and `files` limited to the compiled JavaScript, the four helpers and their `SHA256SUMS`, the CLI JSON schemas, `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES`, and `CHANGELOG.md`. `tests/package/` holds the exact allowlist and fails on anything else. The released tag was created only after all 19 CI jobs passed on its exact commit, the automated publication prerequisites passed and the deferred manual environments were recorded accurately. The [release record](docs/release-readiness.md) identifies that source, artifact and verification evidence.

After a native dependency or release toolchain update, run `npm run licenses:native`
and review the full upstream attributions. `npm run licenses:check` verifies them
against the locked dependency graphs. Release builds run that gate; `npm pack`
also refuses stale or incomplete notices without needing a Rust toolchain.

Being publishable is not the same as being published. `prepublishOnly` runs `scripts/prepublish-guard.mjs`, which refuses `npm publish` anywhere but `.github/workflows/publish.yml` dispatched on the default branch for the tag matching the version. It is a seatbelt against an accidental publish from a checkout, not a control: environment variables can be set by anyone and `--ignore-scripts` skips it. The workflow's publishing token lives only in the protected environment below, so its build and verification jobs cannot access it. The workflow publishes the exact tarball it tested with `npm publish <tarball> --ignore-scripts`, and npm runs no lifecycle scripts for a tarball anyway, so the workflow runs the guard as an explicit step instead.

For the initial publication, the GitHub `npm-publish` environment required reviewer approval and restricted deployment to the release branch. Its one-time granular npm publish credential was supplied through the `NPM_TOKEN` secret or accepted `DISKTOP` alias. `NPM_TOKEN` takes precedence when both are configured; both the presence check and publication use that same choice. Non-interactive direct publication needs **Read and write (publish and stage)** with **Bypass two-factor authentication**; use the shortest practical expiration and revoke the one-time credential after publication. [npm's token setup guide](https://docs.npmjs.com/creating-and-viewing-access-tokens/) explains these controls. The workflow was dispatched from `main` at the exact tagged commit, supplying its full SHA and confirmation text. It checks the workflow event SHA against the tag so provenance identifies the reviewed source.

The workflow has three jobs and one artifact. `build` checks the tag and package metadata, runs every gate, builds the four helpers with `scripts/build-release.mjs` exactly as CI does, packs the tarball once, records its SHA-256, and runs the package smoke test against that file. `verify` runs the same smoke test on the same file, checked by that SHA-256, on ARM64 glibc and on x86-64 and ARM64 musl. Only then does `publish` start; it is the only job in the `npm-publish` environment and the only one with `id-token: write`, it builds nothing and installs no project dependencies before publishing, and it publishes the file with the recorded SHA-256 with `--provenance --access public`. The token is supplied only to the publication step and its presence check.

The initial token-backed workflow followed [npm's first-publication guidance](https://docs.npmjs.com/generating-provenance-statements/): npm [requires a package to exist](https://github.com/npm/cli/issues/8544) before a trusted publisher can be registered. No placeholder package was deliberately published. The registry briefly returned its own temporary placeholder before making `1.0.0` available, as recorded in the release evidence. For any separately authorized maintenance release, configure npm trusted publishing and restrict token publishing; no second public release is planned here.

### Publish 1.0.0

**`1.0.0` is already published. Do not create or move its tag, dispatch publication
again, unpublish it or rebuild its artifact.** Tag `v1.0.0` names
`3d6448560d19d75b27fce75765819d89f36be09e`.

[Publish run 37661525351](https://github.com/Dijo-404/disktop/actions/runs/37661525351)
passed its release build/artifact gates and protected approval. `npm publish`
succeeded, but the run's immediate registry check failed with 404 before the
version became available. The workflow remains recorded as failed. Later independent
registry artifact, clean consumer, npm signature and cryptographic provenance checks
passed. A read-only remote verification recovery run is pending in the
[release record](docs/release-readiness.md); it must not invoke publication.

The public release can be checked without a publish credential:

```sh
npm view disktop@1.0.0 version dist.attestations --json
npm exec --yes --package=disktop@1.0.0 -- disktop --version
npm exec --yes --package=disktop@1.0.0 -- disktop --help
```

The exact released tarball is
[`disktop-1.0.0.tgz`](https://registry.npmjs.org/disktop/-/disktop-1.0.0.tgz), with
SHA-256 `a2deddd76c137e349370fb839b887baff14b3ec27c649f1ce809616bf8b39acd`.
For a signature audit, install the pinned version into a fresh prefix and run
`npm audit signatures --json --include-attestations` from that prefix. Do not treat
an eventual registry verification failure as a reason to republish an existing version.
Revoke the one-time publication credential after verification; never put it in a
command, issue or pull request.

Publication records are maintained in repository documentation after release.
They do not modify the tagged source or published package. Keep every deferred
environment unvalidated until a tester supplies the evidence described in the guide.

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
