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

**Budget, fixed here and measured in Phase 2:** on a one-million-entry reference tree
from `tests/fixtures/generate.mjs`, Node's peak RSS stays under 256 MiB and does not grow
with entry count; the helper's stays under 512 MiB; the first progress event arrives
within 2 seconds; and a paginated index query over the finished scan returns within
200 ms. Measurement is `/usr/bin/time -v` for RSS and the CLI's own timings for latency,
on the reference fixture, compared against `du -x` over the same scope where the
semantics match. A regression is investigated before release rather than restated as a
new budget.

## Alternatives considered

Pure Node with `opendir` and `Dirent` cannot use `openat2`, cannot keep byte-exact names
without care at every call site, and grows with the tree. A native addon (`node-gyp`,
`napi-rs`) would need a compiler or prebuilt `.node` files per Node ABI, which multiplies
the packaging matrix and reintroduces install-time builds. A long-lived daemon adds
lifecycle, permissions, and stale-state problems for a tool that runs interactively.

## Evidence and follow-up

Phase 2's gate: the million-entry memory measurement, `du -x` comparison, invalid-byte
names, bind mounts, inaccessible directories, and cancel/restart. The budget numbers
above are targets until that gate produces measurements; the first measured run replaces
them with observed figures in this ADR.
