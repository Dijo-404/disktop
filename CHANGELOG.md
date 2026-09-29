# Changelog

All public changes will be recorded here when the first complete Linux release is published.

## Unreleased

### Phase 1: vertical slice and inventory

- The command surface is defined once in `src/cli/parser.ts` and drives parsing, option
  validation, and generated help, so a command cannot exist in one and not the others.
- Implemented `disktop devices`, the `disktop --json` dashboard, and `disktop alerts check`
  against real Linux readings. Every other command is declared and refuses with
  `not-implemented` in the same envelope shape a working command uses.
- Added the Linux inventory adapter joining `lsblk -J -b`, `/proc/self/mountinfo`, and
  `statfs`. Physical disks are counted once; partitions belong to their disk; loop,
  memory-backed, and pseudo devices are not storage. A filesystem is identified by its
  kernel device number, so bind mounts and btrfs subvolumes are one filesystem with
  several mount points rather than several filesystems. A filesystem whose device number
  is synthetic, as btrfs and ZFS report, is traced to its disk through its source node,
  walking up through LUKS and other mapper layers.
- Mount points are parsed as bytes with the kernel's octal escapes decoded, so a mount
  under a name containing a space, a newline, or invalid UTF-8 stays addressable.
- Added space and inode alerts. The used share follows `df`, leaving reserved blocks out
  of the denominator, and is rounded down so a threshold is never crossed early. Low
  inodes are a separate alert because free blocks do not fix them. `alerts check` exits
  `1` on a threshold and `3` when the readings were incomplete.
- Added the 80×24 dashboard TUI behind the `Renderer` interface from ADR 0001, with vim
  keys and arrows, `NO_COLOR`, an ASCII fallback, unit switching, and help. Terminal
  restoration runs on a normal exit, on `SIGINT`, `SIGTERM`, and `SIGHUP`, and after an
  uncaught exception; PTY tests prove it, including after Ctrl+C.
- Added the native helper locator and client: architecture and libc selection, recorded
  SHA-256 and executable-permission verification, protocol handshake, request/response
  correlation by ID, cancellation by request ID, and bounded shutdown. An unverified or
  missing binary is a capability state; nothing is compiled, downloaded, or run unverified.
- Added `src/composition`, the only layer permitted to build an adapter, and extended the
  enforced dependency rule to cover it. The entry point now wires surfaces rather than
  reaching a platform module.
- Anchored the destructive-call lint rule to a call's callee. It previously also refused
  reading a data field named `rm`, such as lsblk's removable column.
- Added `schemas/cli/v1/alerts.json`. `disktop --json` now exits `0` when a threshold is
  reached; exit `1` is reserved for `alerts check`, as `docs/cli.md` always specified.
- Node 24.21 and 26.10 are checked before any reading, since `engines` only warns.

### Phase 0: contracts and threat model

- Added normative JSON Schemas for CLI output (`schemas/cli/v1/`) and the native helper
  protocol (`schemas/native/v1/`), each with valid and invalid examples under contract test.
- Added byte-exact path handling and the protected-path refusal policy in `src/domain`.
  Display text neutralizes C0 and C1 controls, DEL, line and paragraph separators, and
  bidirectional overrides; the policy refuses shared container roots such as `/home`,
  refuses an allowed root as its own target, and fails closed on an incomplete context.
- Added XDG location resolution, configuration defaults, and a strict TOML subset reader
  in `src/storage`, with a documented `docs/config.example.toml`.
- The source dependency rule is now enforced by `eslint.config.mjs` and proven by a test.
- Added the filesystem fixture generator and the `npm run fixtures` entry point.
- Specified `cancel` in the helper protocol; it is recognized and refused as unsupported.
- Fixed the kernel and architecture minimums, added `docs/threat-model.md`, and recorded
  ADRs 0001 to 0005.

### Earlier

- Added the project plan, agent guide, architecture documents, and development scaffold.
- No storage inspection or cleanup feature is available yet.
