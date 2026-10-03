# Disktop

Disktop is a Linux terminal storage manager and analyzer. Its goal is to help you see where disk space went, investigate files and application data, and review cleanup actions before anything changes. The planned interface combines a terminal UI for exploration with a non-interactive CLI for scripts.

> **Project status:** This repository is an implementation in progress. Phases 0 through 6 of [PLAN.md](PLAN.md#internal-implementation-phases) are complete and Phase 7 (complete surfaces) is the next gate. The CLI inventories devices, scans and explores trees, finds duplicate, stale, empty, and broken entries, lists what can be cleaned, and reviews and applies Trash, permanent removal, move, compression, hardlink, rule, and package or container manager actions, with history and undo; the TUI still shows only the dashboard, and reports and shell completions are still planned. There is no published npm package. The first public release will be **`1.0.0`**, after every Linux capability in [PLAN.md](PLAN.md#feature-acceptance-matrix) passes its acceptance checks. Internal phases and CI artifacts are not public releases.

`disktop` is the working package and command name. Registry availability and naming rights must be checked again before publication.

## What Disktop is designed to do

### See storage clearly

- Count SSDs, HDDs, and other block devices without counting loop and pseudo devices as physical disks.
- Show filesystems, mount points, available space, inode use, filesystem type, and whether storage is removable or network attached.
- Warn when a filesystem passes a configurable capacity threshold, 90% by default, or is short on inodes.
- Rank files and directories by allocated disk space, with an apparent-size toggle for sparse or compressed files. Show totals by file type and filter by name, extension, size, age, and owner.
- Save compact snapshots and show changes between comparable scans, such as growth under `~/Downloads`.

### Find space worth inspecting

- Find duplicate files through size, partial hash, full hash, and final byte comparison. Hardlinks to the same inode are not treated as duplicates.
- Find large stale candidates, empty directories, and broken symlinks. Stale results identify whether they use reliable access times or modification times; a modification-time result will never claim that a file was not opened.
- Measure Conda environments and package caches, Python virtual environments, Node and Rust toolchains, project build artifacts, language caches, AI model caches, IDEs, browsers, and Electron applications.
- Inventory installed applications across supported Linux package managers. Package-manager reported sizes are labeled as estimates and kept distinct from measured file usage.
- Surface Steam libraries, Wine/Proton prefixes, VM images, snapshots, large logs, swap, deleted-but-open files, and optional SMART health information. On shared servers, an explicit read-only administrator scan can show usage by file owner.

### Review and act

- Preview user-file cleanup with an exact scope and totals where possible. Send eligible files to the freedesktop Trash by default and support undo when the source has not been replaced.
- Offer explicit permanent deletion, duplicate keep rules and hardlink replacement, cross-disk move, compression, and bounded custom cleanup rules.
- Offer manager-backed cleanup for supported package caches, journal archives, old kernels, Snap and Flatpak artifacts, Docker and Podman resources, and other reviewed targets. Each manager adapter must bound its scope and report when a tool or permission is unavailable.
- Record every attempted change in a durable action journal. Results distinguish selected bytes, bytes moved to Trash, and the observed change in free space. Moving a file to Trash on the same filesystem usually frees **no** space until Trash is emptied.

The full feature list and the acceptance check for each feature are in [PLAN.md](PLAN.md). The [provider catalog](docs/providers.md) explains how findings and cleanup proposals are divided.

## How the interface will work

The planned TUI opens at a disk dashboard. Its main views are **Disks**, **Explore**, **Clean**, **Dev**, **Apps**, and **History**. Explore shows a sorted directory tree and filters. Clean shows the action scope, estimate, reversibility, permission requirement, and confirmation before applying a plan. The interface will support vim keys, mouse input, a `?` help view, themes, `NO_COLOR`, an ASCII fallback, SI/IEC units, and an 80×24 terminal.

The CLI shares the same application services as the TUI. Every command below works today except `report`, which is declared in the parser and returns a clear `not-implemented` error:

```text
disktop --json
disktop devices --json
disktop scan ~/projects --json
disktop explore ~/projects --sort allocated --min-size 1GiB --json
disktop find duplicates ~/projects --json
disktop clean --dry-run --json
disktop clean plan FINDING_ID --operation trash --json
disktop clean apply PLAN_ID --yes --json
disktop undo ACTION_ID --yes --json
disktop report --format html --output report.html
disktop alerts check --threshold 90 --json
```

Planning an action stores its immutable operation and target scope under an expiring plan ID. A separate `apply` command revalidates that plan. `--yes` confirms only the reviewed plan; `--permanent` acknowledges a plan that already specified irreversible removal. It cannot turn a Trash plan into permanent deletion. CLI output will use versioned JSON with decimal-string byte and filesystem integers, safe CSV, and escaped standalone HTML. See [CLI contract](docs/cli.md).

## Safety model

Storage cleanup must stay predictable even when directories change while Disktop is open.

1. Providers discover candidates and propose actions. They cannot delete files or execute cleanup commands.
2. Every action has a reviewable plan. It shows the scope, count or honest estimate, expected bytes, warnings, permission needs, and whether undo is possible.
3. The action engine rechecks each target immediately before changing it. It blocks protected roots, mount roots, nested mounts, symlink traversal, unsafe shared-writable parents, and changed identities. There is no `--force` bypass for protected paths.
4. The Rust helper performs user-file mutations using constrained filesystem operations and writes the durable journal. Manager actions use reviewed fixed-argument adapters and journal records. The whole npm process is never escalated for cleanup.
5. Interruption produces a partial result that says what completed, what was skipped, and what remains. On restart, Disktop reconciles unfinished journal entries.

Disktop will not silently fall back to unsafe deletion when a kernel feature, manager tool, permission, or safe Trash location is missing. Permanent removal and some manager actions are irreversible and require an explicit plan. The remaining same-directory name-swap race under a concurrent writer is documented in [safety.md](docs/safety.md).

## Storage accounting and incomplete results

Disktop will default to allocated bytes (`st_blocks × 512`) and offer apparent bytes (`st_size`). It counts a hardlinked inode once in scan totals. These numbers can differ from `df` because of snapshots, reflinks, filesystem metadata, open deleted files, compression, and activity during a scan. Free-space changes are measured separately after an action and are never presented as guaranteed savings caused solely by Disktop.

Scans stay on one filesystem by default, do not follow symlinks, and report unreadable directories, excluded mounts, and cancellation as incomplete results. Network and removable mounts require explicit selection. WSL Windows mounts such as `/mnt/c` are excluded by default. Scans are designed for bounded memory and low I/O impact, with progress and cancellation.

## Supported environment for the planned release

- Linux on x86-64 or ARM64, with packaged glibc and musl Rust helper binaries; the exact tested distribution matrix is tracked in [support-matrix.md](docs/support-matrix.md).
- Node.js 24.21.0 or newer within the 24 LTS line, or 26.10.0 or newer within the 26 line, for the CLI and TUI. Use the latest security release of either line; other Node versions are refused at startup. Full native scanning and mutation require Linux kernel 5.6 or newer because the safety design uses `openat2`. Unsupported kernel, architecture, or helper combinations expose a clear capability state and retain whatever read-only inventory functions are safe.
- Optional external tools, such as package managers, `lsof`, `smartctl`, `notify-send`, or systemd user units, are probed before their related features are offered.
- A macOS platform boundary is part of the architecture, but a macOS implementation is outside the Linux `1.0.0` scope.

The npm tarball will include prebuilt helpers and will not compile Rust during an end user's install. It is not available from npm yet. **Do not run `sudo npx disktop`**; privileged manager actions will use scoped elevation, and administrator scans will use a root-owned global install in read-only mode.

## Work on the repository now

Start with [AGENTS.md](AGENTS.md), then [PLAN.md](PLAN.md). The scaffold provides these local checks (a supported Node.js version and a Rust toolchain are needed):

```sh
npm ci
npm run build:native
npm run build
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run test:pty
npm run check
npm pack --dry-run
node dist/bin/disktop.js --help
```

The suites cover what is built, not what is planned. Unit tests exercise the mountinfo and lsblk parsers, the inventory join, the alert thresholds, and the dashboard layout at 80×24; integration tests validate what the CLI actually writes on the running host against the published JSON schemas; PTY tests drive a real terminal and check that Disktop hands it back, including after Ctrl+C. The native build and smoke tests check the helper's `hello`/`probe` handshake, its explicit rejection of unimplemented operations, and the locator's checksum and permission verification. Nothing here validates scanning or cleanup, because neither exists yet. Full fixtures, recovery tests, platform coverage, and release-package checks are added as their owning phases are implemented. Do not use a cleanup test against a real home directory or the CI host filesystem.

The intended ownership map is:

| Area | Responsibility |
| --- | --- |
| `src/domain`, `src/ports`, `src/application` | Pure models and policy, interfaces, and shared use cases. |
| `src/platform/linux`, `src/providers`, `src/storage` | Linux inventory and manager adapters, findings, config, snapshots, and read-only history projection. |
| `src/native`, `native/disktop-fs` | Versioned helper client; Rust scan, index, hashing, user-file actions, and durable journal. |
| `src/cli`, `src/tui`, `src/reports` | CLI, terminal UI, and exports through application services. |
| `schemas`, `tests`, `docs` | Public contracts, acceptance evidence, and design decisions. |

See [architecture.md](docs/architecture.md) for the dependency direction and [native-protocol.md](docs/native-protocol.md) for the planned helper boundary. Agents should state the owning module, changed port or schema, acceptance-matrix row, fixture, and test for each implementation task.

## Project state and release process

The numbered phases in [PLAN.md](PLAN.md#internal-implementation-phases) are internal gates. They cover contracts, inventory, scanning, providers, safe actions, advanced analysis, manager cleanup, complete interfaces, and whole-product validation. They do **not** produce public feature-limited releases. Publication of the single initial npm version, `1.0.0`, requires every Linux acceptance row to pass, a packed-tarball audit, clean-account install tests, and verified npm provenance. The first npm publication uses a scoped publish token in GitHub Actions with `npm publish --provenance --access public`; npm trusted publishing can be configured for later updates after the package exists.

A demo GIF and shell completions are release requirements; neither is presented as available in this scaffold.

## Privacy and local data

Disktop itself makes no network requests and collects no telemetry. `npx` or `npm` may contact the npm registry when installing the eventual package. Scans, snapshots, reports, and action history stay on the user's machine. Disktop will follow the XDG base directories: configuration under `$XDG_CONFIG_HOME/disktop`, snapshots under `$XDG_DATA_HOME/disktop`, scan cache under `$XDG_CACHE_HOME/disktop`, and the action journal under `$XDG_STATE_HOME/disktop`, with standard home-directory fallbacks. Reports go only to paths explicitly selected by the user.

## Contributing and license

Read [AGENTS.md](AGENTS.md) and the relevant document in [docs](docs) before changing a module. Add acceptance evidence for new behavior, keep destructive tests in temporary sandboxes, and update schemas and documentation with contract changes. Report security-sensitive deletion issues privately to repository maintainers once a security contact is published; do not include personal filesystem paths or file contents in public reports.

Disktop is licensed under [Apache License 2.0](LICENSE).
