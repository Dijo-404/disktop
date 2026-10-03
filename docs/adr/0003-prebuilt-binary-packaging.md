# ADR 0003: Prebuilt helper binaries in one npm tarball

Status: accepted

## Context

Disktop is meant to be run with `npx disktop`. ADR 0002 makes a Rust executable part of
the product. An npm `install` script that compiles Rust would require a toolchain on
every user's machine, run arbitrary build code at install time, and fail on the clean
accounts where `npx` is most attractive.

## Decision

Ship prebuilt `disktop-fs` binaries inside the single npm tarball, under `vendor/bin/`,
one per supported target, with their checksums beside them:

| File | Target |
| --- | --- |
| `vendor/bin/disktop-fs-linux-x64-gnu` | x86-64 glibc, glibc 2.28 symbols at most |
| `vendor/bin/disktop-fs-linux-x64-musl` | x86-64 musl, static |
| `vendor/bin/disktop-fs-linux-arm64-gnu` | ARM64 glibc, glibc 2.28 symbols at most |
| `vendor/bin/disktop-fs-linux-arm64-musl` | ARM64 musl, static |
| `vendor/bin/SHA256SUMS` | one `sha256sum` line per binary |

The package declares no `install`, `preinstall`, `postinstall`, or `prepare` script. At
startup `src/native/locator.ts` selects `disktop-fs-linux-<x64|arm64>-<gnu|musl>` for the
running architecture and libc (Node reports a glibc runtime version only on glibc), reads
`SHA256SUMS` strictly, and runs the binary only when it is a regular executable file whose
SHA-256 matches its line. It then negotiates the protocol version.

`SHA256SUMS` is the format `sha256sum` writes and `sha256sum --check --strict` reads, so a
person can check an install with the tool they already have. The locator reads it more
strictly than the tool does: one malformed line, a name that is not one of the four, or a
name given twice makes the whole file unreadable rather than partly trusted.

`scripts/build-release.mjs` is the only way the four binaries are made, in CI on every
push and in the publish workflow alike: `--release --locked` through `cargo zigbuild` at
pinned zig and cargo-zigbuild versions, with LTO, one codegen unit, and symbols stripped.
`panic` stays `unwind`, because the helper settles a panicking worker's request through
`catch_unwind`. Before recording a binary the script checks it against its name: ELF
machine, program interpreter, stripping, and the glibc floor. 2.28 is the floor because
Node 24's own Linux binaries require it, so no machine that can run the JavaScript is
refused by the helper. Each binary reports the package version and a build checksum, the
SHA-256 of the source it was built from, in `hello`.

If no binary matches, or the binary or `SHA256SUMS` fails a check, or the kernel lacks a
primitive an action needs, Disktop reports that capability state and disables the
affected feature. A packaged binary that fails a check is refused outright, with the
reason, and never replaced by another binary. Read-only inventory that does not need the
helper stays available. There is no fallback that compiles, downloads, or runs an
unverified binary.

The check protects the installation at rest: a file damaged or altered after it was
packed. Whoever can write into the installation while Disktop runs can also rewrite the
JavaScript that does the checking, so the check does not claim to stop them; an
installation only root can write is what does, and Disktop refuses to run as root from
any other.

## Consequences

`npx disktop` works on a clean account with no compiler, and nothing executes at install
time. The tarball is larger, about 7 MB packed and 15 MB installed, and the release build
must produce and check four binaries before publishing. `tests/package/` packs the
repository (or takes the exact tarball the publish workflow will publish), compares every
file against an allowlist, installs it globally and through `npm exec` with a throwaway
home and npm cache, runs the CLI and a scan through the packaged helper, and proves that a
tampered binary or `SHA256SUMS` is refused. CI runs it on x86-64 and ARM64, on Node 24 and
26, inside Alpine for musl, and in the Ubuntu, Fedora, and Arch containers; the publish
workflow runs it on the published file on all four targets.
`tests/unit/release-contract.test.mjs` fails if the locator, the build script, the
workflows, `vendor/bin/README.md`, or this record name a different set of binaries.

Platform-specific optional dependency packages were rejected in favour of one tarball so
there is a single artifact to audit and a single provenance statement to verify.

A user on an unsupported architecture gets an explicit unsupported-architecture
capability rather than a crash, and `build:native` stays a development script that must
never run during an end user's install. A binary in `vendor/bin/` takes precedence over
the development build in a checkout too, as it does in an installed package.

## Alternatives considered

Compiling at install time fails the clean-account requirement and runs build code as a
side effect of installing. Downloading a binary at first run makes a network request
from a tool that promises to make none. Per-platform optional dependencies spread the
release over five packages and five provenance statements. A WASM helper cannot call
`openat2` and so cannot provide the containment the safety rules depend on. A JSON
checksum manifest was the first design; it was replaced by `SHA256SUMS` because nothing
outside Disktop could check it. Shipping only the static musl builds, which run on any
Linux, was rejected: a glibc host is better served by a binary that uses its own C
library, musl's allocator is generally slower under threaded load, and the cost of the
other two binaries is tarball size alone.

## Evidence and follow-up

Phase 8: the package smoke test on every target, checksum and permission verification in
the publish workflow against the exact tarball it publishes, the glibc floor proven by
running the glibc builds on AlmaLinux 8 in CI, and provenance verification after the
single `1.0.0` publication.
