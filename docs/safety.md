# Cleanup safety contract

Status: the generic actions are implemented. `disktop clean plan`, `clean apply`,
`history`, and `undo` carry out Trash, permanent erase, emptying Trash, and restore
through the pipeline below, and the Rust helper holds the durable journal. Move,
compression, hardlink replacement, declarative rules, and every manager-backed
action are still design contract, as marked in [PLAN.md](../PLAN.md#action-and-safety-architecture).
[threat-model.md](threat-model.md) states the attackers and residual risks these rules
answer to; [adr/0004](adr/0004-reviewed-action-pipeline.md) records why there is one
pipeline and one journal.

The refusal policy is code, not only prose: `src/domain/protected-paths.ts` classifies a target against protected roots, shared container roots such as `/home` and `/tmp`, the home directory itself, mount roots, Trash, Disktop state, and the allowed roots. An allowed root is the scope of cleanup and never a target itself; an unnormalized or relative path is refused rather than resolved; and an incomplete mount or excluded-root context refuses everything rather than skipping a rule. The policy sees only path bytes, so ownership and parent safety are checked by the helper against live descriptors.

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

## What the implemented actions do

`clean plan` classifies the target against `src/domain/protected-paths.ts`, measures
its footprint through the scan index, records the device, inode, type, size, and
modification time each entry has at that moment, and stores the result under
`$XDG_STATE_HOME/disktop/plans` with an expiry. Nothing has changed on disk when a
plan is written.

`clean apply` refuses a plan that is unknown, unconfirmed, expired, or irreversible
without its acknowledgement, and then hands it to the helper. The helper repeats the
protected-path check from the other side of the process boundary, resolves the
target's parent one segment at a time from `/` with `openat2` and no symlink
resolution, compares the live entry against the reviewed fingerprint, writes the
item's intent to the journal, performs one constrained syscall, and writes the
outcome. A Trash move reserves its `.trashinfo` with an exclusive create and renames
with `RENAME_NOREPLACE`, so the kernel refuses rather than overwriting.

An item whose outcome could not be written to the journal is reported `uncertain`, not
completed: the record is the authority an undo and a restart read, so an outcome nobody
could record is something Disktop cannot prove happened.

`clean plan --operation empty-trash` plans the one operation whose target the generic
policy excludes. It can name this user's own Trash and nothing else, the helper checks
the same thing from its side against the home Trash it was given and the two per-mount
locations the specification defines, and it is irreversible, so applying it needs
`--permanent`.

`history` reconciles before it lists: an item whose intent was written and whose
outcome was not reads as `uncertain`, and the action holding it is uncertain too.
`undo` refuses a permanent removal, refuses an unreconciled action, and restores with
`RENAME_NOREPLACE`, so a name something else has taken is skipped and the newer file
is left alone. It also compares what is in Trash against the device and inode recorded
when the move happened: a name is free again the moment somebody takes the original out
by hand, and an undo that trusted the name alone would move a stranger's file to a path
it never came from.

### Limits this phase does not remove

A reviewed directory is revalidated by its own identity, not by a manifest of
everything beneath it. An entry added to it since review changes its modification
time, so the item is skipped; a file changed *below* a reviewed subdirectory is not
separately detected, and the preview says that a directory's contents can change
between review and commit.

The identity comparison is the device, inode, type, size, and modification time. The
kernel's mount id travels with them as context and is not compared, because the Node
side cannot read it and would be sending a number it invented.

A path whose bytes are not valid UTF-8 cannot be named as a command-line argument,
because process arguments are UTF-8. Such a path is still discovered, indexed,
planned from a finding, moved, and restored byte for byte; only typing it directly
into `--path` is impossible.

## Trash and irreversible actions

The default user-file action follows the [freedesktop Trash specification](https://specifications.freedesktop.org/trash/latest/). It uses the home Trash when appropriate, otherwise a validated per-mount Trash location. It reserves unique metadata, records the original raw path safely, and refuses if it cannot establish a safe Trash destination. Moving to Trash on the same filesystem normally moves data without increasing free space. Emptying Trash is its own reviewed, irreversible operation.

Permanent erase, hardlink replacement after release of the old inode, permanent-source move or compression, and some manager actions cannot be undone. Each is fixed in its plan and receives a separate warning. Cross-disk move and compression stage and verify an output before removing or trashing the source. On failure, they preserve the source and report any staged output. Hardlink replacement requires same-mount identical content and compatible ownership and metadata; it warns that later writes are shared.

Manager-owned state is changed only through scoped, fixed-argument manager adapters with probe, preview where supported, live preflight, apply, verification, permission mapping, and journal records. A manager may not provide exact item counts or byte savings; the UI must say so. An adapter never substitutes `rm -rf` for a missing manager.

## Privileges and recovery

Normal UI, scans, and user cleanup run unprivileged. A privileged manager action escalates only the reviewed adapter through a scoped `sudo` or `pkexec` invocation. The npm process is not run as root for cleanup. Explicit administrator scans may be read-only from a root-owned global install; EUID 0 disables generic mutation. Authentication failure is a permission result.

The helper records completed, skipped, failed, and remaining items after Ctrl+C or a process crash. `tests/recovery/journal.test.mjs` kills the real helper partway through a list of targets and asserts that the record never reads as complete, that no item is left claiming to be running once reconciliation has looked at it, and that nothing left its original path without the journal accounting for it. Tests for file deletion, Trash, undo, move, and compression run only in temporary sandboxes; mount tests use a namespace or VM.

There is a remaining Linux race when another actor with write access to the same parent directory swaps the final component between verification and operation. The implementation must minimize and test this window, and must refuse unsafe shared-writable parents. Do not claim perfect race elimination.
