# Agent guide for Disktop

Read [PLAN.md](PLAN.md) before implementation. It is the product scope, target folder structure, interface map, phase gates, and acceptance checklist. **Phases 0 and 1 are complete; Phase 2 is the next gate.** The contracts are normative and enforced:
`schemas/cli/v1/` and `schemas/native/v1/` define public JSON and the helper protocol,
`src/domain/paths.ts` and `src/domain/protected-paths.ts` define path bytes and the refusal
policy, `src/storage/` defines configuration, `eslint.config.mjs` enforces the dependency rule,
`tests/fixtures/generate.mjs` builds the filesystem shapes, and `docs/threat-model.md` plus
`docs/adr/` record the reasoning. Change a contract and its schema, examples, tests, and docs
in the same commit.

The TypeScript CLI implements `devices`, the `--json` dashboard, `alerts check`, and the 80×24
dashboard TUI against real `lsblk`, `/proc/self/mountinfo`, and `statfs` readings. Every other
command is declared in `src/cli/parser.ts` and refuses with `not-implemented`. The Rust helper
still handles only `hello` and `probe` and refuses every other operation, so no scan, index,
cleanup, snapshot, or export capability exists yet. Use the package scripts for checks and the
phase gates in the plan for feature completion.

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
