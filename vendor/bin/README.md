# Bundled helpers

A release packages four `disktop-fs` binaries here, and nothing else in this directory
is committed. `node scripts/build-release.mjs` writes them; the package ships them.

| File | Target | Built as |
| --- | --- | --- |
| `disktop-fs-linux-x64-gnu` | x86-64, glibc | `x86_64-unknown-linux-gnu`, linked against glibc 2.28 symbols at most |
| `disktop-fs-linux-x64-musl` | x86-64, musl | `x86_64-unknown-linux-musl`, static |
| `disktop-fs-linux-arm64-gnu` | ARM64, glibc | `aarch64-unknown-linux-gnu`, linked against glibc 2.28 symbols at most |
| `disktop-fs-linux-arm64-musl` | ARM64, musl | `aarch64-unknown-linux-musl`, static |
| `SHA256SUMS` | | one `sha256sum` line per binary above |

`SHA256SUMS` is exactly what `sha256sum` writes, so an installation can be checked with
the stock tool from this directory:

~~~sh
sha256sum --check --strict SHA256SUMS
~~~

At startup `src/native/locator.ts` picks the binary for the running architecture and
libc, reads `SHA256SUMS` strictly (any malformed line, unknown name, or repeated name
makes the whole file unreadable), and runs the binary only when it is a regular,
executable file whose SHA-256 matches its line. A binary that fails any of that is
refused with an `unsupported-architecture` capability that says why; it never falls
back to another binary. `tests/unit/release-contract.test.mjs` fails if the locator,
`scripts/build-release.mjs`, the workflows, this file, or ADR 0003 name a different set.

## Building them

~~~sh
node scripts/build-release.mjs                  # all four; needs zig and cargo-zigbuild
node scripts/build-release.mjs --target host    # this machine's binary only
node scripts/build-release.mjs --clean          # remove what the script wrote
~~~

Every target is built `--release --locked` with `cargo zigbuild`, at the zig and
cargo-zigbuild versions pinned in `.github/actions/release-toolchain/action.yml`, and
the pinned Rust toolchain needs the four targets (`rustup target add ...`; the script
names any that are missing). `--target host` falls back to plain `cargo build` when zig
is absent; that binary's glibc floor is then the build machine's own, and it says so.

The script checks each binary against its name before recording it: ELF machine,
program interpreter (none for the static musl builds), no symbol table, and no glibc
symbol newer than 2.28. It writes the binaries with mode 0755, writes `SHA256SUMS`,
confirms `sha256sum --check --strict` accepts it, and asks every binary this machine
can run for `hello`, which must report the package version and the build checksum.

The build checksum is what `hello` reports as `buildChecksum`: the SHA-256 of the
helper's inputs (its `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, every source
file, and the target), injected at build time through `DISKTOP_HELPER_BUILD_CHECKSUM`.
It identifies the source a binary came from and can be recomputed from the tagged
tree with `node scripts/build-release.mjs --print-build-checksum --target <target>`.
It is not the binary's own digest, which cannot be inside the binary; `SHA256SUMS`
carries that. A development build from `npm run build:native` reports `null`.

## Development builds

`npm run build:native` creates a debug binary under `native/disktop-fs/target/debug/`,
which the locator uses only when `vendor/bin/` holds no binary for this machine. A
binary here wins, exactly as it does in an installed package, so after a release or
package test run `node scripts/build-release.mjs --clean` before going back to
`build:native`, or the CLI keeps running the release binary you built.
