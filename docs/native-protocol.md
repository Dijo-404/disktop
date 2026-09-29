# Native helper protocol

Status: version 1 is normative in [`schemas/native/v1/`](../schemas/native/v1/); the current Rust build implements the read operations `hello`, `probe`, `scan`, `query-index`, and `cancel`. It reports `buildChecksum: null` for development builds unless a build checksum is injected, and returns `unsupported-operation` for every recognized planned action operation. It cannot hash, mutate, or journal files. `schemas/native/v1/request.json` and `event.json` are the normative wire contract, validated by `tests/contract/native-schema.test.mjs` and, against the real process, by `tests/integration/native.test.mjs`. The operation list there is complete for `1.0.0`; argument schemas exist for `hello`, `probe`, `cancel`, `scan`, `query-index`, `trash`, `erase`, `empty-trash`, and `journal-reconcile`, result schemas for `hello`/`probe`, `scan`, and `query-index`, and the remaining planned operations narrow their `arguments` in the phase that implements them.

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
| Implemented read | `scan`, `query-index` | Bounded `openat2` traversal into a SQLite index, and keyset-paginated pages out of it. |
| Planned read | `hash-candidates`, `inspect` | Duplicate pipeline and live metadata. |
| User-file actions | `trash`, `restore`, `erase`, `copy-move`, `compress`, `dedup-hardlink`, `empty-trash` | Recheck plan and target, perform constrained action, journal per-item outcome. |
| Manager journal | `manager-begin`, `manager-append`, `manager-finish` | Record intent, progress, command result, and verification for a fixed-argument Linux manager adapter. The helper does not invent or execute manager commands. |
| Recovery | `journal-reconcile` | Resolve interrupted records into honest completed, partial, or uncertain states. |

The scanner opens each directory with `openat2` and `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS`, adding `RESOLVE_NO_XDEV` unless `crossFilesystems` is set, so a symlink, a `..`, a procfs magic link, or a bind mount of the same filesystem cannot move it out of the subtree it was given. There is no fallback that drops those guarantees: a kernel that refuses `openat2` gets `unsupported-kernel` and no scan. It holds one open directory stream per level, so its descriptors and memory follow the tree's depth rather than its entry count, and it aggregates each directory on the way back up so a listing can rank directories by subtree size without a second pass.

Bytes are attributed once per `(device, inode)`. A second hardlink is indexed with `shared: true` and its bytes reported as `sharedBytes` instead of being added to the totals. A directory that cannot be opened is counted and named; it is never rolled up as zero.

`indexDirectory` arrives with each `scan` and `query-index` request rather than being derived inside the helper: a query commonly runs in a different helper process from the scan that wrote the index, and duplicating the XDG rules in Rust would let them drift from `src/storage/xdg.ts`. The index stores names as `BLOB` bytes with a separate normalized searchable column and a parent ID instead of a repeated absolute path; paths are rebuilt one page at a time when a query asks for them. It is bounded by a scan count and a byte budget, and prunes whole scans rather than accumulating them. The helper still owns partial and full hashing and final byte comparison for duplicates, which are not implemented yet.

## Mutation invariants

Before an operation is implemented, the helper must validate the reviewed plan, protected paths, mount identity, parent directory safety, expected fingerprint, and destination no-overwrite behavior. It must use required Linux path-resolution features and refuse an action if they are unavailable. It will write intent and outcome records durably as the only action-history writer. A successful action response without a corresponding durable journal outcome will be a protocol violation.

The action result must distinguish selected bytes, bytes moved to Trash, observed free-space change, completed/skipped/failed counts, and undo eligibility. A manager may only provide estimates or unknown item counts; those are never promoted to exact numbers. See [safety.md](safety.md) for the action sequence and recovery rules.

## Contract tests

The Rust tests exercise the `hello` handshake, `probe` argument rejection, protocol mismatch, unknown fields, oversized requests, explicit rejection of a `trash` request, traversal over sandbox trees with hardlinks, symlinks, unreadable directories and names that are not valid UTF-8, index paging and filters, and a live cancellation that still produces a queryable index. `tests/integration/scan.test.mjs` drives the real binary through the CLI against fixture trees, compares allocated totals against `du -x`, and proves a bind mount is not descended into. They do not exercise mutation, which does not exist.

Contract fixtures should cover handshake mismatch, unknown fields, malformed lines, invalid base64 and UTF-8 bytes, large decimal integers, interleaved progress, cancellation, missing final events, changed targets, and restart reconciliation. CLI and helper schemas must be versioned together with deliberate migrations when persistent plans or journal records change.
