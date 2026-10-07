# 1.0.0 release-candidate validation

Engineering validation recorded on 2026-10-07. The package remains unpublished.
Phase 8 also requires the outstanding environment checks in the
[support matrix](support-matrix.md), reviewed-commit CI, protected release approval,
and post-publication provenance and registry-install verification.

## Executed gates

| Gate | Result |
| --- | --- |
| `npm run check` | Typecheck/lint/build passed; 1,084 unit/contract, 128 integration, 13 recovery and 18 PTY tests passed. |
| Rust formatting, Clippy `-D warnings`, locked tests | Passed; 266 tests, no ignored tests. |
| `npm run bench` | Seven checks passed at 1,000,000 entries; unchanged memory and latency budgets, including the category-aggregation scaling regression. |
| Private filesystem faults | Full output, full journal, read-only source and cross-device moves passed without skips in an isolated container, with source bytes preserved on refusal. |
| Actual mount topology | Repeating bind mounts and another filesystem excluded; a non-overlapping mount of the root filesystem included. |
| `DISKTOP_TEST_SYSTEMD=1` timer gate | Actual user-manager runtime install, fixture alert execution and removal passed. |
| `DISKTOP_TEST_SSH=1` terminal gate | Three checks passed: actual rootless loopback SSH, ASCII/NO_COLOR 80×24 output, quit/SIGINT restoration including exact terminal attributes. |
| Real privileged package-cache cleanup | apt, DNF5 and pacman passed in disposable containers: reviewed plan, exact-command sudo, native started/finished journal, live verification, irreversible-undo refusal; sentinel data and package databases preserved. Wrapper SIGINT/SIGTERM/SIGHUP cleanup and cleanup-error regressions passed. |
| Four-target production native build | x64/ARM64, GNU/musl built; executable bits, ELF targets, glibc 2.28 floor and all four SHA-256 checks passed. |
| Exact packed artifact, installed into clean homes/prefixes | Ten checks passed on Node 26.10 glibc, Node 24.21 glibc and Node 24.21 musl; global CLI and npm exec, help/version, JSON, devices, scans and tamper refusal worked. |
| Dependency advisories | npm: zero vulnerabilities; RustSec: zero vulnerabilities and warnings across the locked native dependency tree. |
| Workflow/static hygiene | actionlint, changed-script syntax and whitespace checks passed; no unfinished TODO/FIXME, credentials or debug artifacts found. |

The ordinary integration suite explicitly skips absent apt/dnf on the Arch test host,
second-filesystem cases and opt-in timer/namespace/disposable-manager gates. Their available environments
are exercised separately; the mandatory container fault gate refuses skips. The
ordinary PTY suite skips the opt-in SSH test, whose real enabled run is recorded above.
Host inventory identified both connected NVMe SSDs and every partition/logical volume,
including firmware/reserved/swap entries; an inaccessible Docker mount correctly
produced an incomplete result instead of zero usage.

The tarball contains only 192 allowed files: compiled runtime JavaScript, four verified
helpers and their checksum list, public CLI schemas, README, changelog, license,
complete third-party license notices and npm metadata. It is approximately 7.4 MiB
compressed and 16.4 MiB unpacked. It has no
installation hook, compilation requirement, source, tests, user data or development
dependencies. [Package tests](../tests/package/package.test.mjs) inspect its contents,
permissions and checksums, and run what is installed from it.

## Changed contracts and regression ownership

| Owning boundary | Contract/acceptance effect | Fixtures and tests |
| --- | --- | --- |
| Domain/inventory, CLI and reports | Additive `volumes` in device/report JSON, lossless sizes and every physical backing drive; no automatic mounting or unlocking. | CLI schemas/examples, mixed/multiple-drive/RAID fixtures; inventory, lsblk, report and CLI contract tests. |
| Native traversal/actions/journal | Bounded directory/inode/duplicate scratch storage; unchanged mutation authority, stronger metadata/restore/journal checks and cancellation. Duplicate output cap documented in native schema. | Rust sandbox tests, native/scan/actions integrations, crash recovery, filesystem fault and resource gates. |
| Application/ports/adapters/storage | Optional internal abort signals, live task readings, truthful permission/measurement/entry-limit failures, immutable plan and report publication. Public error envelopes remain v1. | Discovery, ZFS denial/failure/malformed readings and snapshot-query cancellation, overflowing AppImage/multi-repository package-cache directories, real apt/DNF5/pacman apply/journal/verification, manager/query cancellation, unreadable/invalid-byte/sparse fixtures, plan/report/locator/timer regressions. |
| TUI | Same application services and reviewed confirmations; Mocha truecolor and reduced-color/no-color/ASCII modes, bounded pending tasks and no stale updates. | 40×10 through 220×60 screen tests, PTY/tmux/SSH, session and long-running memory regressions. |
| Packaging/workflows | Fixed four-helper names and allowlist, advisory gates, mandatory real filesystem faults and binding release-build performance checks. | Release contracts, helper lifecycle tests, packed clean-consumer execution and CI matrix. |

Reports and plans refuse filesystems that cannot provide their no-replace atomic
publication primitive. This preserves the refusal policy; reports can still go to
stdout or to a supported output filesystem. Filesystem accounting cannot identify
exclusive Btrfs/reflink/compression extents, and Linux cannot make every metadata
comparison atomic with a following syscall. Those existing boundaries, their
conservative checks and uncertain journal outcomes are explained in
[safety](safety.md) and the [threat model](threat-model.md).
