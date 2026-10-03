# Native helper protocol

Status: version 1 is normative in [`schemas/native/v1/`](../schemas/native/v1/) and the current Rust build implements every operation in it: the reads `hello`, `probe`, `scan`, `query-index`, `hash-candidates`, and `inspect`; `cancel`; the user-file actions `trash`, `erase`, `empty-trash`, `restore`, `dedup-hardlink`, `copy-move`, and `compress`; the manager journal operations `manager-begin`, `manager-append`, and `manager-finish`; and the recovery operation `journal-reconcile`. It reports `buildChecksum: null` for development builds unless a build checksum is injected, and answers `unknown-operation` for anything else. `schemas/native/v1/request.json` and `event.json` are the normative wire contract, validated by `tests/contract/native-schema.test.mjs` and, against the real process, by `tests/integration/native.test.mjs`.

## Transport and negotiation

Node will start the matching bundled `disktop-fs` child with `spawn`, never a shell command. The current helper exchanges one JSON object per line over stdin and stdout. Stdout is reserved for protocol messages; stderr carries diagnostics only. The client should start with `hello`; the scaffold also accepts a standalone `probe` request. Both currently return helper version, build checksum or `null`, platform, architecture, an `openat2` kernel probe, and `supportedOperations: ["hello", "probe"]`. Release packaging must supply and verify a real checksum. An incompatible protocol or packaged binary will surface a capability error rather than silently continuing.

Every request carries a protocol version, unique request ID, operation, and validated arguments. A fast operation emits one `complete` or `error` event. A scan emits `accepted`, then `progress` while it walks — after 4,096 entries or 250 ms, whichever comes first, and never more than ten a second however fast the walk reads — then exactly one `complete` carrying its totals; `item-result` arrives with the action operations. Event IDs are monotonic from 1 per request, every event echoes a valid request ID, and unknown top-level fields and versions are rejected. A scan runs on its own thread so that `cancel` can be read and acted on while it is still walking, and every event goes out through one lock, so two requests never interleave inside a line. Malformed base64 paths and out-of-range integers must be rejected when path operations arrive. The v1 schemas will fix the exact field names and limits for those operations.

Cancellation is the `cancel` operation, whose argument is the request ID to stop. The helper stops the named scan at a directory boundary, closes its handles, writes the totals it did gather, and emits a `complete` event with `complete: false` and a `cancelled` warning. A request ID that is not in flight answers `unknown-request` rather than succeeding silently. Closing stdin means the client has gone away: every running scan is cancelled the same way and then waited for, so each one still emits its final event. Process termination or a broken pipe must leave a record that startup reconciliation can inspect. The client must not treat a missing final event as success.

## Path and number encoding

Linux paths are byte sequences. Future path requests will send raw path bytes as base64, and the UI will receive a sanitized display form separately. The helper must never resolve a mutation target from a display string. Filenames in the planned SQLite index must remain byte-accurate, including invalid UTF-8 and control bytes.

Device and inode IDs, counts, byte sizes, and nanosecond timestamps will cross IPC as base-10 strings. JavaScript may parse them as `BigInt` but must not convert them to imprecise `number` values. An entry will record allocated and apparent bytes separately. A mutation target will carry an expected `{device, inode, mount, type, size, mtime}` fingerprint and a stored reviewed plan ID.

## Current and planned operations

| Group | Operations | Responsibility |
| --- | --- | --- |
| Handshake | `hello`, `probe` | Version, platform, checksum field, supported-operation list, and `openat2` capability probe only. |
| Control | `cancel` | Stop a named in-flight request at a safe item boundary; the cancelled request still emits a final event. |
| Implemented read | `scan`, `query-index`, `hash-candidates`, `inspect` | Bounded `openat2` traversal into a SQLite index, keyset-paginated pages out of it, the staged duplicate pipeline over it, and a digest of everything below a reviewed directory. |
| Implemented actions | `trash`, `erase`, `empty-trash`, `restore`, `dedup-hardlink`, `copy-move`, `compress` | Recheck plan and target, perform one constrained syscall or a staged and verified output, journal per-item outcome. |
| Manager journal | `manager-begin`, `manager-append`, `manager-finish` | Record a manager action's commands and reviewed items before anything runs, each command's start before it is spawned and its exit status after, and every item's outcome at the end. The helper never runs a manager command. |
| Recovery | `journal-reconcile` | Resolve interrupted records into honest completed, partial, or uncertain states, and return a page of history. Reconciling and listing are one operation because a caller that could list without reconciling would read a history still claiming an abandoned action is running. |

The scanner opens each directory with `openat2` and `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS`, adding `RESOLVE_NO_XDEV` unless `crossFilesystems` is set, so a symlink, a `..`, a procfs magic link, or a bind mount of the same filesystem cannot move it out of the subtree it was given. There is no fallback that drops those guarantees: a kernel that refuses `openat2` gets `unsupported-kernel` and no scan. It holds one open directory stream per level, so its descriptors and memory follow the tree's depth rather than its entry count, and it aggregates each directory on the way back up so a listing can rank directories by subtree size without a second pass.

Bytes are attributed once per `(device, inode)`. A second hardlink is indexed with `shared: true` and its bytes reported as `sharedBytes` instead of being added to the totals. A directory that cannot be opened is counted and named; it is never rolled up as zero. One that was there when its entry was read and gone — or no longer a directory, or `ESTALE` on a network mount — when the walk opened it is not unreadable: it is reported as `changed-during-scan`, the result is marked incomplete, and the walk goes on.

`indexDirectory` arrives with each `scan` and `query-index` request rather than being derived inside the helper: a query commonly runs in a different helper process from the scan that wrote the index, and duplicating the XDG rules in Rust would let them drift from `src/storage/xdg.ts`. The index stores names as `BLOB` bytes with a separate normalized searchable column and a parent ID instead of a repeated absolute path; paths are rebuilt one page at a time when a query asks for them. It is bounded by a scan count and a byte budget, and prunes whole scans rather than accumulating them. The index names every file below a scan root, including those in directories nobody else may list, so the helper creates its directory `0700` and its files `0600`.

Each scan is its own SQLite file under `index-v3/` in the index directory. A scan appends its rows to `<scanId>.sqlite.partial`, a table with no secondary index, with no rollback journal and no `fsync` per commit: nothing reads that file and a crash leaves one that is discarded rather than recovered. When the walk ends — finished or cancelled — the helper builds the indexes once over the whole table, writes the totals, `fsync`s the file, and renames it to `<scanId>.sqlite`, after which nothing writes to it again. A query opens that file read-only, so a reader of one scan never waits on the writer of another, and a scan that was never published is never served. Pruning removes whole files, so a pruned scan's space returns to the filesystem at once. The writer holds an exclusive `flock` on its partial file for its whole life; a later scan removes a partial file only when it can take that lock itself, which is how a scan another process is still writing is told from one whose writer died. The single shared `index-v1.sqlite` earlier builds wrote is removed when a scan begins. A `scanId` names a file here, so the helper refuses one that does not match the contract's pattern rather than trusting that the client checked it.

A page is read through an index for each shape a surface asks for, and the helper chooses which rather than leaving SQLite to guess, because the subtree filter is a primary-key range whose width SQLite cannot see. One directory's children (`parentId`) come from an index per sort order, so a page costs its own rows whatever the directory holds. A subtree (`underPath`) of fewer than fifty thousand rows is read as a range and sorted; a larger one, or the whole scan, walks the sort index until the page is full, unless a filter would leave that walk passing over most of the index. Both aggregates read a covering index. A cursor is a row value, so page fifty costs what page one does. Name search (`nameContains`) and the `find empty`, `find broken`, and `find stale` filters read their range in full — about 60 ms per million rows — because no index can answer a substring or a rare flag from a sorted position.

`atPath` restricts a page to the one row at exactly that path. A subtree's first row is the path's own, but a listing sorted by size or time cannot be trusted to put it first: a directory whose own inode holds no blocks, as on Btrfs, ties with the files below it, and the tie-break follows the sort order into the subtree. A path the scan never saw is refused exactly as `underPath` refuses one. Browsing a directory is therefore one `atPath` query for its row and `id`, then `parentId` pages in whichever order the person chose.

`hash-candidates` reads that index and then reads content, which is why it runs on its own thread and answers `cancel` like a scan does. It is a three-stage funnel. SQL groups regular files by apparent size and returns only the sizes with more than one member, so a file with no possible twin is never opened. Each surviving group is narrowed by a digest of its first and last 64 KiB, and each group that survives that is narrowed again by a digest of every byte. Rows the index marked `shared` are excluded at the query, and two names reaching one inode collapse to one member, because removing the second frees nothing. Each candidate is opened read-only through the same descent a mutation makes — from `/`, one segment at a time, never following a symlink — and the descriptor's own identity is what the result reports, so the group describes the files that are there now rather than the ones the scan remembered.

The digests group candidates. They never authorise anything: an operation that releases one copy of something because another copy exists re-opens both files and compares them byte for byte first. [ADR 0006](adr/0006-content-identity-and-archive-dependencies.md) records why the line is drawn there. A result with `complete: false` carries a warning saying what it missed — a cap it hit, a file it could not read, or a cancellation.

## Manager actions

Node runs a manager command; the helper only records it, so the journal stays
the one record a crash is judged against. `manager-begin` writes the action,
its commands in order, and the items the plan reviewed, in one transaction, and
answers with the action's id. `manager-append` with `phase: "started"` is
written before Node spawns that command and `phase: "finished"` after, with its
exit status and the tail of what it printed. `manager-finish` records what
became of every reviewed item, plus anything the manager removed of its own
choosing (`observed`), and closes the action: `complete` only when every item
completed and every command finished with status 0, `partial` otherwise.

Only the helper process that began an action may append to or finish it, and
Node keeps that one process open for the whole action. If it dies in between,
reconciliation marks a command that started and never finished `uncertain`,
and the action with it: the command may or may not have run, and nothing here
guesses which. The helper validates every tool against its own copy of the
manager tool list and refuses an argument or item holding a control byte.

## Mutation invariants

Every implemented action runs one sequence: classify the target against the
protected-path policy the helper holds independently of Node, resolve its parent one
segment at a time from `/` with `openat2`, `RESOLVE_BENEATH` and `RESOLVE_NO_SYMLINKS`,
compare the live entry against the reviewed fingerprint, write the item's intent
durably, perform one constrained syscall, write the outcome, and emit `item-result`.
An item that fails a step stops at that step; the next item begins. The helper refuses
the whole request when `openat2` is unavailable, when the mount table cannot be read,
or when the invoking user's home directory cannot be resolved — each of those refuses
every target rather than none.

Identity is the device, inode, type, size, and modification time. `mountId` travels
with them as context and is not compared: a client cannot read `stx_mnt_id` through a
filesystem API and would be sending a number it invented. Nothing is lost by leaving
it out, because a filesystem swapped under the parent has a different device number
and a bind mount of the same filesystem reaching the same inode is the same file.

A parent directory any user can write to without a sticky bit is refused outright:
owning such a directory does not stop anyone else renaming entries inside it, so there
is no version of the check that wins that race.

The helper writes intent and outcome records durably as the only action-history
writer, with `synchronous = FULL`, because this file is the record a crash is judged
against. A successful action response without a corresponding durable journal outcome
is a protocol violation, and `src/native/protocol.ts` refuses such a result rather
than returning it.

The action result distinguishes selected bytes, bytes moved to Trash, the free-space
readings before and after, completed/skipped/failed counts, and undo eligibility.
Bytes are the plan's own measurement partitioned by outcome, not a fresh total: the
helper renames a subtree in one syscall and does not walk it to re-measure what it is
about to move. The free-space readings are the real observation beside it. A manager
may only provide estimates or unknown item counts; those are never promoted to exact
numbers. See [safety.md](safety.md) for the action sequence and recovery rules.

### Replacing a duplicate with a hardlink

`dedup-hardlink` validates the kept file once, before any item: it is what every target
becomes, so a kept file that is not what the plan reviewed makes the whole request wrong
rather than one item of it. Its descriptor is then held open for the whole action, which
is what makes the comparison below mean something — the bytes compared are the bytes of
the inode that gets linked, not of whatever the kept path names a moment later.

Each item is checked in a fixed order and stops at the first thing that fails. Identity
comes before content: a name that already reaches the kept inode is `skipped` with
`already-linked`, because removing it would free nothing. A target on another device is
refused with `different-filesystem`; a hardlink cannot cross one. Owner, group, and
permissions must match, because one inode has one set of them and linking would silently
change the target's — a mismatch is `metadata-incompatible`. Then both files are read in
full and compared byte for byte; anything else is `content-changed`. The digests that
grouped these files said they were probably identical, and probably is not a basis for
releasing somebody's only copy of something.

The replacement itself is a staged link and a `RENAME_EXCHANGE`. The helper links the
kept file to `.disktop-link-<pid>-<n>` in the target's own directory, exchanges that name
with the reviewed one, and unlinks the staging name — which is the step that releases the
old inode and the step that cannot be taken back. The reviewed name never points at
nothing: before the exchange it holds the old inode, after it the kept one. A filesystem
that cannot exchange two names atomically is refused with `unsupported-filesystem` rather
than served by a sequence with a window where the name is gone.

A completed item reports the bytes it freed, which is zero when the replaced file had
another name of its own: only the last name to an inode frees anything. The result's
bytes-moved-to-Trash is always zero and undo is never available, because nothing moved
anywhere.

### Moving to another disk

`copy-move` validates the destination once, before any item: it is where
everything lands, so a destination that is not a directory this user can open
makes the whole request wrong rather than one item of it. The helper applies its
own `classify_destination`, the mirror of `classifyDestination` in
`src/domain/protected-paths.ts` — a protected system root, a shared container root
itself, or Disktop's own state is refused here as well as in Node, because the
helper takes nobody's word for a path.

Each item also refuses before it starts when the destination's filesystem has less
free space than the plan measured for it. The reading is a moment in time and
something else may take the space anyway, which is why the copy still cleans up
after itself; what it avoids is a copy that fills a filesystem for every other
process on the machine before unwinding.

Each item then runs a fixed sequence, and every step before the last leaves the
source exactly where it was. The destination name is checked, the copy is staged
as `<name>.disktop-partial-<pid>-<n>`, the bytes are streamed and digested as
they are read, the staged file is `fsync`ed and read back and digested again,
and the two digests are compared. A mismatch — a short write, a dropped block, a
file that changed under the read — removes what was staged and fails the item.
Permissions and the modification time come across, so the copy is the same file
rather than a new one made today.

Publishing is `renameat2` with `RENAME_NOREPLACE`. The name is checked before
the copy starts, which makes a collision cheap, and the publish decides, which
makes it correct: a name created while the copy was running fails the item and
leaves what somebody else made alone.

Only after the publish is the source touched, and the source is revalidated once
more immediately before it is. The check at the start of the item was made before
a copy that may have run for a long time, and anything written to the source while
it ran is in neither the copy nor the plan; disposing of it on the strength of the
earlier check would release bytes nobody reviewed. `sourceDisposition` decides how:
`trash` reuses the Trash move, so the bytes are reported as moved to Trash and
undo is available; `permanent` removes it outright and neither is. A source that
cannot be disposed of after a successful publish is `uncertain` rather than
`failed`, because the action half happened and calling it a failure would invite
a second run into a destination the first one has already filled.

A tree is copied with the same descent the scanner uses — `openat2` with
`RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV` — so a nested mount
inside the source stops the copy rather than quietly pulling another filesystem
across, and a symlink is copied as the link object it is, with exactly the bytes
it held. A socket, device node, or fifo stops the item: making a different
object with the same name would be worse than saying it was not copied.

### Compressing

`compress` has the move's shape — stage, verify, publish without overwriting,
and only then touch the source — and differs in one place: the verification.
A copy is checked by reading the written bytes back off the device. An archive
is checked by *decompressing* it, the way anybody recovering from it would, and
comparing what comes out against what went in. An archive that will not read
back is not an archive, however well the write went.

The digest is taken over the tar stream itself, before compression, so it covers
every header and every byte of every member. An entry count would not: a file
rewritten to the same length while the archive was being built keeps the stream
well-formed and the count identical, and the archive would hold a torn copy that
verified. The decompressed archive is also walked as a tar, so a malformed member
is found here rather than by somebody who needed it later.

An archive holds everything that was inside the source, including whatever was
private in there, so it is published 0600 rather than with the source directory's
own mode. A 0755 directory holding a 0600 secret must not become a 0755 file
holding that secret's bytes.

A regular file becomes `<name>.zst` and a directory becomes `<name>.tar.zst`.
`destinationDirectory` may be the empty string, which means beside the source —
where somebody would put an archive by hand. A tree is walked with the same
containment the copier uses, so a nested mount stops the item and a symlink is
stored as a link object holding exactly the bytes it held.

### What a restorable action records

`trash`, and a `copy-move` or `compress` whose plan said `trash`, all leave the
original in Trash, and all record the item's destination as **where the source
went** rather than where any output was published. That is what `restore` reads
to find the original again. A `permanent` disposition records no Trash
destination, so a restore of it finds nothing to bring back and says so rather
than inventing a path.

## Contract tests

The Rust tests exercise the `hello` handshake, `probe` argument rejection, protocol mismatch, unknown fields, oversized requests, explicit rejection of an operation this build does not implement, traversal over sandbox trees with hardlinks, symlinks, unreadable directories and names that are not valid UTF-8, index paging and filters, a live cancellation that still produces a queryable index, the duplicate funnel over a tree holding a matched pair, a lone file in its size class, two names for one inode, and two files whose ends match and whose middles do not, and every implemented action: a Trash move with its metadata, a name collision that keeps both files, a changed target that is skipped, a protected root that is refused, a recursive erase that removes a symlink without following it, emptying a directory that is shaped like a Trash and refusing one that is not, a restore that refuses to overwrite whatever now occupies the original path, a hardlink replacement over files that differ in their last byte, in their permissions, and in their inode, and a move that copies a tree with its links intact, refuses an occupied destination name, and leaves its source alone whenever it cannot publish.

`tests/integration/scan.test.mjs` drives the real binary through the CLI against fixture trees, compares allocated totals against `du -x`, and proves a bind mount is not descended into. `tests/integration/actions.test.mjs` does the same for the action pipeline, including that bytes moved to Trash and observed free-space change are reported as distinct values. `tests/recovery/journal.test.mjs` kills the helper mid-action and reads the journal back.

Contract fixtures should cover handshake mismatch, unknown fields, malformed lines, invalid base64 and UTF-8 bytes, large decimal integers, interleaved progress, cancellation, missing final events, changed targets, and restart reconciliation. CLI and helper schemas must be versioned together with deliberate migrations when persistent plans or journal records change.
