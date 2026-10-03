# Cleanup safety contract

Status: every action in [PLAN.md](../PLAN.md#action-and-safety-architecture) is
implemented. `disktop clean plan`, `clean apply`, `history`, and `undo` carry out Trash,
permanent erase, emptying Trash, restore, hardlink replacement, cross-disk move,
compression, declarative rules, and manager-backed cleanup through the pipeline below,
and the Rust helper holds the durable journal.
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
5. **Journal and apply:** Persist intent before a side effect, then persist per-item outcomes. The helper writes the sole durable action journal; manager adapters report their operations through journal messages. Cancellation stops before the next item and records a partial outcome. Inside an item it is heard wherever stopping changes nothing: while a directory is being reviewed again, and while a copy or an archive is being written or read back before it is published, in which case the staged output is taken back, the source is untouched, and the item is skipped as `cancelled`. Once an output is published the item runs to its end, because stopping between a publish and the source's disposal is the one place a stop would leave something half done.
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
with `RENAME_NOREPLACE`, so the kernel refuses rather than overwriting. The
name a file gets in Trash, and the name anything is staged under before it is
published, start with the file's own name and are shortened — never through
the middle of a character — when that name is near the 255-byte limit, so a
long name can still be trashed, moved, and compressed; the original path is in
the `.trashinfo` and the journal either way. An archive whose name would not fit
is refused before anything is written. The
rename takes whatever is under the name at that instant, so the helper then
checks that what arrived in Trash is the inode it revalidated: a file saved
over the reviewed one in between is renamed straight back and the item skipped
as `changed-target`, rather than recorded under an identity an undo would not
recognise.

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

A reviewed directory carries a digest of everything beneath it: each entry's
relative path bytes, kind, inode, size, and modification time, children in byte
order. The helper takes it with `inspect` when the plan is made and takes it again
immediately before the directory is moved to Trash, erased, copied, compressed, or
disposed of after a copy, and skips the item as `changed-target` when anything below
it was added, removed, renamed, or rewritten. Emptying Trash does the same, so
something trashed after the review is not released by it. A directory with another
filesystem mounted anywhere inside it, or one Disktop cannot read all the way down,
is refused at planning time. The window between that last digest and the syscall
remains, as the race below describes.

No action goes more than 512 directories below a reviewed one — the same ceiling
as the scan's walk. Reviewing, copying, archiving, and removing a tree each keep
their directories on an explicit stack with one descriptor open per level, so no
tree is deep enough to overflow the helper's stack partway through an item; a
deeper one is refused when it is planned, and refused again before anything in
it is touched, rather than half-processed. The helper raises its own descriptor
soft limit to the hard limit at startup so a tree at the ceiling fits.

The identity comparison is the device, inode, type, size, and modification time. The
kernel's mount id travels with them as context and is not compared, because the Node
side cannot read it and would be sending a number it invented.

A path whose bytes are not valid UTF-8 cannot be named as a command-line argument,
because process arguments are UTF-8. Such a path is still discovered, indexed,
planned from a finding, moved, and restored byte for byte; only typing it directly
into `--path` is impossible.

## Trash and irreversible actions

The default user-file action follows the [freedesktop Trash specification](https://specifications.freedesktop.org/trash/latest/). It uses the home Trash when appropriate, otherwise a validated per-mount Trash location. It reserves unique metadata, records the original raw path safely, and refuses if it cannot establish a safe Trash destination. Moving to Trash on the same filesystem normally moves data without increasing free space. Emptying Trash is its own reviewed, irreversible operation.

Permanent erase, hardlink replacement after release of the old inode, permanent-source move or compression, and some manager actions cannot be undone. Each is fixed in its plan and receives a separate warning. A move or a compress is exactly as reversible as what it does to the source, so `sourceDisposition` is fixed at review time beside the operation itself: `trash` leaves the original recoverable from the journal, and `permanent` makes the whole plan irreversible, because publishing a copy somewhere and then releasing the original's bytes is a permanent removal with an extra step. `src/domain/actions.ts` derives that and the stored plan's own claim is never believed.

Where a move or compress publishes is judged by `classifyDestination`, which is deliberately a different question from `classifyGenericTarget`. A target is something Disktop removes, so it has to be inside a root the user said Disktop may clean. A destination is somewhere Disktop writes, and a cross-disk move means writing outside those roots by definition — `/mnt/archive` is a correct destination and an incorrect target. The allowlist and the mount-root rule therefore do not apply to a destination; the protected system roots, the shared container roots themselves, and Trash and Disktop's own state still do. Cross-disk move and compression stage and verify an output before removing or trashing the source. For a move, the verification is a digest taken over the bytes as they are read compared against a digest of the same bytes read back after an `fsync`. For a compression it is a decompression: the archive is read back the way anybody recovering from it would read it, and the tar stream that comes out is digested and compared against the one that went in — content, not an entry count, because a member rewritten to the same length keeps a count identical. A digest over what was read cannot notice a source written to while it was read — the read and the write agree on the same torn mixture — so the source itself is revalidated, identity and subtree, once the output is staged and before it is published: a source that moved underneath its copy has the output discarded and the item skipped as `changed-target`, and a torn copy is never put where somebody would take it for the real thing. An archive member is also held to exactly the length its tar header promised, so a file that grows or shrinks mid-archive fails the item rather than misaligning every header after it. The source is then revalidated once more immediately before it is disposed of, so anything written to it after the publish stops the disposal rather than being released unreviewed. Before that, the published name itself is made durable: the staged bytes, their modification time, and every directory of a staged tree are `fsync`ed before the publish, and the destination directory is `fsync`ed after it. A move publishes on one filesystem and removes from another, and nothing orders a crash's effect on one against the other, so without that last step a power cut could keep the source's removal and lose the name of its only copy. A destination that cannot be made durable keeps the source. Either way, "it arrived whole" is a statement rather than a hope. On failure, they preserve the source and remove what they staged. A source that cannot be disposed of after a successful publish is recorded as uncertain, not failed: the action half happened, and calling it a failure would invite a second run into a destination the first one has already filled. Hardlink replacement requires same-mount identical content and compatible ownership and metadata; it warns that later writes are shared. The plan names the copy it keeps rather than leaving it to entry order, because the operation is irreversible and "the first one" is the kind of implicit rule that puts the wrong file's inode on the releasing end of it. The helper proves the content identical by reading both files in full immediately before it links; a digest groups candidates and never authorises the replacement. The bytes compared are read through a descriptor checked to be the reviewed inode, and that descriptor stays open across the exchange: the exchange takes whatever is under the name at that instant, so before the swapped-out inode is released the helper checks it is the one that was compared, with the size and modification time it was reviewed with. An editor that saved over the file, or a program that wrote into it, after the compare has its version exchanged straight back and the item skipped as `changed-target`; nothing it wrote is released. See [adr/0006](adr/0006-content-identity-and-archive-dependencies.md).

Manager-owned state is changed only through scoped, fixed-argument manager adapters with probe, preview where supported, live preflight, apply, verification, permission mapping, and journal records. A manager may not provide exact item counts or byte savings; the UI must say so. An adapter never substitutes `rm -rf` for a missing manager.

## What a manager action does

A manager plan holds an action, its items, and its parameters. Its commands are derived
from those by the fixed templates in `src/domain/managers.ts` whenever the plan is read,
so editing a plan file can change which reviewed items are named and cannot change which
program runs or with which options; an item whose id could read as an option is refused.
Docker and Podman removals are never forced, so the engine refuses anything still in
use, and only volumes the engine marked anonymous are ever offered: a named volume no
container uses can still hold the only copy of a database. An old-kernel purge keeps the
running and the newest kernel, is offered only when a simulated removal takes exactly
the reviewed packages, and runs as `dpkg --purge` or `rpm -e`, which never remove
anything else. A release counts as a kernel only when its modules are installed under
`/lib/modules`, and `-unsigned`, `-dbg`, and `-dbgsym` packages count as the release
they name. Crash and temporary files go only where systemd-tmpfiles' own age rules send
them.

Apply preflights live: an item that is gone or in use again is skipped, and the whole
action is refused when a reviewed package is no longer an old kernel — it may be the
running or the newest one now — or a simulation no longer matches. A command stopped
while it ran is verified like one that finished, and a per-item command that exited
non-zero fails its item whatever a listing says. The executor journals through one helper session — the action and its items
before anything runs, each command's start before it is spawned and its exit after —
and asks the manager again afterwards what really went. A command that started and never
reported back is `uncertain` after reconciliation, and so is its action.

Only a root-privilege command is escalated, as `sudo -- /usr/bin/TOOL ARGS` (with `-n`
when nobody can answer a prompt) or, interactively without sudo, `pkexec`. A refused
password skips the rest of the action, is journalled, and makes the result partial; it
is never a reason to try another way.

## Running as root

Under EUID 0, Disktop starts only from a root-owned install: every entry of the
package, and every directory above it, must be owned by root and closed to other
accounts, or it refuses with `permission-denied`, because root running code an ordinary
account can change is that account running as root. Inside an unprivileged user
namespace, where EUID 0 has only its creator's power, this is not required. Running as
root, Disktop plans and applies no change to a file itself, the helper refuses every
user-file mutation from its side as well, and reconciliation releases nothing a crash
staged. Scans and listings work, which is
what an administrator's read-only per-user scan needs, and a reviewed manager action
still runs.

## What a crash leaves staged

The helper journals the device and inode of everything it stages — a partial copy, an
archive being written, the link a hardlink replacement exchanges — the moment the name
is created. When reconciliation finds an item a crash left uncertain, it removes that
staged name only if it still holds exactly that inode, the same thing a failed copy does
to its own output at runtime; anything else at that name is left in place and named in
the item's record.

A staging name has to be free when it is created — a file is created exclusively and a
directory with a `mkdir` that fails on `EEXIST` — so a name somebody took between the
check and the create is skipped for the next one rather than written into, published as
the copy, or removed when the item gives up. Directories in a copy are written with the
owner's permissions and take their own mode once everything inside them has arrived, so
a read-only directory such as a Go module cache's copies like any other. Taking back a
staged copy makes its directories writable first, because Disktop made them; a user's
own read-only directory is never made writable to get a removal through.

Every recursive removal — erasing a tree, emptying Trash, discarding a staged copy —
opens each directory it descends into without crossing a mount, so a filesystem mounted
inside a reviewed tree after review is refused rather than deleted through.

Before an irreversible removal starts — an erase, emptying Trash, or a move or compress
that removes its source permanently — the helper checks that this user may remove
entries from every directory in the tree and from the one holding it. Disktop never
changes permissions on a user's files to force a removal, so a tree with a read-only
directory inside it (a Go module cache is full of them) is refused whole, naming the
directory, instead of being removed up to that directory and no further. A move or
compress checks this before it copies anything.

## What an action checked afterwards

Every result carries a list of checks the apply made once the helper had finished. They
answer a different question from the helper's per-item outcomes: the helper says what it
did to each target, and this says whether the action as a whole did what the plan
described, asked from the side the plan is on.

A check that could not run is `unavailable` and never `passed`. "It was fine" and "nobody
could tell" are different answers and only one of them is evidence, which is the same
rule the free-space readings and the size bases follow. A `failed` check keeps the result
off `complete` whatever the helper reported, and `disktop clean apply` exits `3`.

An undo restores the source and stops there. A move or a compression also published
something, and that output is named in the result and left exactly where it was put:
removing it is a plan somebody reviews and confirms, not a side effect of undoing
something else.

## Privileges and recovery

Normal UI, scans, and user cleanup run unprivileged. A privileged manager action escalates only the reviewed adapter through a scoped `sudo` or `pkexec` invocation. The npm process is not run as root for cleanup. Explicit administrator scans may be read-only from a root-owned global install; EUID 0 disables generic mutation. Authentication failure is a permission result.

The helper records completed, skipped, failed, and remaining items after Ctrl+C or a process crash. `tests/recovery/journal.test.mjs` kills the real helper partway through a list of targets and asserts that the record never reads as complete, that no item is left claiming to be running once reconciliation has looked at it, and that nothing left its original path without the journal accounting for it. Tests for file deletion, Trash, undo, move, and compression run only in temporary sandboxes; mount tests use a namespace or VM.

There is a remaining Linux race when another actor with write access to the same parent directory swaps the final component between verification and operation. The implementation must minimize and test this window, and must refuse unsafe shared-writable parents. Do not claim perfect race elimination.
