# Native helper protocol

Status: version 1 is normative in [`schemas/native/v1/`](../schemas/native/v1/); the current Rust build implements the reads `hello`, `probe`, `scan`, `query-index`, and `cancel`, the user-file actions `trash`, `erase`, `empty-trash`, and `restore`, and the recovery operation `journal-reconcile`. It reports `buildChecksum: null` for development builds unless a build checksum is injected, and returns `unsupported-operation` for every planned operation it does not yet implement. It cannot hash files, run a manager, copy across devices, or compress. `schemas/native/v1/request.json` and `event.json` are the normative wire contract, validated by `tests/contract/native-schema.test.mjs` and, against the real process, by `tests/integration/native.test.mjs`. The operation list there is complete for `1.0.0`; argument schemas exist for every implemented operation, result schemas for `hello`/`probe`, `scan`, `query-index`, the actions, and the journal, and the remaining planned operations narrow their `arguments` in the phase that implements them.

## Transport and negotiation

Node will start the matching bundled `disktop-fs` child with `spawn`, never a shell command. The current helper exchanges one JSON object per line over stdin and stdout. Stdout is reserved for protocol messages; stderr carries diagnostics only. The client should start with `hello`; the scaffold also accepts a standalone `probe` request. Both currently return helper version, build checksum or `null`, platform, architecture, an `openat2` kernel probe, and `supportedOperations: ["hello", "probe"]`. Release packaging must supply and verify a real checksum. An incompatible protocol or packaged binary will surface a capability error rather than silently continuing.

Every request carries a protocol version, unique request ID, operation, and validated arguments. A fast operation emits one `complete` or `error` event. A scan emits `accepted`, then `progress` while it walks, then exactly one `complete` carrying its totals; `item-result` arrives with the action operations. Event IDs are monotonic from 1 per request, every event echoes a valid request ID, and unknown top-level fields and versions are rejected. A scan runs on its own thread so that `cancel` can be read and acted on while it is still walking, and every event goes out through one lock, so two requests never interleave inside a line. Malformed base64 paths and out-of-range integers must be rejected when path operations arrive. The v1 schemas will fix the exact field names and limits for those operations.

Cancellation is the `cancel` operation, whose argument is the request ID to stop. The helper stops the named scan at a directory boundary, closes its handles, writes the totals it did gather, and emits a `complete` event with `complete: false` and a `cancelled` warning. A request ID that is not in flight answers `unknown-request` rather than succeeding silently. Closing stdin means the client has gone away: every running scan is cancelled the same way and then waited for, so each one still emits its final event. Process termination or a broken pipe must leave a record that startup reconciliation can inspect. The client must not treat a missing final event as success.

## Path and number encoding

Linux paths are byte sequences. Future path requests will send raw path bytes as base64, and the UI will receive a sanitized display form separately. The helper must never resolve a mutation target from a display string. Filenames in the planned SQLite index must remain byte-accurate, including invalid UTF-8 and control bytes.

Device and inode IDs, counts, byte sizes, and nanosecond timestamps will cross IPC as base-10 strings. JavaScript may parse them as `BigInt` but must not convert them to imprecise `number` values. An entry will record allocated and apparent bytes separately. A mutation target will carry an expected `{device, inode, mount, type, size, mtime}` fingerprint and a stored reviewed plan ID.

## Current and planned operations

| Group | Operations | Responsibility |
| --- | --- | --- |
| Handshake | `hello`, `probe` | Version, platform, checksum field, supported-operation list, and `openat2` capability probe only. |
| Control | `cancel` | Stop a named in-flight request at a safe item boundary; the cancelled request still emits a final event. |
| Implemented read | `scan`, `query-index`, `hash-candidates` | Bounded `openat2` traversal into a SQLite index, keyset-paginated pages out of it, and the staged duplicate pipeline over it. |
| Planned read | `inspect` | Live metadata for one path. |
| Implemented actions | `trash`, `erase`, `empty-trash`, `restore` | Recheck plan and target, perform one constrained syscall, journal per-item outcome. |
| Planned actions | `copy-move`, `compress`, `dedup-hardlink` | Staged output, verification, and publication without overwrite. |
| Manager journal | `manager-begin`, `manager-append`, `manager-finish` | Record intent, progress, command result, and verification for a fixed-argument Linux manager adapter. The helper does not invent or execute manager commands. |
| Recovery | `journal-reconcile` | Resolve interrupted records into honest completed, partial, or uncertain states, and return a page of history. Reconciling and listing are one operation because a caller that could list without reconciling would read a history still claiming an abandoned action is running. |

The scanner opens each directory with `openat2` and `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS`, adding `RESOLVE_NO_XDEV` unless `crossFilesystems` is set, so a symlink, a `..`, a procfs magic link, or a bind mount of the same filesystem cannot move it out of the subtree it was given. There is no fallback that drops those guarantees: a kernel that refuses `openat2` gets `unsupported-kernel` and no scan. It holds one open directory stream per level, so its descriptors and memory follow the tree's depth rather than its entry count, and it aggregates each directory on the way back up so a listing can rank directories by subtree size without a second pass.

Bytes are attributed once per `(device, inode)`. A second hardlink is indexed with `shared: true` and its bytes reported as `sharedBytes` instead of being added to the totals. A directory that cannot be opened is counted and named; it is never rolled up as zero.

`indexDirectory` arrives with each `scan` and `query-index` request rather than being derived inside the helper: a query commonly runs in a different helper process from the scan that wrote the index, and duplicating the XDG rules in Rust would let them drift from `src/storage/xdg.ts`. The index stores names as `BLOB` bytes with a separate normalized searchable column and a parent ID instead of a repeated absolute path; paths are rebuilt one page at a time when a query asks for them. It is bounded by a scan count and a byte budget, and prunes whole scans rather than accumulating them.

`hash-candidates` reads that index and then reads content, which is why it runs on its own thread and answers `cancel` like a scan does. It is a three-stage funnel. SQL groups regular files by apparent size and returns only the sizes with more than one member, so a file with no possible twin is never opened. Each surviving group is narrowed by a digest of its first and last 64 KiB, and each group that survives that is narrowed again by a digest of every byte. Rows the index marked `shared` are excluded at the query, and two names reaching one inode collapse to one member, because removing the second frees nothing. Each candidate is opened read-only through the same descent a mutation makes — from `/`, one segment at a time, never following a symlink — and the descriptor's own identity is what the result reports, so the group describes the files that are there now rather than the ones the scan remembered.

The digests group candidates. They never authorise anything: an operation that releases one copy of something because another copy exists re-opens both files and compares them byte for byte first. [ADR 0006](adr/0006-content-identity-and-archive-dependencies.md) records why the line is drawn there. A result with `complete: false` carries a warning saying what it missed — a cap it hit, a file it could not read, or a cancellation.

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

## Contract tests

The Rust tests exercise the `hello` handshake, `probe` argument rejection, protocol mismatch, unknown fields, oversized requests, explicit rejection of an operation this build does not implement, traversal over sandbox trees with hardlinks, symlinks, unreadable directories and names that are not valid UTF-8, index paging and filters, a live cancellation that still produces a queryable index, the duplicate funnel over a tree holding a matched pair, a lone file in its size class, two names for one inode, and two files whose ends match and whose middles do not, and every implemented action: a Trash move with its metadata, a name collision that keeps both files, a changed target that is skipped, a protected root that is refused, a recursive erase that removes a symlink without following it, emptying a directory that is shaped like a Trash and refusing one that is not, and a restore that refuses to overwrite whatever now occupies the original path.

`tests/integration/scan.test.mjs` drives the real binary through the CLI against fixture trees, compares allocated totals against `du -x`, and proves a bind mount is not descended into. `tests/integration/actions.test.mjs` does the same for the action pipeline, including that bytes moved to Trash and observed free-space change are reported as distinct values. `tests/recovery/journal.test.mjs` kills the helper mid-action and reads the journal back.

Contract fixtures should cover handshake mismatch, unknown fields, malformed lines, invalid base64 and UTF-8 bytes, large decimal integers, interleaved progress, cancellation, missing final events, changed targets, and restart reconciliation. CLI and helper schemas must be versioned together with deliberate migrations when persistent plans or journal records change.
