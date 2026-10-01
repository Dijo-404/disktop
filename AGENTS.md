# Agent guide for Disktop

Read [PLAN.md](PLAN.md) before implementation. It is the product scope, target folder structure, interface map, phase gates, and acceptance checklist. **Phases 0, 1, 2, 3, and 4 are complete; Phase 5 is the next gate.** The contracts are normative and enforced:
`schemas/cli/v1/` and `schemas/native/v1/` define public JSON and the helper protocol,
`src/domain/paths.ts` and `src/domain/protected-paths.ts` define path bytes and the refusal
policy, `src/storage/` defines configuration, `eslint.config.mjs` enforces the dependency rule,
`tests/fixtures/generate.mjs` builds the filesystem shapes, and `docs/threat-model.md` plus
`docs/adr/` record the reasoning. Change a contract and its schema, examples, tests, and docs
in the same commit.

The TypeScript CLI implements `devices`, the `--json` dashboard, `alerts check`, the 80×24
dashboard TUI, `scan`, `explore`, `snapshots list|diff`, `clean`, `clean plan`, `clean apply`,
`history`, `undo`, and `find empty|broken` against real `lsblk`, `/proc/self/mountinfo`,
`statfs`, and helper readings. `report`, `timer`, `completion`, and `find duplicates|stale` are
declared in `src/cli/parser.ts` and refuse with `not-implemented`. The Rust helper implements
`hello`, `probe`, `scan`, `query-index`, `cancel`, `trash`, `erase`, `empty-trash`, `restore`,
and `journal-reconcile`; it refuses `copy-move`, `compress`, `dedup-hardlink`,
`hash-candidates`, `inspect`, and every manager operation, so there is no export, move,
compression, or manager capability yet. Use the package scripts for checks and the phase gates
in the plan for feature completion.

Phase 4's contracts: a plan is the authority an apply runs on. `src/domain/actions.ts`
builds it, fixes its operation, and gives it an expiry; `src/storage/plans.ts` stores it
byte-exactly under `$XDG_STATE_HOME`; `src/application/apply-action.ts` is the only place it
becomes an action. `--permanent` acknowledges a plan that is already irreversible and is
refused on a Trash plan rather than read as an upgrade. The helper repeats every check from
its own side — its `PROTECTED_ROOTS` and `SHARED_CONTAINER_ROOTS` in `native/disktop-fs/src/guard.rs`
are deliberate duplicates of `src/domain/protected-paths.ts` and change in the same commit.
Identity is device, inode, kind, size, and modification time; `mountId` is context and is not
compared, because Node cannot read it. Every item is journalled twice, intent before the
syscall and outcome after, which is what makes a crash legible: an item holding only an intent
is `uncertain`, and so is the action holding it. A result keeps selected bytes, bytes moved to
Trash, and the two free-space readings apart, and never folds them into one number. A new
mutation extends `run_action` in `native/disktop-fs/src/actions.rs`; it does not add a path
around it.

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
