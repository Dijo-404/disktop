# Cleanup safety contract

Status: design contract. No cleanup is implemented in the current scaffold. The rules here apply to all future generic and manager-backed actions and are expanded in [PLAN.md](../PLAN.md#action-and-safety-architecture).

## Trust boundaries

Filesystem contents, filenames, mount topology, provider results, external manager output, and stored plan files can change or be malformed. A TUI selection or CLI argument is an intent, not authority to delete. The Rust helper must independently enforce the protected-path and identity checks even if Node already checked them.

Generic cleanup is limited to explicitly allowed, user-owned roots. It refuses `/`, the user's home directory itself, `/usr`, `/etc`, `/boot`, `/bin`, other protected system roots and their aliases or descendants, Disktop state, Trash, mount roots, swap, active logs, unsafe shared-writable parents, and nested mounts. No `--force` option overrides a protected path. Symlinks are never followed during scan or deletion. A selected symlink may be removed as the link object after review, subject to the same policy.

The helper requires the Linux path-resolution primitives chosen for the action. If `openat2`, a safe Trash location, a required filesystem operation, a manager, or a permission is unavailable, it refuses the affected action and reports why. There is no fallback to recursive shell deletion.

## Required action sequence

1. **Discover:** A provider or explicit user selection identifies a candidate. The UI labels evidence and uncertainty.
2. **Preview:** Build an immutable, expiring plan. An exact-entry plan fixes paths and expected device, inode, mount, type, size, and modification time for each item. A manager-scope plan fixes an adapter command and bounded selection. Show exact counts or mark counts as estimated or unknown.
3. **Confirm:** Show the operation, scope, totals or estimates, warnings, permission requirement, reversibility, and likely regeneration cost. Non-interactive mutation requires a stored `PLAN_ID` and `--yes`. An irreversible plan also requires its explicit acknowledgement. An apply flag cannot silently change a Trash plan into permanent removal.
4. **Revalidate:** Before each item, resolve from a verified parent directory descriptor without following symlinks or crossing mounts; compare the reviewed fingerprint. Skip or refuse anything changed. Recheck a selected directory subtree before a directory action. A manager adapter performs a live preflight and refuses unbounded scope.
5. **Journal and apply:** Persist intent before a side effect, then persist per-item outcomes. The helper writes the sole durable action journal; manager adapters report their operations through journal messages. Cancellation stops before the next item and records a partial outcome.
6. **Verify and report:** Compare the result to the reviewed plan and read filesystem capacity again where possible. Show selected bytes, bytes moved to Trash, and observed free-space change as separate values. Concurrent processes can affect the observed change.

At startup, reconcile unfinished journal records before offering undo or claiming an action complete. An undo restores only if it can identify its recorded item and the original destination is free; it never overwrites an unrelated new file.

## Trash and irreversible actions

The default user-file action follows the [freedesktop Trash specification](https://specifications.freedesktop.org/trash/latest/). It uses the home Trash when appropriate, otherwise a validated per-mount Trash location. It reserves unique metadata, records the original raw path safely, and refuses if it cannot establish a safe Trash destination. Moving to Trash on the same filesystem normally moves data without increasing free space. Emptying Trash is its own reviewed, irreversible operation.

Permanent erase, hardlink replacement after release of the old inode, permanent-source move or compression, and some manager actions cannot be undone. Each is fixed in its plan and receives a separate warning. Cross-disk move and compression stage and verify an output before removing or trashing the source. On failure, they preserve the source and report any staged output. Hardlink replacement requires same-mount identical content and compatible ownership and metadata; it warns that later writes are shared.

Manager-owned state is changed only through scoped, fixed-argument manager adapters with probe, preview where supported, live preflight, apply, verification, permission mapping, and journal records. A manager may not provide exact item counts or byte savings; the UI must say so. An adapter never substitutes `rm -rf` for a missing manager.

## Privileges and recovery

Normal UI, scans, and user cleanup run unprivileged. A privileged manager action escalates only the reviewed adapter through a scoped `sudo` or `pkexec` invocation. The npm process is not run as root for cleanup. Explicit administrator scans may be read-only from a root-owned global install; EUID 0 disables generic mutation. Authentication failure is a permission result.

The helper records completed, skipped, failed, and remaining items after Ctrl+C or a process crash. Recovery tests must inject failure around journal transitions and verify replay/reconciliation without repeating a successful destructive operation. Tests for file deletion, Trash, undo, move, and compression run only in temporary sandboxes; mount tests use a namespace or VM.

There is a remaining Linux race when another actor with write access to the same parent directory swaps the final component between verification and operation. The implementation must minimize and test this window, and must refuse unsafe shared-writable parents. Do not claim perfect race elimination.
