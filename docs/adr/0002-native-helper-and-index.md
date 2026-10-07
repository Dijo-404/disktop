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

Each scan is its own SQLite file, appended to without secondary indexes while the walk
runs, indexed once when it ends, and published by a rename; from then on it is only
read. Pruning a scan removes its file.

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

**Re-measured before 1.0.0**, after each scan became its own index file built
once at the end, with an index per browsing order. Same test, same machine,
release helper, `npm run bench`:

| Figure | Budget | Observed |
| --- | --- | --- |
| Node peak RSS | under 256 MiB, flat in entry count | 81.2 MiB at 100,000 entries, 82.3 MiB at 1,000,000 |
| Helper peak RSS | under 512 MiB | 22.3 MiB |
| First progress event | within 2 s | 102 ms; progress is now capped at ten events a second |
| One paginated index page | within 200 ms | 90 ms, including Node startup and spawning the helper |
| One page of a directory's children (`parentId`, 200 rows) | median under 50 ms | 1.5 ms median, 5.4 ms slowest, for a directory of 500,000 entries |
| Helper RSS across 2,000 further pages | flat | 9.8 MiB to 9.9 MiB |

On a second million-entry tree with varied sizes, names, and depths
(not part of the suite), a full scan fell from 48 s to 5.2 s and its index
from 565 MB to 241 MB; ranking a subtree, and listing a directory's
children in any order at any page, take under 2 ms in the helper.

Two figures are deliberately conservative. The index page is timed end to end,
including starting Node and spawning the helper, because that is what a person
running `disktop explore` waits for. `du -x` agreement is asserted for
allocated bytes only; `du --apparent-size` excludes directories' own `st_size`
and Disktop includes it, so the apparent totals answer different questions.
Numbers were taken on one developer machine with a Btrfs working tree and a
tmpfs `/tmp`; they are a regression baseline, not a promise about every host.

**Final engineering pass, 2026-10-07.** `npm run bench` passed the unchanged budgets
on a Btrfs working tree and Btrfs `/tmp`, using the release helper:

| Figure | Observed |
| --- | --- |
| Node peak RSS, 100,000 → 1,000,000 entries | 79.1 → 80.5 MiB |
| Helper peak RSS and first progress | 22.2 MiB; 102 ms |
| End-to-end index page | 102 ms |
| 500,000-child directory pages | 1.2 ms median; 2.8 ms slowest |
| Helper RSS over 2,000 additional pages | 9.8 → 9.8 MiB |
| Repeated duplicate/review operations over 100,000 same-size files | 20.1 MiB peak; descriptors 3 → 3 |
| 1,000 truecolor frames over 10,000 retained rows | 0.75 MiB retained after GC; 2.01 ms/frame |
| 20,000 refresh keys during a blocked task | 0.15 MiB retained; two jobs executed |

CI and publication now build a release helper before performance validation and set
`DISKTOP_REQUIRE_RELEASE_BENCHMARK=1`. That gate refuses a missing or stale release
build instead of silently running non-binding debug timings.

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

Node retains only the latest buffered scan progress reading. Durable per-item action
outcomes apply pipe backpressure after 64 queued events; the current pipe chunk can
finish parsing, so the queue is bounded by that chunk in addition to the threshold.
Returning an event iterator cancels and drains to the terminal outcome, preserving
journal completion. Already-aborted requests are never submitted. Directory discovery
streams at most 4,096 raw names before sorting them. A 4,097th entry is an explicit
`EOVERFLOW` refusal, so detectors cannot report a sampled directory as complete or a
manager cache's sampled package count as exact. Larger directories can be scanned and
explored through the streaming native index. Package-cache discovery also inspects at
most 10,000 entries across all cache directories for one manager, including ignored or
duplicate names. The next entry raises `EOVERFLOW` before its metadata is read; items,
warnings and duplicate tracking stay bounded, and discovery and previews never turn a
larger cache into a sampled exact count. Inventory capacity probes run in isolated read-only Node children
so an unavailable hard network mount cannot occupy the application's libuv worker
pool. Probes share simultaneous reads, time out, and remember unreaped children; at
most eight can remain pending, and none can prevent the parent from exiting.
Read-only system queries receive their discovery task's abort signal and terminate
their whole process group on cancellation, timeout or output overflow. The abort
listener is removed when the query settles, and unrelated discovery tasks keep their
own signals. Helper checksums are streamed from pinned regular files in 64 KiB chunks;
checksum lists are bounded no-follow reads and malformed installations are refused.

Package and manager probes share one reading for a discovery task, keyed by its abort
signal rather than kept across TUI refreshes. Discovery, previews and manager preflight
queries receive that signal; verification and journal completion still finish after a
mutation. Index queries own a dedicated read-only helper. Because SQLite runs on the
helper's protocol reader, cancelling one closes that helper with bounded shutdown
and reaping instead of waiting for a cancel message SQLite cannot read. This shutdown
policy is confined to index queries; scans and actions keep their cooperative journal
completion guarantees. Account-name reads retain at most 1 MiB from a regular file.
Missing detector paths are absent answers, while permission denials and failed reads
make discovery incomplete. A partial size measurement keeps the measurements obtained
and marks the result incomplete for the footprints that remain unknown.
