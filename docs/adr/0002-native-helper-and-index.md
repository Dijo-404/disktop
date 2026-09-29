# ADR 0002: Rust child process and the disk-backed index

Status: accepted

## Context

Scanning a home directory means millions of entries, filenames that are byte strings
rather than text, containment that must hold across bind mounts and symlinks, and
mutations that must be journalled durably. Node's `fs` API works in strings by default,
JavaScript numbers lose precision above 2^53, and holding one object per entry in the
heap makes memory grow with the tree.

## Decision

A single bundled Rust executable, `disktop-fs`, owns fd-relative traversal with
`openat2` containment, the detailed file index, hashing, mutation of user files, and the
sole durable action journal. Node spawns it with `spawn` and fixed arguments — never a
shell string — and exchanges one JSON object per line over pipes, as defined by
`schemas/native/v1/`. It is a child process: not a daemon, not an npm native addon, and
not compiled during `npm install`.

The index is SQLite inside the helper. Names are stored as BLOB bytes with a separate
normalized searchable column, parents are referenced by ID rather than by repeating full
paths, and size, extension, timestamp, and owner are indexed. Node asks for filtered,
sorted, paginated results; it never receives the whole tree.

## Consequences

Node memory is a function of page size, not entry count, which is what makes the budget
below enforceable. The cost is a second toolchain, a wire protocol to version, and four
binaries to build and verify per release (ADR 0003). A process boundary also means
cancellation and crash recovery are protocol concerns: a missing final event is never
read as success, and an interrupted action is reconciled from the journal at startup.

`node:sqlite` is not used. Its Node 24 API is still a release candidate, and putting the
index in Node would defeat the memory property this decision exists for.

**Budget, measured in Phase 2.** On a one-million-entry reference tree from
`tests/fixtures/generate.mjs`, built from a release helper and measured by
`tests/performance/scan-memory.test.mjs`:

| Figure | Budget | Observed |
| --- | --- | --- |
| Node peak RSS | under 256 MiB, flat in entry count | 66.2 MiB at 100,000 entries, 70.6 MiB at 1,000,000 |
| Helper peak RSS | under 512 MiB | 14.9 MiB |
| First progress event | within 2 s | 148 ms |
| One paginated index page | within 200 ms | 176 ms, including Node startup and spawning the helper |

Memory is read from each process's own `VmHWM` in `/proc`, by PID, so Node's
figure never includes the helper's. Node's peak rises by under 7% for ten times
the entries, which is the property this decision exists for. The test asserts
the budgets and also fails if the larger tree's peak exceeds the smaller one's
by more than half, so a regression that reintroduces per-entry accumulation
fails rather than being restated as a new budget.

Two figures are deliberately conservative. The index page is timed end to end,
including starting Node and spawning the helper, because that is what a person
running `disktop explore` waits for. `du -x` agreement is asserted for
allocated bytes only; `du --apparent-size` excludes directories' own `st_size`
and Disktop includes it, so the apparent totals answer different questions.
Numbers were taken on one developer machine with a Btrfs working tree and a
tmpfs `/tmp`; they are a regression baseline, not a promise about every host.

## Alternatives considered

Pure Node with `opendir` and `Dirent` cannot use `openat2`, cannot keep byte-exact names
without care at every call site, and grows with the tree. A native addon (`node-gyp`,
`napi-rs`) would need a compiler or prebuilt `.node` files per Node ABI, which multiplies
the packaging matrix and reintroduces install-time builds. A long-lived daemon adds
lifecycle, permissions, and stale-state problems for a tool that runs interactively.

## Evidence and follow-up

Phase 2's gate is met and its figures are recorded above. The measurements come from
`tests/performance/scan-memory.test.mjs` (`npm run bench` for the million-entry tree);
`du -x` agreement, invalid-byte names, bind mounts, inaccessible directories, and
cancel-and-continue come from `tests/integration/scan.test.mjs`. SQLite is `rusqlite`
with the `bundled` feature, so the helper carries its own copy and does not depend on
the host's `libsqlite3`.

A regression against these numbers is investigated before release. Restating a worse
figure as the new budget is the failure this section exists to prevent.
