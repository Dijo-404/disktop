# Disktop: single-release implementation blueprint

Status: the blueprint the `1.0.0` release candidate was built from. Every feature below is implemented; the tree is the code layout as planned, and the note under "Target repository layout" says where a planned file was folded into a neighbour. `disktop` is the npm package and executable name; check registry availability once more immediately before the one publication.

## Release contract

There will be **one initial public npm release, `1.0.0`**. Phases in this document are internal build gates, not separate public versions or an MVP release. Every requested Linux feature must be implemented, documented, and tested before publishing. Local builds and CI artifacts are allowed. Missing external tools, hardware, or privileges must produce an explicit capability state; they cannot crash the app or silently pretend a feature succeeded. The platform abstraction ships in `1.0.0`; macOS implementation is outside this Linux release.

The user journey is: open a fast dashboard → identify a full filesystem → inspect the largest files, directories, apps, and caches → review an action with exact scope and estimates → apply it safely → see the actual result and undo when possible. Disktop itself makes no network calls and collects no telemetry. `npx` may contact the npm registry to install it.

### Current implementation boundary

The package is the `1.0.0` release candidate. **Phases 0 through 7 are complete**; Phase 8, whole-product validation and the sole release, is the remaining gate. Nothing is published until it passes.

Phase 0 delivered the contracts, not features: normative JSON Schemas for CLI output (`schemas/cli/v1/`) and the helper protocol (`schemas/native/v1/`) with valid and invalid examples under contract test; byte-exact path handling and the protected-path refusal policy in `src/domain`; XDG locations, configuration defaults, and a strict TOML subset reader in `src/storage`; the source dependency rule enforced by `eslint.config.mjs` and proven by `tests/unit/dependency-rules.test.mjs`; the filesystem fixture generator in `tests/fixtures/generate.mjs`; the fixed kernel and architecture minimums in `docs/support-matrix.md`; the action threat model in `docs/threat-model.md`; and ADRs 0001 to 0005.

Phase 1 delivered the first vertical slice: the command surface is defined once in `src/cli/parser.ts` and drives parsing and help; `disktop devices`, `disktop --json`, and `disktop alerts check` are implemented against real Linux readings; the Linux inventory adapter in `src/platform/linux/inventory/` joins `lsblk -J -b`, `/proc/self/mountinfo`, and `statfs`; `src/application/dashboard.ts` and `src/application/alerts.ts` compute the joined capacity view and the space and inode thresholds; the 80×24 dashboard in `src/tui/` runs behind the `Renderer` interface with vim keys, `NO_COLOR`, an ASCII fallback, and terminal restoration on exit, on `SIGINT`, `SIGTERM`, `SIGHUP`, and after an uncaught exception; `src/native/locator.ts` and `src/native/client.ts` select, verify, spawn, and shut down the helper and carry cancellation by request ID; and `src/composition/root.ts` is now the only layer permitted to build an adapter.

Phase 2 delivered the scanner, the index, search, and growth history. The Rust helper walks a tree with `openat2` containment, never following a symlink and refusing a nested or bind mount unless the scan asked to cross filesystems; it counts bytes once per `(device, inode)` and reports a second hardlink's bytes separately; it aggregates each directory on the way back up, so directories rank by subtree size without a second pass; and it writes a bounded SQLite index of byte-exact names keyed by parent ID, which `query-index` returns as keyset-paginated, filtered, sorted pages. A scan runs on its own thread and emits `accepted`, `progress`, and one `complete`; `cancel` stops it at a directory boundary and it still writes its totals. `src/application/scan.ts`, `explore.ts`, and `snapshots.ts` carry that through `ScanPort`, `FileIndexPort`, and `SnapshotStore`; `src/storage/snapshots.ts` keeps versioned compact snapshots with atomic writes and retention by count and bytes; and `disktop scan`, `disktop explore`, and `disktop snapshots list|diff` are implemented. The measured memory and latency figures replaced the targets in [adr/0002](docs/adr/0002-native-helper-and-index.md).

Phase 4 delivered the reviewed action pipeline. A plan is built in
`src/domain/actions.ts`, classified against the protected-path policy, fingerprinted
live, measured through the scan index, and stored with an expiry under
`$XDG_STATE_HOME`; `src/application/apply-action.ts` is the only place a plan becomes
an action. The Rust helper gained `trash`, `erase`, `empty-trash`, `restore`, and
`journal-reconcile`: it resolves a target's parent one segment at a time from `/` with
`openat2` and no symlink resolution, re-applies the protected-path policy from its own
side, compares the live entry against the reviewed fingerprint, writes each item's
intent before the syscall and its outcome after, and holds the only durable journal.
Trash follows the freedesktop specification, reserving its `.trashinfo` with an
exclusive create and renaming with `RENAME_NOREPLACE`. `disktop clean plan`,
`clean apply`, `history`, `undo`, and `find empty|broken` are implemented, and the
index now records each directory's direct child count and whether each symlink
resolves, so those two searches are a filter rather than a second walk.

Phase 5 delivered the advanced analysis and the actions that publish something.
`native/disktop-fs/src/content.rs` draws the line the rest of the phase rests on: a
digest groups candidates and a byte compare authorises a mutation, and every operation
that releases one copy because another exists re-reads both files in full immediately
before the syscall. `hash-candidates` narrows a scan's size classes by an edge digest and
then by a full digest, excluding second hardlinks, and `disktop find duplicates` applies
a keep rule to what comes back — reporting the group undecided rather than guessing when
the rule cannot separate them. `disktop find stale` measures modification time and
carries the mount's own options as the confidence beside it. A plan now fixes a
destination, a source disposition, the copy a hardlink replacement keeps, and the hash of
the cleanup rule it came from; `classifyDestination` judges where output may be written,
which is a different question from what may be removed. The helper gained
`dedup-hardlink`, `copy-move`, and `compress`, each staging its output, verifying it —
by reading the bytes back for a copy, by decompressing for an archive — publishing it
without overwriting, and only then disposing of the source. `[[rules]]` blocks in
`config.toml` become findings through a provider with no more power than any other, and
an apply refuses a plan whose rule has been edited since it was reviewed. Every result
now carries what the apply checked after the fact, and a failed check keeps it off
`complete`.

Phase 6 delivered manager cleanup and alerts, and closed the gaps earlier phases left.
Adapters for apt, dnf, pacman, journald, Snap, Flatpak, Docker and Podman (images,
stopped containers, build cache, anonymous volumes), old kernels, and systemd-tmpfiles
(temporary and crash/core files) discover and preview through the read-only `ToolPort`,
preflight live, and verify by asking the manager again; a manager plan's commands are
derived from its items by fixed templates and never stored. The helper journals manager
actions with `manager-begin`, `manager-append`, and `manager-finish`, and only a
root-privilege command is escalated, through `sudo` or `pkexec`; under EUID 0 Disktop
changes no file itself. `explore --owners` gives the per-user breakdown for any scanned
path, `alerts check --notify` uses `notify-send`, and `timer install|uninstall` manages an
hourly user timer that runs only the alert check. Plans now carry a digest of every
reviewed directory's subtree, taken by `inspect` and checked before the directory is
touched; a target with a mount below it is refused; staged output a crash leaves behind is
released on reconciliation; and stored plans, tool output, and the `ToolPort` allowlist
fail closed where they did not.

Phase 7 completed the surfaces. Every TUI tab works at 80×24 over the same application
services as the CLI: Disks with usage and reserved-space bars, Explore browsing a stored
scan a directory at a time (an exact-path lookup, then keyset pages of children) with
share-of-parent bars, growth and a trend across comparable snapshots, a file-type
distribution, the finders, and a filter language that compiles to the CLI's
`EntryFilter`; Clean, Dev, and Apps over one discovery with actionable findings totalled
apart from informational ones; History with undo; and reviewed plans, where `y` applies a
reversible plan and an irreversible one needs `yes` typed. The renderer writes only
changed rows through `noFormat`, measures terminal cells, and restores the terminal on
every exit path; `NO_COLOR`, ASCII glyphs, `TERM=dumb`, mouse, resize, and tmux are
covered by PTY tests. `disktop report --format json|csv|html` exports capacity, a stored
scan, and findings with formula-safe CSV and script-free escaped HTML, and `disktop
completion bash|zsh|fish` is generated from the command table. The README carries a demo
rendered from the TUI's own frames (`scripts/demo-svg.mjs`).

Phase 8's engineering pass is implemented and locally validated. Connected drives and
every persistent partition are visible, and the TUI uses Catppuccin Mocha with truecolor
and terminal fallbacks. Every mutation, scan/index, resource-sensitive adapter and
surface was reviewed and hardened with regression coverage. `npm run check` passes
1,084 unit/contract, 128 integration, 13 recovery and 18 PTY checks; Rust format, Clippy
and 266 helper tests pass. Separate gates prove real filesystem faults, the systemd
user timer, SSH restoration and actual reviewed apt/DNF5/pacman cleanup in disposable
containers. All four release helpers build with verified checksums;
the packed artifact passes clean installation on Node 24/26 and glibc/musl. The
million-entry resource/latency gate and both dependency advisory checks pass. See
[the validation record](docs/release-readiness.md) and [support matrix](docs/support-matrix.md).
Publication still requires green CI at the reviewed commit, the remaining hardware/VM
checks explicitly listed in that matrix, and approval through the guarded workflow.
Phase 8 includes publication and subsequent provenance/registry-install verification,
so it is not marked complete before those happen.

## Supported environment and packaging

- TypeScript on Node.js 24 LTS as the minimum baseline, with Node 26 compatibility checked in CI, for the TUI, CLI, application services, adapters, and reports. Set minimums at patched releases and update them when new security fixes arrive; see [the support matrix](docs/support-matrix.md). Use `terminal-kit` behind a renderer interface; verify mouse, vim keys, 80×24, tmux, SSH, and terminal restoration before locking the choice. [Node releases](https://nodejs.org/en/about/previous-releases), [Terminal Kit document model](https://github.com/cronvel/terminal-kit/blob/master/doc/document-model.md)
- One bundled Rust executable, `disktop-fs`, owns fd-relative traversal, the disk-backed file index, hashing, and changes to user files. Node invokes it with `spawn` and a versioned JSON-lines protocol, never through a shell string. It is a child process, not a daemon or npm native addon. Full scan and mutation support requires Linux kernel 5.6 or newer because the design uses `openat2`.
- Package tested Linux x86-64 and ARM64 binaries for glibc and musl in the single npm tarball, with no install script. Probe architecture, binary integrity, protocol version, kernel support, and filesystem capabilities at startup. Unsupported combinations keep inventory and documented read-only functions available and clearly disable mutations.
- The helper uses Linux `openat2` containment where supported. If required safety primitives are unavailable or blocked, the relevant action refuses to run; there is no unsafe fallback. The minimum supported kernel and architecture matrix become explicit in Phase 0. [`openat2`](https://man7.org/linux/man-pages/man2/openat2.2.html)
- Configuration follows `$XDG_CONFIG_HOME/disktop/config.toml`, data and compact snapshots follow `$XDG_DATA_HOME/disktop/`, searchable scan cache follows `$XDG_CACHE_HOME/disktop/`, and durable action history follows `$XDG_STATE_HOME/disktop/`, each with standard home-directory fallbacks.

## Target repository layout

This is the implementation map. Modules were created as their owning phase began; the Clean, Dev, and Apps tabs share one view (`src/tui/views/findings.ts`), and the TUI's behaviour lives in `src/tui/controller.ts`.

~~~text
disktop/
├── AGENTS.md                         agent handoff and invariant summary
├── PLAN.md                           this blueprint and feature traceability
├── README.md                         install, demo, safety, no-telemetry statement
├── CHANGELOG.md
├── CONTRIBUTING.md                   contributor workflow and phase gates
├── SECURITY.md                       vulnerability reporting and safety policy
├── LICENSE
├── package.json                      bin, engines, files, scripts, publish metadata
├── package-lock.json
├── tsconfig.json
├── eslint.config.mjs
├── rust-toolchain.toml
├── .editorconfig
├── .gitattributes
├── .gitignore
├── vendor/bin/                       packaged helper binaries, selected at runtime
├── docs/
│   ├── architecture.md              decisions, dependency graph, data flow
│   ├── safety.md                    protected paths, race limits, action recovery
│   ├── cli.md                       syntax, JSON schema, exit codes, examples
│   ├── providers.md                 adapter contract and capability behavior
│   ├── native-protocol.md           JSON-lines messages and version negotiation
│   ├── support-matrix.md            kernels, architectures, distros, commands
│   └── adr/                         recorded decisions and tradeoffs
├── schemas/
│   ├── cli/v1/                      public JSON output schemas
│   └── native/v1/                   helper request and event schemas
├── src/
│   ├── bin/disktop.ts               executable, bootstrap, signals, exit status
│   ├── domain/
│   │   ├── models.ts                Device, Filesystem, Mount, Entry, Finding
│   │   ├── sizes.ts                 allocated/apparent/estimated size rules
│   │   ├── paths.ts                 byte paths and safe display representation
│   │   ├── actions.ts               plan/result types and protected-path policy
│   │   └── errors.ts                partial, denied, unsupported, changed
│   ├── ports/
│   │   ├── inventory.ts             InventoryPort
│   │   ├── scan.ts                  ScanPort and FileIndexPort
│   │   ├── providers.ts             FindingProvider and ManagedActionProvider
│   │   ├── actions.ts               ActionPort and ActionJournalPort
│   │   ├── snapshots.ts             SnapshotStore
│   │   └── notifications.ts         NotificationPort
│   ├── application/
│   │   ├── dashboard.ts             joined capacity, alerts, cached findings
│   │   ├── scan.ts                  scan lifecycle, progress, cancel
│   │   ├── explore.ts               pagination, sort, filters, type totals
│   │   ├── find.ts                  duplicate/stale/empty/broken orchestration
│   │   ├── footprint.ts             provider discovery and deduplication
│   │   ├── snapshots.ts             comparable snapshots and growth
│   │   ├── plan-action.ts           immutable reviewed action plans
│   │   ├── apply-action.ts          confirmation, apply, verify, journal
│   │   ├── undo.ts                  restore and collision handling
│   │   └── alerts.ts                threshold checks and notification intent
│   ├── platform/linux/
│   │   ├── inventory/              lsblk, mountinfo, statfs, WSL detection,
│   │   │                           filesystem-kind classification
│   │   ├── packages/               dpkg, rpm, pacman, snap, flatpak, npm, pip
│   │   ├── diagnostics/            lsof, smartctl, btrfs/zfs, logs, per-user
│   │   ├── managers/               apt, dnf, pacman, journal, snap, flatpak,
│   │   │                           docker, podman, tmpfiles, old kernels
│   │   ├── notifications/          notify-send and systemd user timer
│   │   └── process.ts              fixed-argv subprocess and capability probe
│   ├── providers/
│   │   ├── dev/                    conda, venv, pyenv, nvm/fnm, rustup, artifacts
│   │   ├── caches/                 browsers, Electron, language, AI, IDE, Android
│   │   ├── storage/                Steam, Wine/Proton, VMs, Timeshift, swap
│   │   └── rules/                  declarative custom cleanup rules
│   ├── storage/
│   │   ├── config.ts               TOML loading, validation, defaults
│   │   ├── xdg.ts                  locations and permissions
│   │   ├── plans.ts                opaque, expiring reviewed action plans
│   │   ├── snapshots.ts            versioned compact summaries and pruning
│   │   └── history.ts              read-only history projection from journal
│   ├── native/
│   │   ├── client.ts               typed helper process and cancellation
│   │   ├── protocol.ts             versioned messages and decimal byte values
│   │   └── locator.ts              matching bundled binary and integrity check
│   ├── composition/
│   │   └── root.ts                 the only layer that builds an adapter
│   ├── cli/
│   │   ├── parser.ts               one command/option definition
│   │   ├── run.ts                  dispatch from parsed command to handler
│   │   ├── context.ts              the services a handler may reach
│   │   ├── bootstrap.ts            supported-runtime gate before any reading
│   │   ├── text.ts                 human-readable tables
│   │   ├── commands/              devices, scan, find, clean, history,
│   │   │                           undo, snapshots, report, alerts, completion
│   │   ├── output.ts               stdout JSON/text and stderr progress
│   │   └── completions.ts          bash, zsh, fish from parser metadata
│   ├── tui/
│   │   ├── app.ts                  lifecycle and terminal restoration
│   │   ├── state.ts                selection, filters, scan, confirmation
│   │   ├── views/                 Disks, Explore, Clean, Dev, Apps, History
│   │   ├── widgets/               bars, tables, progress, dialogs, help
│   │   ├── keys.ts                 vim keys, mouse, shortcuts
│   │   ├── themes.ts               theme, NO_COLOR, ASCII fallback
│   │   └── render.ts               terminal-kit adapter
│   └── reports/
│       ├── json.ts                 versioned machine output
│       ├── csv.ts                  escaped cells and formula protection
│       └── html.ts                 escaped standalone report
├── native/disktop-fs/
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs                 protocol loop and version handshake
│       ├── protocol.rs             decode/encode, validation, event IDs
│       ├── walk.rs                 fd-relative bounded traversal
│       ├── index.rs                SQLite file index and paged queries
│       ├── hash.rs                 partial/full hashes and final comparison
│       ├── journal.rs              durable mutation intent and result records
│       ├── guard.rs                protected roots, mount and inode checks
│       └── actions/               trash, restore, erase, move, compress,
│                                   hardlink replacement, empty Trash
├── tests/
│   ├── fixtures/                  generator for sparse, hardlink, mount,
│   │                               permission, odd-byte and huge trees
│   ├── unit/                      pure domain and parsing tests
│   ├── contract/                  CLI JSON and native protocol schemas
│   ├── integration/               Linux adapters and temp-sandbox actions
│   ├── pty/                       80×24, NO_COLOR, keys, mouse, Ctrl+C
│   ├── recovery/                  injected crash and journal restart tests
│   └── performance/               million-entry RSS and scan benchmark
├── scripts/                       build binaries, fixtures, benchmarks, VHS demo
└── .github/workflows/
    ├── ci.yml                     Node/Rust checks and distro matrix
    └── publish.yml                guarded sole npm publication workflow
~~~

### Dependency rule

`domain` has no I/O and imports no UI. `application` depends on `domain` and `ports`. Linux adapters, providers, storage, and the native client implement ports. CLI, TUI, and reports call application services; they never call the helper or a cleanup command directly. `composition` is the one layer that may build an adapter, and it imports no surface; every other layer receives what it needs as an argument, which is what lets the rule forbid the reach at all. Only `application/apply-action.ts` may commit a reviewed plan, and only the Rust helper may mutate arbitrary filesystem paths. Manager-backed actions go through fixed-argument adapters and the same plan, confirmation, result, and journal pipeline.

~~~text
CLI ─┐
TUI ─┴──> application use cases ──> ports <── Linux adapters / providers / storage
             │                          └────> native client ──> Rust helper
             └──> report renderers                       │
                                                         ├─ fd-relative scan + SQLite index
                                                         └─ audited actions + journal
~~~

### Local commands and gates

Locked tool versions are in the npm and Cargo lockfiles.

~~~text
npm ci                              install the locked TypeScript toolchain
npm run build:native                build the local Rust helper in debug mode
npm run build                       compile TypeScript into a clean dist/
npm run typecheck                   check TypeScript sources
npm run lint                        lint, including the dependency rule
npm test                            unit and contract suites
npm run test:integration            Linux adapters and real-helper sandbox actions
npm run test:recovery               injected crashes and journal reconciliation
npm run test:pty                    real-terminal TUI tests (script and tmux)
npm run test:performance            scan memory and latency budget
npm run bench                       the same budget on the million-entry tree
npm run build:release-native        the four packaged helpers and SHA256SUMS
npm run test:package                pack, audit, install, and run the tarball
npm run check                       typecheck, lint, unit, integration, recovery, PTY
npm run fixtures -- standard         build a throwaway fixture tree and print its path
cargo test --manifest-path native/disktop-fs/Cargo.toml
~~~

`build:native` must never compile during an end user's `npm install`. The publish workflow must verify packaged binary checksums and executable permissions before it can release. Agent changes to protocol, CLI JSON, or persistence require schema migrations or explicit version bumps and corresponding contract tests.

### Native helper protocol

Every request has a protocol version, request ID, operation, and validated arguments; every response carries the same request ID, and unknown fields, versions, and operations are rejected. A long operation emits `accepted`, then `progress`, then exactly one terminal `complete` or `error`; actions also emit `item-result`. The helper's stdout carries protocol messages only; stderr is diagnostics. The client cancels by request ID and waits for the final partial result and journal flush, and a missing final event is never success. The Rust journal is the sole durable action-history writer.

The operations are `hello`, `probe`, `scan`, `query-index`, `hash-candidates`, `inspect`, `cancel`, `trash`, `restore`, `erase`, `copy-move`, `compress`, `dedup-hardlink`, `empty-trash`, `manager-begin`, `manager-append`, `manager-finish`, and `journal-reconcile`. Path arguments are base64 raw bytes, never display strings. Mutation requests carry the reviewed `{device,inode,mount,type,size,mtime}` fingerprint and plan ID, and the helper enforces protected roots itself. `schemas/native/v1/` is normative; `docs/native-protocol.md` explains it.

### Contracts between modules

- `RawPath` carries the original byte sequence as base64, a sanitized display string, and an optional valid UTF-8 form. Never reconstruct a mutation target from display text. All terminal, HTML, CSV, logs, and JSON paths use the correct escaped or lossless form.
- `Device`, `Partition`, `Filesystem`, and `Mount` are separate types. `lsblk -J -b` supplies explicit block-device columns; `/proc/self/mountinfo` supplies actual mounts including bind and network mounts; `statfs` supplies user-available blocks and inodes. Loop and pseudo mounts stay out of the main device count. [`lsblk`](https://man7.org/linux/man-pages/man8/lsblk.8.html), [`mountinfo`](https://man7.org/linux/man-pages/man5/proc_pid_mountinfo.5.html)
- `ScanRequest` includes roots, mount policy, excludes, accounting mode, throttle, and cancellation ID. `ScanEvent` is `progress | warning | partial | complete`. A result always includes scanned entries, inaccessible directory count, excluded mounts, and a completeness flag.
- `Entry` contains raw path reference, parent ID, type, device, inode, mount identity, link count, apparent bytes, allocated bytes, owner, and timestamps. Every filesystem identity, count, byte size, and nanosecond timestamp integer uses a lossless decimal string in native IPC, persisted plans, and public JSON; the helper parses and compares integers without JavaScript number rounding.
- `FileIndexPort` supplies paginated sort/filter queries by name, extension, allocated/apparent size, age, and owner. The Rust helper keeps the current detailed index in bounded SQLite storage. Versioned snapshots keep directory aggregates and top entries, not a full copy of every scan. `node:sqlite` is avoided because the Node 24 API is still a release candidate. [Node SQLite status](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
- `Finding` contains category, evidence, scope, confidence, estimated bytes, capability state, and available action IDs. A provider discovers findings; it never deletes. Provider IDs are stable and versioned so saved plans cannot silently change meaning.
- `ActionPlan` fixes the operation before review, including Trash versus permanent source removal, move destination, compression output, or hardlink replacement. An `exact-entry` plan records each byte path and expected type/device/inode/mount/size/mtime plus an exact item count; large directory manifests stay disk-backed. A `manager-scope` plan records a bounded command and selection, with estimated or unknown count when the manager has no exact preview. Both record provider/rule versions, estimated bytes, warnings, and expiry. Persist the immutable reviewed plan under an opaque ID with a checksum and expiry so a separate CLI invocation can apply the same operation after revalidation; the checksum detects corruption but cannot protect against malicious edits by the same user. `ActionResult` records completed/skipped/failed or manager-reported outcomes, observed free-space delta when measurable, bytes moved to Trash, journal ID, and undo availability. The observed delta may include unrelated filesystem activity.
- `Capability` is `available | missing-tool | permission-denied | unsupported-kernel | unsupported-filesystem | unsupported-architecture` with an explanation. The TUI and JSON show it. No adapter treats missing data as zero.

## Filesystem and index algorithms

1. **Inventory:** Parse `lsblk` with explicit JSON columns into physical topology. Parse mountinfo separately, deduplicate multiple mounts of one filesystem for alerts, and call `statfs` on each visible filesystem. Show SSD/HDD/unknown rather than guessing when rotation data is absent. Distinguish removable, network, loop, and pseudo. Network and removable mounts are discoverable but scan only after explicit selection; WSL `/mnt/c` is excluded by default.
2. **Scan:** The helper opens a root directory descriptor and walks with bounded work queues. Do not follow symlinks. Use `openat2` no-cross-mount resolution for strict containment, including bind mounts; detect nested mounts before any directory action. Stream progress and errors while aggregating to SQLite, keep Node memory independent of entry count, and respect I/O priority or a throttle option. Cancellation closes handles and marks the scan partial.
3. **Sizes:** Default file disk use is `st_blocks × 512`; apparent size is `st_size`. Count each `(device,inode)` once in scan totals. Attribute hardlinked bytes deterministically to one path and mark the others shared. Reflinks, compression, Btrfs/ZFS snapshots, open files, and metadata can make file totals differ from `df` and can make reclaimed-space estimates wrong. Show actual `statfs` before/after separately. [`stat`](https://man7.org/linux/man-pages/man2/stat.2.html), [`unlink`](https://man7.org/linux/man-pages/man2/unlink.2.html)
4. **Index:** Store names as BLOB bytes, normalized searchable text separately, parent IDs instead of repeated full path strings, and indexed size/extension/timestamp/owner columns. Bound SQLite cache and index size. Once a scan is replaced, prune its detailed rows; do not let growth history retain millions of file objects.
5. **Snapshots:** Store a versioned compact directory summary keyed by scan root, filesystem fingerprint, excludes, and accounting mode. Compare only compatible snapshots, show per-directory increases/decreases, and label renamed or inaccessible paths as uncertain. Apply count and byte retention caps with atomic writes.

## Action and safety architecture

### Common action pipeline

1. Discover an eligible target through a provider or an explicitly selected path. Show scope, why it is a candidate, and whether an action is available.
2. Preview to an immutable `ActionPlan`. Exact-entry plans include reviewed item count and identities; manager-scope plans show the precise command/selection plus estimated or unknown counts and bytes. Every plan shows mount or manager scope, permissions, impact, reversibility, and likely regeneration cost. Refuse a manager action if its destructive scope cannot be bounded. Generic actions are allowlisted to user-owned roots and cannot target `/`, `$HOME` itself, `/usr`, `/etc`, `/boot`, `/bin`, other protected roots or their aliases/descendants, Disktop state, Trash, mount roots, swap, or active logs, even with `--force`. Check backing mount/root identity so a bind-mount alias does not bypass this policy.
3. TUI confirmation displays the plan's scope, totals or estimates, and fixed operation. CLI is dry-run by default; non-interactive mutation requires `clean apply PLAN_ID --yes`. `--permanent` only acknowledges an already-permanent plan; it never upgrades a Trash plan at apply time. All custom rules go through the same plan. When the whole app runs with EUID 0, restrict it to read-only mode and scoped privileged adapters rather than allowing generic root-owned cleanup.
4. Revalidate immediately before each action. Use a verified parent directory descriptor, no symlink traversal, no mount crossing, and no-overwrite destination operations. Skip changed targets. Reject untrusted shared-writable parents, nested mounts, unsupported syscall/filesystem behavior, and unsafe privilege scope. A last-component name-swap race remains possible for an actor with write access to the same parent; document this limit and test it. [`openat2`](https://man7.org/linux/man-pages/man2/openat2.2.html), [`rename`](https://man7.org/linux/man-pages/man2/rename.2.html)
5. Write journal intent and result records durably. On Ctrl+C, stop before the next item, finish or record the current operation, then report completed/skipped/remaining counts. On startup, reconcile interrupted actions.
6. Verify the result and read capacity again. Show **estimated selected bytes**, **moved to Trash**, and **observed free-space change** separately. Other processes may change the filesystem at the same time, so never claim the observed change was solely caused by this action.

**Privilege contract:** Normal TUI, scans, and user cleanup run unprivileged. A system-manager adapter resolves an absolute trusted manager executable and uses fixed arguments through a scoped `sudo` or `pkexec` invocation after plan confirmation; the TUI suspends cleanly for an authentication prompt and resumes afterward. The npm process itself is never escalated. A full per-user read-only scan is an explicit administrator mode from a root-owned global install, never `sudo npx`; EUID 0 disables generic mutation. Failed authentication becomes a permission result, not a fallback to unsafe filesystem deletion.

### Operation-specific rules

| Action | Implementation and recovery rule |
| --- | --- |
| Trash and undo | Follow the [freedesktop Trash specification](https://specifications.freedesktop.org/trash/latest/): home Trash on its mount, otherwise validated mount `.Trash/$uid` then `.Trash-$uid`. Reserve a unique `.trashinfo` with exclusive create, percent-encode raw original path bytes, fsync metadata, and rename without overwriting. Refuse visibly if no safe Trash exists. Rescan a selected directory subtree immediately before commit and refuse changed scope; its preview still states that contents can change at commit. Undo uses the journal and never overwrites a new file at the original path. Same-mount Trash usually reclaims zero bytes until emptied. |
| Permanent erase and empty Trash | Explicit irreversible operation fixed in the plan, separate confirmation, protected-root checks inside Node and the helper, fd-relative recursive removal, no symlink traversal or nested mounts. Check each directory entry against the reviewed manifest and stop on additions or identity changes; record partial results per item. |
| Duplicate removal | Group by size, then hash first/last chunks, then stream a full hash; exclude identical inodes and byte-compare before mutation. Keep-oldest, keep-newest, and keep-in-path rules expose their timestamp basis. Default resolution is Trash. |
| Replace with hardlink | Same mount and identical bytes only; require compatible ownership, mode, ACL/xattrs, and explicit warning that later writes are shared. Use a staged link and audited replacement with recovery journal; refuse when atomic semantics are unavailable. Mark the space-saving replacement irreversible after its old inode is released. |
| Move to another disk | Stage an exclusive destination, stream-copy, verify checksum and metadata, fsync, publish without overwrite, then Trash the source by default. A separate permanent-source plan is required to free source space immediately. On failure, preserve the source and report the destination state. Undo restores a trashed source and leaves the published destination in place; removing that output requires a separate reviewed plan. |
| Compress | Stage `.zst` for eligible regular files or `.tar.zst` for directories, treating symlinks as link objects and rejecting nested mounts. Verify decompression/checksum, fsync, publish without overwrite, then Trash source by default. Skip active logs, changing files, incompatible hardlinks, and targets without temporary free space. Undo restores the original and leaves the published archive in place; removing it requires a separate reviewed plan. |
| Declarative rules | TOML-only allowlisted roots, globs, types, minimum age/size, excludes, and max count/bytes. No shell commands in rules. Store a rule hash in plans and require preview and confirmation like built-in findings. |
| Manager cleanup | Fixed argv to apt/dnf/pacman, journalctl, Snap, Flatpak, Docker/Podman, systemd-tmpfiles, and supported old-kernel managers. Each adapter has probe, discover, bounded selection, preview if supported, live preflight, apply, verify, privilege scope, and error mapping. A manager action may report estimated or unknown counts; verify with manager output and before/after capacity without claiming perfect attribution. Never `rm -rf` manager-owned state directly. Manager actions may be irreversible and must say so. |

## Provider inventory for the one release

| Area | Detectors and actions included |
| --- | --- |
| Developer environments | Conda envs and `pkgs` cache; venvs; pyenv versions; nvm/fnm Node versions; rustup toolchains. Show counts and allocated sizes. Use manager-owned removal where available; otherwise only reviewed Trash actions on inactive user-owned artifacts. |
| Project artifacts | `node_modules`, Rust `target/`, `__pycache__`, `.next`, `build/` and similar configured output directories, ranked by size and last modification. |
| Language caches | npm, yarn, pnpm, pip, Cargo, Go, Maven, and Gradle caches with provider-specific preview and regeneration notes. |
| AI and development tools | Hugging Face, Ollama, PyTorch hub, Android SDK/emulator images, JetBrains caches, VS Code extensions and caches. |
| Browsers and Electron | Chrome/Chromium and Firefox caches/profiles; Slack, Discord, Teams, VS Code and other detected `Cache`/`GPUCache` directories. Distinguish old profiles from active cache and do not erase profile data as a cache. |
| Games, VMs, snapshots | Steam libraries with per-game sizes; Wine/Proton prefixes; VirtualBox, libvirt and GNOME Boxes images such as `.qcow2`/`.vdi`; Timeshift and Btrfs/ZFS snapshot awareness. Flag active images before move or compression. |
| System and containers | User temp and policy-driven `/tmp`, thumbnail cache, Trash, apt/dnf/pacman caches, journald archived logs, old kernels via manager, `/var/crash` and core dumps, Snap old revisions, unused Flatpak runtimes, Docker/Podman images, stopped containers, build cache, and unused volumes. Each cleanup target has its own preview and privilege/safety gate. |
| Logs and hidden use | Oversized `/var/log` files with likely logrotate/journal cause, deleted-but-open files via `lsof +L1`, swap and hibernation images, SMART via `smartctl` if available. Do not truncate active logs or delete swap just because they are large. |
| Installed apps | Counts and manager-reported installed sizes for dpkg, rpm, pacman, snap, Flatpak, global npm/pip, and AppImages from configured roots. Sort within each manager; show app data/cache separately. Manager sizes are estimates, not guaranteed reclaimable bytes. |
| Shared servers | Per-user allocated usage by file owner for selected filesystems, with explicit privilege requirement and incomplete-scan labels. No silent escalation. |

## User-facing surfaces

### TUI

The dashboard header shows filesystems, bars, free bytes, inode pressure, and a 90% warning by default. Main tabs are **Disks**, **Explore**, **Clean**, **Dev**, **Apps**, and **History**. Explore supports descending allocated/apparent sort, file-type totals, name/extension/size/age filters, breadcrumbs, growth since a comparable scan, duplicates, stale candidates, empty directories, and broken links. Clean shows provider cards with scope, estimate, risk, plan, confirmation, progress, result, and undo when available. `?` opens help. Vim keys, mouse, colors, an ASCII fallback, `NO_COLOR`, narrow terminals, and SI/IEC units are required. Terminal state is restored after normal exit, exceptions, and signals.

The 80×24 layout has one main list and one compact detail area so long names and narrow terminals remain readable:

~~~text
Disktop  /home  88% used  62 GiB available   inodes 41%   [warning]
Disks  Explore  Clean  Dev  Apps  History
Path: ~/projects                         Size: allocated | GiB
  node_modules/                         18.4 GiB   +3.1 GiB
  android-sdk/                          12.0 GiB
  vm-images/                             9.6 GiB
  Downloads/                             7.2 GiB
Selected: node_modules/  |  14 projects  |  last modified: ...
Scan: 431,204 entries  |  inaccessible: 3 dirs  |  Cancel: Esc
? help  j/k move  Enter open  / filter  c plan cleanup  u undo
~~~

The size bar and detail line collapse before the list does. The warning names the specific filesystem and distinguishes low blocks from low inodes. A finding never offers one-key deletion; `c` opens a plan and totals, followed by confirmation.

Stale candidates default to a configurable six-month threshold. Detect mount `atime` options; use `atime` only with an honest confidence label. On `relatime`/`noatime` or uncertain filesystems, show **not modified since** based on `mtime`, never **not opened**.

### CLI and outputs

The command tree is defined once in `src/cli/parser.ts` and drives help and completions:

~~~text
disktop                              TUI
disktop --json                       dashboard summary without a TTY
disktop devices --json
disktop scan [PATH] --json
disktop explore [PATH] --sort allocated --min-size 1GiB --ext log --json
disktop find duplicates|stale|empty|broken [PATH] --json
disktop snapshots list|diff --json
disktop clean --dry-run --json       list available findings/actions
disktop clean plan FINDING_ID --operation trash|permanent|move|compress|hardlink --json
disktop clean apply PLAN_ID --yes --json
disktop clean apply PLAN_ID --yes --permanent --json
disktop history --json
disktop undo ACTION_ID --yes --json
disktop report --format json|csv|html --output FILE
disktop alerts check --threshold 90 --json
disktop timer install|uninstall      opt-in user-level alert timer
disktop completion bash|zsh|fish
~~~

`FINDING_ID` selects a provider result. `PLAN_ID` is a reviewed, immutable plan ID; it is not an arbitrary path. Planning move/compress also fixes `--destination PATH` and `--source trash|permanent`; those choices cannot change at apply time. `--permanent` at apply time only acknowledges a plan already containing irreversible removal or hardlink replacement. Explicit path selection has its own `clean plan --path PATH` flow and the same safety gate. Structured output goes to stdout; progress and diagnostics go to stderr. JSON has a schema version and lossless decimal-string filesystem integers. CSV prefixes cells starting `=`, `+`, `-`, or `@` to prevent formula execution; HTML escapes filenames and all other data. Raw pathname bytes have a base64 field where lossless export is needed. Exit codes: `0` complete, `1` alert threshold reached for alert checks, `2` input or operational error, `3` incomplete scan/action, `130` interrupted.

The optional systemd **user** timer runs only `alerts check` and may call `notify-send`. Install and uninstall are reversible. It never schedules cleanup. A privileged action escalates only that adapter through an explicit mechanism; users are not told to run the whole `npx` TUI as root.

## Internal implementation phases

Each phase ends with a testable gate. No phase publishes to npm.

| Phase | Build work | Gate before continuing |
| --- | --- | --- |
| 0. Contracts and threat model **(complete)** | Establish repository scaffold, schema v1, native IPC, supported kernel/architecture matrix, source dependency rule, config defaults, action threat model, fixture generator, ADRs for TUI/index/packaging. | Example CLI JSON validates against schemas; helper handshake and unsupported-state behavior are specified; safety review approves protected roots and action rules. |
| 1. Vertical slice and inventory **(complete)** | Implement CLI bootstrap, Linux device/mount/capacity inventory, a minimal 80×24 dashboard, Node/Rust process lifecycle, progress/cancel plumbing, and low-space/inode warnings. | Device/partition/mount counts are correct on fixture and real layouts; TUI restores terminal; `disktop --json` works without TTY. |
| 2. Scanner, index, search, history **(complete)** | Build fd-relative walk, allocated/apparent/hardlink accounting, bounded SQLite index, query filters, file-type totals, cached scan view, snapshot comparison and pruning. | Million-entry memory gate, `du -x` comparison where semantics match, invalid-byte names, bind mounts, inaccessible dirs, cancel/restart, and snapshot compatibility tests pass. |
| 3. Findings and application inventory **(complete)** | Implement every dev, language, AI, browser, Electron, game, VM, package, and per-user detector plus SMART, open-deleted, snapshot, log, crash, swap, and WSL diagnostics. | Each provider passes fixtures; optional tools and permissions show capability states; no duplicate findings or unlabelled size estimates. |
| 4. Safe action engine **(complete)** | Implement immutable plans, native journal, Trash, undo, permanent erase, empty folders, broken symlinks, user caches/temp cleanup, Trash emptying, action history, interruption and restart recovery. | All mutations pass sandbox, symlink/bind-mount, collision, protected-root, invalid-byte, crash, and undo tests. Moved-to-Trash and observed free-space values are distinct. |
| 5. Advanced analysis and actions **(complete)** | Implement staged duplicate hashes, stale evidence, keep rules, hardlink replacement, cross-disk move, compression, custom rules, and action verification. | Final byte compare, metadata compatibility, copy/hash/fsync, partial-failure recovery, rule limits, and explicit irreversible-action tests pass. |
| 6. Managed Linux cleanup and alerts **(complete)** | Implement apt/dnf/pacman, journald, Snap, Flatpak, Docker/Podman including volumes, old kernels, `/var/crash`/core policy, system tmpfiles, scoped privilege requests, per-user breakdown, `notify-send` and systemd timer. | Distro-specific adapter tests and host/VM checks pass; every manager action has bounded scope, live preflight, apply, verify, permission, and unsupported cases, with preview where the manager supports it. Timer install/uninstall changes only user units and never cleans automatically. |
| 7. Complete surfaces **(complete)** | Finish all TUI views, themes, vim/mouse/help, search, config, JSON/CSV/HTML exports, all CLI commands, completions, readable help, README, demo GIF, and no-telemetry statement. | A user can complete every core journey at 80×24; all commands work with no TTY and valid stdout; exports survive malicious filenames. |
| 8. Whole-product validation and sole release | Run Linux distro CI, native builds, PTY and recovery suites, package smoke tests, benchmarks, docs review, support-matrix checks, and guarded publish workflow. | All rows in the feature matrix below pass; no unresolved critical deletion or data-loss bug; packed tarball and `npx` work on clean accounts. Publish `1.0.0` once, then verify provenance and install from the registry. |

## Feature acceptance matrix

This matrix is the release checklist. “Available” means the feature is implemented and tested; on a machine lacking its external dependency it reports why it cannot run.

| Requested capability | Phase | Acceptance evidence |
| --- | --- | --- |
| Count SSD/HDD/other devices and show free space, filesystem and mount details | 1 | Mixed block/network/loop and multi-drive fixtures count physical devices once, include every persistent partition (mounted, locked, swap, firmware/recovery or unknown signature), preserve shared RAID/LVM parents and report user-available bytes only from readable mounts. |
| Low-space and inode alerts | 1, 6 | Threshold banner and CLI exit `1`; optional notification/timer runs alerts only. |
| Largest files/directories, type totals, apparent/allocated toggle | 2 | Results sort correctly and match fixture block accounting. |
| Mount-safe, low-impact scans; progress, cancel, cache, WSL default | 2 | Bind mount and WSL fixtures; partial scan and bounded-memory benchmark. |
| Search by name, extension, size, and age | 2, 7 | Paginated queries return expected results without full in-memory scan. |
| Growth snapshots and retention | 2 | Comparable scopes diff correctly; incompatible scopes are refused and old snapshots pruned. |
| Dev environments and project artifacts | 3 | Conda/venv/pyenv/nvm/fnm/rustup and artifact fixtures show counts, sizes, age. |
| Language, AI, IDE, Android, browser, Electron caches | 3, 4 | Each detector has a clear preview and reviewed cleanup path. |
| Steam, Wine/Proton, VMs, Timeshift, swap, profiles | 3 | Read-only footprint fixtures rank entries and flag active/special data. |
| Installed package and app counts/sizes | 3 | Every manager adapter labels reported size versus real disk use. |
| Duplicate, stale, empty-folder, broken-link finders | 4, 5 | Hardlinks excluded; hash pipeline and timestamp confidence tested; eligible empty/broken items clean safely. |
| Trash default, protected paths, confirmation, journal, undo | 4 | Collision, cross-mount, Ctrl+C, crash, refusal, restore, no-overwrite, recycled-inode, rewritten-Trash, and old-journal refusal tests pass. |
| Temporary, language, package, journal, Snap, Flatpak cleanup | 4, 6 | Provider-specific preview/apply/verify tests and privilege states pass. |
| Docker/Podman images, stopped containers, build cache, volumes | 6 | Manager test fixtures prove selection and no unintended volume deletion. |
| Old kernels, crash/core files, oversized-log cause | 3, 6 | Running kernel preserved; policy-backed cleanup only; active logs never truncated. |
| Deleted-open, SMART, Btrfs/ZFS diagnostics | 3 | Capability probes and representative host/VM checks pass. |
| Keep rules and hardlink replacement | 5 | Same-mount/content/metadata gates and shared-write warning tested. |
| Move, compress, and custom cleanup rules | 5 | Source preserved on failure; staged output verified; rule max limits enforced. |
| Per-user breakdown and scoped privilege | 3, 6 | Selected filesystem owner totals plus incomplete/denied labels; no whole-app root requirement. |
| TUI themes, vim/mouse, help, units, terminal fallback | 1, 7, 8 | Catppuccin Mocha with truecolor and 256/16-colour fallback; all six tabs, dialogs and result/undo columns tested at 40×10 through 220×60 in five colour/glyph combinations; repeated-session resource and cancellation regressions; PTY at 80×24, tmux, SSH, NO_COLOR and signal restoration. |
| Non-interactive CLI, JSON/CSV/HTML, exit codes | 1, 7 | Schemas validate; CSV/HTML injection fixtures and piping tests pass. |
| Completion, README/demo, no telemetry, provenance | 7, 8 | Completion smoke tests, tarball audit, registry install and provenance verification pass. |

## Quality, CI, and publication gate

- Use synthetic fixture trees and isolated mount namespaces for destructive tests. Never run a cleanup test against the developer or CI host's real home. Inject faults before and after every journal transition, then restart and reconcile.
- Test UTF-8, invalid byte sequences, newline, control characters, emoji, giant names, sparse files, hardlinks, reflinks where available, unreadable directories, bind mounts, removable mounts, and data changing during scan.
- Run TypeScript typecheck/lint, Rust formatting/clippy/tests, JSON schema contract tests, PTY tests, and Ubuntu/Fedora/Arch container integration. Use host or VM tests for SMART, mount topology, systemd, scoped privilege, and manager interactions that containers cannot prove.
- Phase 0 fixes the memory and responsiveness budget, the measurement method, and the million-entry reference fixture in [adr/0002](docs/adr/0002-native-helper-and-index.md); the numbers are targets until Phase 2's scanner exists to measure, and Phase 2's gate replaces them with observed figures. Keep full file objects out of Node memory, and compare scan behavior to `du -x` on the same scope. Investigate a regression before release rather than claiming a universal scan time.
- Inspect `npm pack --dry-run`, verify executable permissions and binary checksums, test the tarball with global install and `npx` on clean accounts, and confirm no fixture/index/user data is packaged.
- Publish the sole initial npm version from a reviewed GitHub tag with a narrowly scoped npm publish token stored as a protected GitHub secret, using `npm publish --provenance --access public` on a GitHub-hosted runner. npm currently requires a package to exist before its trusted publisher can be configured, so token-free OIDC cannot publish a brand-new `disktop` package. After `1.0.0` exists, configure trusted publishing for any future maintenance releases. Verify the first version's provenance and installation from the registry. [npm first-publish provenance](https://docs.npmjs.com/generating-provenance-statements/), [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [initial OIDC limitation](https://github.com/npm/cli/issues/8544)

## Rules for agents implementing this plan

Start in `AGENTS.md`, then read this plan and the relevant `docs/` contract. Own one module boundary and its acceptance rows at a time. State which interface changes and provider IDs a change introduces. Add fixtures that exercise real behavior; destructive tests stay in temporary sandboxes. Do not let a provider delete, let a presentation module call Linux commands, or bypass the action plan and journal. Update schemas, docs, support matrix, and the feature acceptance row in the same change. A phase is complete only when its gate has evidence.
