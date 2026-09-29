# Architecture

Status: design contract for the implementation scaffold. [PLAN.md](../PLAN.md) is the product scope and acceptance checklist. This document explains where code belongs as the tree is filled in.

## Dependency direction

```text
CLI / TUI / reports
        |
        v
application use cases --> domain models and policy
        |
        v
       ports <----------- Linux adapters, providers, storage, native client
                                                        |
                                                        v
                                                Rust disktop-fs helper
```

`src/domain` contains data types, sizes, path representation, action policy, and errors without I/O. `src/ports` defines the interfaces an application use case needs. `src/application` coordinates inventory, scan, findings, snapshots, action planning, application, undo, and alerts. `src/cli` and `src/tui` call those use cases. They must not import a Linux command adapter or the native client to perform a feature directly.

The dependency direction is enforced by the layer rules in `eslint.config.mjs` and checked by `tests/unit/dependency-rules.test.mjs`, not by review alone: domain imports nothing outside itself, application reaches adapters only through a port, CLI/TUI/reports cannot import the native client or a Linux adapter or spawn a process, and a provider can neither run a command nor import a destructive filesystem call.

`src/platform/linux` implements device, mount, capacity, package, diagnostic, manager, and notification adapters. `src/providers` discovers user-facing findings, particularly development environments, caches, and large application data. `src/storage` owns Disktop's own config, compact snapshots, cached projections, and stored plan metadata. `src/native` communicates with the bundled Rust child process. Linux implementations belong behind ports so the boundary can host a future platform adapter; macOS behavior is outside the Linux `1.0.0` release.

## Why there is a Rust helper

Arbitrary-path traversal and mutation need byte-accurate Linux filenames, bounded memory, descriptor-relative path handling, and a single durable journal. `native/disktop-fs` owns those operations, the detailed SQLite index, and duplicate hashing. Node starts it with `spawn` and fixed arguments, then exchanges versioned JSON Lines over pipes. The helper is a child process, not a daemon, npm native addon, or installer-time build step.

Node may write its own config, snapshots, reports, scan cache metadata, and user timer units. The Rust journal is the **sole durable writer of action history**, including manager-backed operations. The application service is the only entry point that commits a reviewed action plan. Providers only propose findings and plans.

## Data flow by user task

| Task | Flow | Persistent data |
| --- | --- | --- |
| Device dashboard | Linux inventory adapters to application dashboard to CLI/TUI | Optional cached view. |
| Tree exploration | Application scan to native helper to paginated index queries | Current detailed SQLite scan index; compact snapshots for growth. |
| Footprint finding | Providers and Linux package adapters to application footprint service | Findings can be recomputed; selected plan is stored separately. |
| Cleanup | Provider or explicit path to immutable plan, confirmation, revalidation, helper or fixed-argument manager adapter, journal, verification | Expiring reviewed plan and durable native journal. |
| Report | Application query to JSON/CSV/HTML renderer | Only an explicitly requested output file. |

Scans stream progress and can end incomplete. The detailed index stays disk-backed so Node memory does not grow with every file. Snapshots hold directory aggregates and top entries, not copies of all indexed files. Compare snapshots only when root, filesystem identity, excludes, and accounting mode match.

## Shared contracts

- `RawPath` keeps original bytes as base64 and sanitized display text separately. Display text is never a mutation target. Filenames in the index are stored as bytes.
- Every filesystem identity, count, byte value, and nanosecond timestamp crossing native IPC or public JSON is a decimal string. Internal arithmetic uses integers without JavaScript number rounding.
- `Device`, `Partition`, `Filesystem`, and `Mount` are separate concepts. `lsblk` topology, mountinfo, and `statfs` answer different questions.
- `Entry` distinguishes allocated from apparent bytes and carries device, inode, mount, link count, owner, and timestamps. Hardlinks count once per scan total.
- `Finding` includes stable provider ID, category, evidence, scope, estimate, confidence, capability, and proposed action IDs.
- `ActionPlan` is immutable, operation-specific, expiring, and revalidated when applied. `ActionResult` separates selected bytes, moved-to-Trash bytes, and observed capacity change.
- `Capability` must state whether a feature is available or why it is unavailable. Missing tools and permissions are not represented as zero findings.

The public CLI schema is under `schemas/cli/v1/` and the helper schema under `schemas/native/v1/` as those contracts are implemented. A change to either requires contract tests and an explicit compatibility decision. See [native-protocol.md](native-protocol.md), [providers.md](providers.md), and [safety.md](safety.md).

## Implementation handoff

For a feature, identify its owning folder, port and schema effects, capability behavior, reversible or irreversible actions, incomplete-result behavior, fixture, and acceptance test. The matching [feature matrix row](../PLAN.md#feature-acceptance-matrix) is the release criterion. Code and documentation should change together.
