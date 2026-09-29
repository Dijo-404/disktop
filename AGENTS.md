# Agent guide for Disktop

Read [PLAN.md](PLAN.md) before implementation. It is the product scope, target folder structure, interface map, phase gates, and acceptance checklist. This repository has a runnable development scaffold. Its TypeScript CLI handles `--help` and `--version`; its Rust helper handles only protocol `hello` and `probe`. All storage, cleanup, and TUI capabilities remain planned. Use the existing package scripts for scaffold checks and the phase gates in the plan for feature completion.

## Release rule

All requested Linux capabilities must pass the plan's acceptance matrix before one initial public npm release, `1.0.0`. Internal phases and CI artifacts are not public releases. The macOS adapter boundary is required; a macOS implementation is outside this Linux scope.

## Architecture boundaries

- `src/domain` is pure data and policy. `src/application` uses ports. Linux adapters, providers, storage, and the native client implement ports. CLI and TUI call application services only.
- Providers discover findings and propose plans. They never delete or invoke cleanup commands directly.
- The Rust `native/disktop-fs` helper owns arbitrary-path traversal, the detailed index, hashing, user-file mutation, and the sole durable action journal. Manager-owned cleanup runs through fixed-argument adapters and journal operations in the same reviewed action pipeline. Node may still write its own config, reports, cache, and user timer units.
- Raw filesystem paths are bytes. Keep a lossless encoded value separate from sanitized display text. Byte totals use integers internally and decimal strings in public JSON.
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
