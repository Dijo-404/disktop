# Architecture

Status: the architecture of the `1.0.0` release candidate, enforced by the lint rules below. [PLAN.md](../PLAN.md) is the product scope and acceptance checklist; this document explains where code belongs and why.

## Dependency direction

```text
bin  ──builds──>  composition  ──constructs──>  Linux adapters, providers,
 │                                              storage, native client
 └──runs──>  CLI / TUI / reports                         │
                    |                                    v
                    v                            implement ports
        application use cases --> domain models and policy
                    |                                    ^
                    └──────────> ports ──────────────────┘
                                          native client ──> Rust disktop-fs helper
```

`src/domain` contains data types, sizes, path representation, action policy, and errors without I/O. `src/ports` defines the interfaces an application use case needs. `src/application` coordinates inventory, scan, findings, snapshots, action planning, application, undo, and alerts. `src/cli` and `src/tui` call those use cases, and `src/reports` renders what they return. None of them may import a Linux command adapter or the native client to perform a feature directly. The TUI receives its services as one `TuiServices` value (`src/tui/services.ts`), the same services the CLI handlers receive, and its views are pure functions from state to a frame; only `src/tui/render.ts` talks to the terminal.

`src/composition` is the composition root and the only layer permitted to construct an adapter. It imports no surface, and `src/bin` imports it rather than reaching a platform module itself. Every other layer receives what it needs as an argument, which is what makes the prohibitions below enforceable rather than aspirational: if no surface can build an adapter, no surface can quietly use one.

The dependency direction is enforced by the layer rules in `eslint.config.mjs` and checked by `tests/unit/dependency-rules.test.mjs`, not by review alone: domain imports nothing outside itself, application reaches adapters only through a port, CLI/TUI/reports cannot import the native client or a Linux adapter or spawn a process, the composition root cannot import a surface, and a provider can neither run a command nor import a destructive filesystem call.

The destructive-call rule is anchored to a call's callee. Refusing every property named `rm` would also refuse reading lsblk's removable column, and a rule that fires on data teaches people to route around it rather than to respect it.

`src/platform/linux` implements device, mount, capacity, package, diagnostic, manager, and notification adapters. `src/providers` discovers user-facing findings, particularly development environments, caches, and large application data. `src/storage` owns Disktop's own config, compact snapshots, cached projections, and stored plan metadata. `src/native` communicates with the bundled Rust child process. Linux implementations belong behind ports so the boundary can host a future platform adapter; macOS behavior is outside the Linux `1.0.0` release.

## Why there is a Rust helper

Arbitrary-path traversal and mutation need byte-accurate Linux filenames, bounded memory, descriptor-relative path handling, and a single durable journal. `native/disktop-fs` owns those operations, the detailed SQLite index, and duplicate hashing. Node starts it with `spawn` and fixed arguments, then exchanges versioned JSON Lines over pipes. The helper is a child process, not a daemon, npm native addon, or installer-time build step.

Node may write its own config, snapshots, reports, scan cache metadata, and user timer units. The Rust journal is the **sole durable writer of action history**, including manager-backed operations. The application service is the only entry point that commits a reviewed action plan. Providers only propose findings and plans.

## Data flow by user task

| Task | Flow | Persistent data |
| --- | --- | --- |
| Device dashboard | `lsblk -J -b`, `/proc/self/mountinfo`, and `statfs` joined by the Linux inventory adapter, through `InventoryPort` to `application/dashboard.ts`, to the CLI or TUI | Optional cached view. |
| Tree exploration | `application/scan.ts` through `ScanPort` to the helper's `openat2` walk and SQLite index; `application/explore.ts` through `FileIndexPort` to keyset-paginated `query-index` pages | Current detailed SQLite scan index under `$XDG_CACHE_HOME`, bounded by scan count and byte budget; compact snapshots under `$XDG_DATA_HOME` for growth. |
| Footprint finding | Detectors in `src/providers` name paths through `PathProbe`, `ToolPort`, `IndexSearchPort` and `PackageInventoryPort`; `application/footprint.ts` merges them and measures every unmeasured path in one pass through `FootprintPort`, which runs a single helper scan into an index of its own and reads each path's own row there | Findings can be recomputed; selected plan is stored separately. Measuring scans never count against `keep_scans`, so they never evict a scan somebody is exploring. |
| Cleanup | Provider or explicit path to immutable plan, confirmation, revalidation, helper or fixed-argument manager adapter, journal, verification | Expiring reviewed plan and durable native journal. |
| Report | Application query to JSON/CSV/HTML renderer | Only an explicitly requested output file. |

Scans stream progress and can end incomplete. The detailed index stays disk-backed so Node memory does not grow with every file; [adr/0002](adr/0002-native-helper-and-index.md) records the measurements. Snapshots hold directory aggregates and top entries, not copies of all indexed files. Compare snapshots only when root, filesystem identity, excludes, accounting mode, and mount policy match; `application/snapshots.ts` refuses anything else and names every reason, because subtracting two different scopes produces a number that reads exactly like real growth.

Cancellation runs the same way at every layer. The CLI turns Ctrl+C into an `AbortSignal`, the native client sends `cancel` by request ID and keeps reading, and the helper stops at a directory boundary and emits its final event. A partial result is reported as partial with the reason; it is never returned as a smaller tree, and a missing final event is never read as success.

## Shared contracts

- `RawPath` keeps original bytes as base64 and sanitized display text separately. Display text is never a mutation target. Filenames in the index are stored as bytes.
- Every filesystem identity, count, byte value, and nanosecond timestamp crossing native IPC or public JSON is a decimal string. Internal arithmetic uses integers without JavaScript number rounding.
- `Device`, `Partition`, `Filesystem`, and `Mount` are separate concepts. `lsblk` topology, mountinfo, and `statfs` answer different questions.
- `Entry` distinguishes allocated from apparent bytes and carries device, inode, mount, link count, owner, and timestamps. Hardlinks count once per scan total.
- `Finding` includes a stable provider ID and version, category, evidence, scope, a labelled size, confidence, capability, and proposed action IDs. `size.basis` is mandatory and has no value meaning "zero because nobody looked": an unmeasured footprint is `unknown` and carries no number. Two detectors reaching the same directory merge, so an estimate is never doubled.
- `ActionPlan` is immutable, operation-specific, expiring, and revalidated when applied. `ActionResult` separates selected bytes, moved-to-Trash bytes, and observed capacity change.
- `Capability` must state whether a feature is available or why it is unavailable. Missing tools and permissions are not represented as zero findings.

The public CLI schema is under `schemas/cli/v1/` and the helper schema under `schemas/native/v1/` as those contracts are implemented. A change to either requires contract tests and an explicit compatibility decision. See [native-protocol.md](native-protocol.md), [providers.md](providers.md), and [safety.md](safety.md).

## Implementation handoff

For a feature, identify its owning folder, port and schema effects, capability behavior, reversible or irreversible actions, incomplete-result behavior, fixture, and acceptance test. The matching [feature matrix row](../PLAN.md#feature-acceptance-matrix) is the release criterion. Code and documentation should change together.
