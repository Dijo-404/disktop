# Native helper protocol

Status: version 1 is normative in [`schemas/native/v1/`](../schemas/native/v1/); the current Rust build implements `hello` and `probe` only. It reports `buildChecksum: null` for development builds unless a build checksum is injected, and returns `unsupported-operation` for every recognized planned scan or action operation. It cannot scan, index, hash, mutate, or journal files. `schemas/native/v1/request.json` and `event.json` are the normative wire contract, validated by `tests/contract/native-schema.test.mjs` and, against the real process, by `tests/integration/native.test.mjs`. The operation list there is complete for `1.0.0`; argument schemas exist for `hello`, `probe`, `cancel`, `scan`, `query-index`, `trash`, `erase`, `empty-trash`, and `journal-reconcile`, result schemas for `hello`/`probe`, `scan`, and `query-index`, and the remaining planned operations narrow their `arguments` in the phase that implements them.

## Transport and negotiation

Node will start the matching bundled `disktop-fs` child with `spawn`, never a shell command. The current helper exchanges one JSON object per line over stdin and stdout. Stdout is reserved for protocol messages; stderr carries diagnostics only. The client should start with `hello`; the scaffold also accepts a standalone `probe` request. Both currently return helper version, build checksum or `null`, platform, architecture, an `openat2` kernel probe, and `supportedOperations: ["hello", "probe"]`. Release packaging must supply and verify a real checksum. An incompatible protocol or packaged binary will surface a capability error rather than silently continuing.

Every request carries a protocol version, unique request ID, operation, and validated arguments. The scaffold emits one `complete` or `error` event per request, echoes a valid request ID, rejects unknown top-level fields and versions, and distinguishes recognized but unimplemented operations from unknown ones. The complete protocol will add `accepted`, `progress`, and `item-result` events. Malformed base64 paths and out-of-range integers must be rejected when path operations arrive. The v1 schemas will fix the exact field names and limits for those operations.

Cancellation is the `cancel` operation, whose argument is the request ID to stop; the current build recognizes it and answers `unsupported-operation`. The helper will stop at a safe item boundary, flush its journal where applicable, and emit a final incomplete result. Process termination or a broken pipe must leave a record that startup reconciliation can inspect. The client must not treat a missing final event as success.

## Path and number encoding

Linux paths are byte sequences. Future path requests will send raw path bytes as base64, and the UI will receive a sanitized display form separately. The helper must never resolve a mutation target from a display string. Filenames in the planned SQLite index must remain byte-accurate, including invalid UTF-8 and control bytes.

Device and inode IDs, counts, byte sizes, and nanosecond timestamps will cross IPC as base-10 strings. JavaScript may parse them as `BigInt` but must not convert them to imprecise `number` values. An entry will record allocated and apparent bytes separately. A mutation target will carry an expected `{device, inode, mount, type, size, mtime}` fingerprint and a stored reviewed plan ID.

## Current and planned operations

| Group | Operations | Responsibility |
| --- | --- | --- |
| Current scaffold | `hello`, `probe` | Version, platform, checksum field, supported-operation list, and `openat2` capability probe only. |
| Control | `cancel` | Stop a named in-flight request at a safe item boundary; the cancelled request still emits a final event. |
| Planned read | `scan`, `query-index`, `hash-candidates`, `inspect` | Bounded traversal, paginated SQLite queries, duplicate pipeline, live metadata. |
| User-file actions | `trash`, `restore`, `erase`, `copy-move`, `compress`, `dedup-hardlink`, `empty-trash` | Recheck plan and target, perform constrained action, journal per-item outcome. |
| Manager journal | `manager-begin`, `manager-append`, `manager-finish` | Record intent, progress, command result, and verification for a fixed-argument Linux manager adapter. The helper does not invent or execute manager commands. |
| Recovery | `journal-reconcile` | Resolve interrupted records into honest completed, partial, or uncertain states. |

The planned scanner will use fd-relative traversal, never follow symlinks, and stay within the selected filesystem by default, including bind mount boundaries. It will stream progress and inaccessible counts. Its detailed index will use SQLite pages; Node will request filtered or sorted pages instead of loading the entire tree. The helper will own partial/full hashing and final byte comparison for duplicates.

## Mutation invariants

Before an operation is implemented, the helper must validate the reviewed plan, protected paths, mount identity, parent directory safety, expected fingerprint, and destination no-overwrite behavior. It must use required Linux path-resolution features and refuse an action if they are unavailable. It will write intent and outcome records durably as the only action-history writer. A successful action response without a corresponding durable journal outcome will be a protocol violation.

The action result must distinguish selected bytes, bytes moved to Trash, observed free-space change, completed/skipped/failed counts, and undo eligibility. A manager may only provide estimates or unknown item counts; those are never promoted to exact numbers. See [safety.md](safety.md) for the action sequence and recovery rules.

## Contract tests

The scaffold's Rust tests exercise the `hello` handshake, `probe` argument rejection, protocol mismatch, unknown fields, oversized requests, and explicit rejection of a `trash` request. The integration smoke test starts the helper process and checks this boundary. These tests do not exercise filesystem traversal or mutation.

Contract fixtures should cover handshake mismatch, unknown fields, malformed lines, invalid base64 and UTF-8 bytes, large decimal integers, interleaved progress, cancellation, missing final events, changed targets, and restart reconciliation. CLI and helper schemas must be versioned together with deliberate migrations when persistent plans or journal records change.
