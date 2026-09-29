# ADR 0003: Prebuilt helper binaries in one npm tarball

Status: accepted

## Context

Disktop is meant to be run with `npx disktop`. ADR 0002 makes a Rust executable part of
the product. An npm `install` script that compiles Rust would require a toolchain on
every user's machine, run arbitrary build code at install time, and fail on the clean
accounts where `npx` is most attractive.

## Decision

Ship prebuilt `disktop-fs` binaries inside the single npm tarball, under `vendor/bin/`,
one per supported target: x86-64 glibc, x86-64 musl, ARM64 glibc, ARM64 musl. The package
declares no `install`, `preinstall`, or `postinstall` script. At startup `src/native/locator.ts`
selects the binary matching the running architecture and libc, verifies its recorded
checksum and executable permission, and negotiates the protocol version.

If no binary matches, or the checksum fails, or the kernel lacks a primitive an action
needs, Disktop reports that capability state and disables the affected feature. Read-only
inventory that does not need the helper stays available. There is no fallback that
compiles, downloads, or runs an unverified binary.

## Consequences

`npx disktop` works on a clean account with no compiler, and nothing executes at install
time. The tarball is larger, and the release build must produce and check four binaries
before publishing; the publish workflow verifies checksums and permissions as a gate.
Platform-specific optional dependency packages were rejected in favour of one tarball so
there is a single artifact to audit and a single provenance statement to verify.

A user on an unsupported architecture gets an explicit unsupported-architecture
capability rather than a crash, and `build:native` stays a development script that must
never run during an end user's install.

## Alternatives considered

Compiling at install time fails the clean-account requirement and runs build code as a
side effect of installing. Downloading a binary at first run makes a network request
from a tool that promises to make none. Per-platform optional dependencies spread the
release over five packages and five provenance statements. A WASM helper cannot call
`openat2` and so cannot provide the containment the safety rules depend on.

## Evidence and follow-up

Phase 8: `npm pack --dry-run` audit, checksum and permission verification in the publish
workflow, global install and `npx` on clean accounts for each target, and provenance
verification after the single `1.0.0` publication.
