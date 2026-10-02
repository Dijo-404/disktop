# ADR 0006: A digest groups candidates, a byte compare authorises a mutation

Status: accepted

## Context

Phase 5 adds four features that have to answer a question about file content: finding
duplicates, replacing a duplicate with a hardlink, moving a file to another disk, and
compressing one. Three of them release a copy of something afterwards.

Reading every byte of every file in a scan to find duplicates is not affordable: a home
directory that scans in seconds would take minutes. The usual answer is a hash — group by
size, hash a little, hash the rest, and treat a matching hash as a match. That answer is
fine for building a list and wrong for authorising a deletion. A hash collision in a
listing wastes a reader's attention. A hash collision in `dedup-hardlink` releases the
inode holding somebody's only copy of a file and points its name at different bytes, and
nothing in the journal can bring it back, because the bytes were never moved anywhere.

Compression needs a format. `.zst` and `.tar.zst` are the formats named in `PLAN.md`;
neither is something to write by hand inside a helper that also deletes files.

## Decision

Content is read through `native/disktop-fs/src/content.rs`, which draws the line between
the two questions explicitly:

- `edge_digest` and `full_digest` **group candidates**. They are allowed to say two
  different files might match. Nothing acts on their answer alone.
- `bytes_equal` **authorises a mutation**. Every operation that releases one copy of
  something because another copy exists calls it immediately before the syscall, on the
  two descriptors it is about to act on, and refuses when it returns false or errors.
  There is no configuration, flag, or size threshold that skips it.

The digests are SHA-256 from the `sha2` crate. The strength is not the point — the point
is that a well-reviewed implementation of a function nobody has found a practical
collision for costs no more here than a bespoke one would, and the same digest verifies a
cross-disk copy, where an attacker-chosen collision is a real if remote concern.

`zstd` and `tar` are taken as dependencies for the compress operation. The helper calls
no external `zstd` or `tar` executable: a command built from a path is a command whose
arguments a filename can influence, and `src/platform/linux/tools.ts` exists precisely so
that the programs Disktop runs are a fixed list.

Everything in `content.rs` reads through `pread`. No function there depends on or
disturbs a descriptor's file offset, so a digest and a compare can run against the same
open file without a protocol about whose turn it is.

## Consequences

- The helper gains three dependencies and their transitive trees. `cargo clippy
  --all-targets -- -D warnings` and `cargo test` cover them in CI, and
  `docs/support-matrix.md` already fixes the toolchain.
- Duplicate detection is a three-stage funnel: size class, edge digest, full digest. Its
  cost is bounded by the number of files that survive each stage, not by the scan.
- An operation that acts on content equality pays one extra full read of both files at
  apply time. That is the price of the guarantee and it is not optional.
- A digest appears in public JSON as 64 lowercase hexadecimal characters. It identifies a
  group within one result; it is not a stable identifier across scans and nothing stores
  it as one.

## Alternatives considered

**Trust the full digest and skip the byte compare.** Standard practice in deduplication
tools, and the reason some of them have data-loss bug reports. `PLAN.md` requires
"byte-compare before mutation" for duplicates; extending that to every content-equality
mutation costs one read and removes the whole class.

**Write a hash in-tree to avoid the dependency.** A hand-written digest in a binary that
deletes files is a worse risk than one more audited crate, and it would not be credible as
a cross-disk copy checksum.

**Shell out to `zstd` and `tar`.** Rejected: it reintroduces argument construction from
filenames, makes the feature depend on programs that may be absent or different versions,
and puts archive creation outside the fd-relative containment the helper is built on.

## Evidence and follow-up

`native/disktop-fs/src/content.rs` tests cover: two files differing only in the final
byte, files of different length, a change in the middle of a long file that the edge
digest cannot see and the full digest can, an empty file, and a digest that does not
depend on the descriptor offset. The `dedup-hardlink`, `copy-move`, and `compress`
integration tests each assert the refusal that a changed file produces.
