# Agent guide for Disktop

Read [PLAN.md](PLAN.md) before implementation. It is the product scope, target folder structure, interface map, phase gates, and acceptance checklist. **Phases 0 through 7 are complete; Phase 8 (whole-product validation and the sole `1.0.0` release) is the remaining gate.** The contracts are normative and enforced:
`schemas/cli/v1/` and `schemas/native/v1/` define public JSON and the helper protocol,
`src/domain/paths.ts` and `src/domain/protected-paths.ts` define path bytes and the refusal
policy, `src/storage/` defines configuration, `eslint.config.mjs` enforces the dependency rule,
`tests/fixtures/generate.mjs` builds the filesystem shapes, and `docs/threat-model.md` plus
`docs/adr/` record the reasoning. Change a contract and its schema, examples, tests, and docs
in the same commit.

The TypeScript CLI implements every command in `src/cli/parser.ts` — `devices`, the `--json`
dashboard, `alerts check`, `scan`, `explore`, `snapshots list|diff`, `clean`, `clean plan`,
`clean apply`, `history`, `undo`, `find duplicates|stale|empty|broken`, `report`,
`completion`, and `timer install|uninstall` — and the full TUI (`src/tui/`, all six tabs)
against real `lsblk`, `/proc/self/mountinfo`, `statfs`, manager, and helper readings. The
Rust helper implements every operation in `schemas/native/v1/request.json`. Use the package
scripts for checks and the phase gates in the plan for feature completion.

Phase 7's contracts: the TUI reaches only `TuiServices` (`src/tui/services.ts`), the same
application services the CLI handlers get, and can do nothing a command cannot. Views are
pure functions from state to a `Frame` of exactly the terminal's rows, measured in cells
with `src/tui/text.ts`; only `src/tui/render.ts` writes escapes, always through
`noFormat`, and strips controls from every span. Every piece of TUI work is a task in
`src/tui/controller.ts` with its own `AbortController` and a generation check, so a stale
answer never overwrites a newer one, and a task that changes the disk is never abandoned —
leaving waits for it to journal. No single key mutates anything: `c` opens a review, `y`
applies a reversible plan, an irreversible one needs `yes` typed. Reports are pure
renderers in `src/reports/` (CSV formula-neutralised, HTML escaped with a no-script CSP),
written through `src/storage/report-files.ts`, which never replaces an existing file.
Completions are generated from `COMMANDS`, like help.

Phase 8's packaging contract: `vendor/bin/disktop-fs-linux-{x64,arm64}-{gnu,musl}` plus
`SHA256SUMS` are what `scripts/build-release.mjs` produces, what `src/native/locator.ts`
verifies, and what both workflows check; `tests/unit/release-contract.test.mjs` fails if
any of them names a different helper. `package.json` `files` is an allowlist checked by
`tests/package/package.test.mjs` against the packed tarball, which it then installs and
runs. `prepublishOnly` refuses outside the guarded publish workflow.

Mount policy and read-only escalation: without `crossFilesystems` a scan stays on the
root's filesystem, which includes its other mounts showing a part of it nothing else in
the scan reaches (`native/disktop-fs/src/mounts.rs` decides from mountinfo: same
superblock, non-overlapping mount roots); another filesystem or a repeating bind mount is
refused. Snapshots record `sameFilesystemMounts`, and scans under different policies are
never compared. A directory with no child count was never entered and is shown as
unknown, never as its own bytes. "Which scan covers this path" is `scanReaches` in
`src/domain/paths.ts`, which honours excludes and skipped mounts; nothing else decides
it. The only read-only escalation is `src/platform/linux/elevated.ts`: the system's
root-owned `du` with fixed flags over index paths, through pkexec or sudo. Disktop's own
helper never runs as root from a user-writable install, and measured sizes are kept
beside a scan (`src/storage/elevated.ts`), never added to its totals.

Phase 6's contracts: a manager plan holds an action id, its items, and its parameters, and
its argv is derived from them by the fixed templates in `src/domain/managers.ts` every time
it is read; no command is ever stored or read back from a plan file. Adding a manager action
means a template, an item pattern, and an adapter in `src/platform/linux/managers/` that
discovers and previews through the `ToolPort`, preflights live, and verifies by asking the
manager again. The `ToolPort` allowlist matches whole argument vectors, because a prefix
lets a question become a change. The executor journals a manager action through one helper
session — `manager-begin`, `manager-append started` before each spawn and `finished` after,
`manager-finish` — and a command that started and never finished is `uncertain`. Only a
root-privilege command is escalated, by `src/platform/linux/privilege.ts`; under EUID 0
Disktop changes no file itself. A named container volume is never offered. A reviewed
directory carries a digest of its whole subtree (`inspect`), checked again before it is
touched, and a directory with a mount below it is never a target. See
[adr/0007](docs/adr/0007-manager-adapters-and-scoped-privilege.md).

Phase 4's contracts: a plan is the authority an apply runs on. `src/domain/actions.ts`
builds it, fixes its operation, and gives it an expiry; `src/storage/plans.ts` stores it
byte-exactly under `$XDG_STATE_HOME`; `src/application/apply-action.ts` is the only place it
becomes an action. `--permanent` acknowledges a plan that is already irreversible and is
refused on a Trash plan rather than read as an upgrade. The helper repeats every check from
its own side — its `PROTECTED_ROOTS` and `SHARED_CONTAINER_ROOTS` in `native/disktop-fs/src/guard.rs`
are deliberate duplicates of `src/domain/protected-paths.ts` and change in the same commit.
Identity is device, inode, kind, size, and modification time; `mountId` is context and is not
compared, because Node cannot read it. The private journal records that full fingerprint
for undo and available birth time to distinguish recycled staging inodes; old records
without enough identity remain readable but authorise no mutation. Runtime staging pins
its inode with an open descriptor until publication or cleanup. Every item is journalled twice, intent before the
syscall and outcome after, which is what makes a crash legible: an item holding only an intent
is `uncertain`, and so is the action holding it. A result keeps selected bytes, bytes moved to
Trash, and the two free-space readings apart, and never folds them into one number. A new
mutation extends `run_action` in `native/disktop-fs/src/actions.rs`; it does not add a path
around it.

Phase 5's contracts: a digest groups candidates and a byte compare authorises a
mutation, and the two are different functions in `native/disktop-fs/src/content.rs`
for that reason. Every operation that releases one copy of something because
another copy exists re-opens both files and compares them in full immediately
before the syscall; no flag, size, or configuration skips it. See
[adr/0006](docs/adr/0006-content-identity-and-archive-dependencies.md).

A plan fixes everything apply time may not choose. `destination` and
`sourceDisposition` belong to `move` and `compress` and to nothing else;
`keepPath` belongs to `dedup-hardlink` and names the copy that survives rather
than leaving it to entry order; `ruleHash` identifies the cleanup rule a plan
came from, and an apply refuses a plan whose rule has since been edited.
A move or compress is exactly as reversible as what it does to its source, and
`src/domain/actions.ts` derives that rather than believing a stored file.
A destination is judged by `classifyDestination`, which is deliberately not
`classifyGenericTarget`: the allowlist bounds what Disktop may remove and cannot
bound where it may write, because a cross-disk move means writing outside it.

Anything that publishes an output stages it, verifies it, publishes it with a
rename that refuses to overwrite, and only then touches the source. A move is
verified by reading the written bytes back off the device after an `fsync`; a
compression is verified by decompressing it. The journal item's `destination` is
where the **source** went, never where the output was published, which is what
makes `undo` work and what makes a permanent disposition record nothing to come
back from. An undo restores the source and leaves the published output where it
is, because removing it is a plan somebody reviews.

`find stale` measures modification time and says so: no index column holds an
access time, and on a `relatime` or `noatime` mount one would not mean what a
reader would take it to mean. Options nobody could read are `unknown`, never
`maintained`.

A `[[rules]]` block is data and only data. There is no field for a command and
no combination of fields that becomes one, because `config.toml` is a file other
programs can write to. A rule's limits are enforced during selection, not checked
afterwards.

Phase 3's contracts: a `Finding` lives in `src/domain/findings.ts` with the policy that
merges two of them. `size.basis` is mandatory and there is no basis meaning "zero because
nobody looked": an unmeasured footprint is `unknown` and carries no number. No provider
traverses a tree, runs a command, or deletes; it names paths and
`src/application/footprint.ts` measures them in one pass through the `FootprintPort`.
Commands go through the `ToolPort`, whose allowlist in `src/platform/linux/tools.ts` is the
whole set of programs Disktop can run. A `permission-denied` detector makes the whole result
incomplete and `disktop clean` exit `3`; a `missing-tool` one does not, because the feature is
absent rather than hidden. Detectors are registered in `src/providers/index.ts` and nowhere
else.

Phase 2's contracts: `scan` and `query-index` take an `indexDirectory` because a query usually
runs in a different helper process from the scan that wrote the index. A directory row's byte
totals are its whole subtree and a file row's are its own, so per-extension totals cover
regular files only. A second hardlink is indexed with `shared: true` and its bytes reported as
`sharedBytes`, never added. A result with `complete: false` is invalid without a warning
saying what was missed. `npm run bench` measures the budget in
`docs/adr/0002-native-helper-and-index.md`; a regression is investigated, not restated.

## Release rule

All requested Linux capabilities must pass the plan's acceptance matrix before one initial public npm release, `1.0.0`. Internal phases and CI artifacts are not public releases. The macOS adapter boundary is required; a macOS implementation is outside this Linux scope.

## Architecture boundaries

- `src/domain` is pure data and policy. `src/application` uses ports. Linux adapters, providers, storage, and the native client implement ports. CLI and TUI call application services only.
- `src/composition` is the only layer allowed to build an adapter. Everything else, including `src/bin`, receives its services as arguments. Adding a feature means wiring it there, not importing a platform module from a surface.
- Providers discover findings and propose plans. They never delete or invoke cleanup commands directly.
- The Rust `native/disktop-fs` helper owns arbitrary-path traversal, the detailed index, hashing, user-file mutation, and the sole durable action journal. Manager-owned cleanup runs through fixed-argument adapters and journal operations in the same reviewed action pipeline. Node may still write its own config, reports, cache, and user timer units.
- Raw filesystem paths are bytes. Use `src/domain/paths.ts`: `bytesBase64` is the only value an operation may resolve, `display` is sanitized text. Byte totals use `bigint` internally and decimal strings in public JSON. See `docs/adr/0005-lossless-values-in-contracts.md`.
- The layering above is a lint failure, not a convention. Run `npm run lint`; `tests/unit/dependency-rules.test.mjs` proves the rules still bite.
- A new feature must state its capability/permission behavior, action reversibility, incomplete-result behavior, and JSON schema effect.

## Safety rules

- Every cleanup has preview, explicit confirmation, per-item revalidation, a durable journal, cancellation behavior, and a result separating selected bytes, bytes moved to Trash, and observed free-space change.
- Trash is the default. A Trash move generally does not free space until Trash is emptied. Permanent deletion is separate and irreversible.
- Protected roots, mount roots, symlink traversal, nested mounts, and unsafe shared-writable parents are blocked. No `--force` bypass exists for protected paths.
- No arbitrary `fs.rm`, `rm -rf`, shell-built command, or direct mutation from a provider, TUI, or CLI handler.
- If the kernel, helper, manager, or privilege needed for a safe action is missing, report the reason and refuse that action.
- Never run the whole npm process as root for cleanup. Privileged manager commands use reviewed fixed arguments; administrator scans are read-only from a root-owned install.

## Work handoff and verification

For each task, identify the owning folder, changed port/schema, feature-matrix row, fixture, and acceptance test. Keep destructive tests in temporary sandboxes and use mount namespaces or VMs for mount behavior. Update documentation with implementation changes. Run the relevant phase gate before calling work complete. Do not publish to npm until Phase 8 passes.
