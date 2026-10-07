# 1.0.0 release and validation

`disktop@1.0.0` is publicly available on npm, with `latest` pointing to `1.0.0`.
The registry records publication at **2026-10-07 18:05:58.620 UTC**.
Engineering and independent postpublication verification passed on 2026-10-07.

**Release-owner decision, 2026-10-07:** the remaining real-environment checks for
SMART hardware health, ZFS, WSL and non-cache manager mutations are assigned to
testers after the initial publication. These checks remain unvalidated and are
deferred from the initial-publication prerequisites. The
[support matrix](support-matrix.md) records their status; the
[tester guide](tester-guide.md) describes the follow-up evidence.

Phase 8 is **complete under that dated manual-check deferral**. All automated
CI/safety/recovery/performance/advisory gates, exact-artifact verification and
protected publication approval passed. Independent clean registry installation
and cryptographic signature/provenance verification passed after the original
publish workflow's immediate registry check failed. A read-only remote verification
recovery run is pending; its result will be added here without repeating publication.

## Publication and verification

| Evidence | Recorded result |
| --- | --- |
| Reviewed source | Tag [`v1.0.0`](https://github.com/Dijo-404/disktop/tree/v1.0.0), commit [`3d6448560d19d75b27fce75765819d89f36be09e`](https://github.com/Dijo-404/disktop/commit/3d6448560d19d75b27fce75765819d89f36be09e). |
| Reviewed-source CI | [Run 37659556807](https://github.com/Dijo-404/disktop/actions/runs/37659556807): all 19 jobs passed. |
| Protected publication | [Run 37661525351](https://github.com/Dijo-404/disktop/actions/runs/37661525351), attempt 1: build/artifact gates passed, protected approval was granted, and `npm publish` succeeded. The workflow's overall result is **failure** because its immediate registry verification returned 404. |
| Public registry | [`disktop@1.0.0`](https://registry.npmjs.org/disktop/1.0.0) and `latest` are available. Actual publication timestamp: 2026-10-07T18:05:58.620Z. |
| Registry tarball | [Downloaded artifact](https://registry.npmjs.org/disktop/-/disktop-1.0.0.tgz) matches the reviewed SHA-256 `a2deddd76c137e349370fb839b887baff14b3ec27c649f1ce809616bf8b39acd`; 7,925,061 compressed bytes and 192 allowed files. |
| Clean registry consumer | Installation succeeded in a fresh prefix; CLI version is `1.0.0`. All ten package consumer checks passed with no skips, covering help/version, JSON, inventory, a real packaged-helper scan, global installation, npm execution and tamper refusal. |
| npm signature audit | `npm audit signatures --json --include-attestations` passed with empty `invalid` and `missing` results, verifying `disktop@1.0.0` and its npm publish/SLSA v1 bundles. |
| Independent cryptographic verification | Passed at 2026-10-07T18:15:40.150Z: both registry ECDSA signatures verified using TUF-authenticated keys; npm publish and SLSA DSSE/SCT/Rekor bundles verified. The certificate's GitHub OIDC issuer and exact `publish.yml@refs/heads/main` identity, source commit, workflow invocation and artifact digests all match. |
| Public attestations | [Registry bundles](https://registry.npmjs.org/-/npm/v1/attestations/disktop@1.0.0): provenance Rekor entry `3133905813`, integrated at 18:01:44 UTC; npm publish entry `3133923981`, integrated at 18:05:59 UTC on 2026-10-07. Both identify the same `disktop@1.0.0` SHA-512 digest as registry integrity. |
| Read-only remote verification recovery | **Pending**: add the run link and outcome after it finishes. This check installs and verifies the existing registry release; it does not publish, change tags or rebuild the released artifact. |

The original workflow's early 404 is preserved as a failed verification attempt,
not rewritten as a successful run. Public metadata briefly showed npm's temporary
`0.0.0-stage` placeholder before `1.0.0` became available; that observation does not
represent an ongoing approval requirement. The release was not republished.

These are postrelease repository records. The tagged source and npm tarball retain
their original documentation; later documentation commits neither move `v1.0.0`
nor replace its artifact. See [the publication record and verification procedure](../CONTRIBUTING.md#publish-100).

## Executed gates

| Gate | Result |
| --- | --- |
| `npm run check` | Typecheck/lint/build passed; 1,086 unit/contract, 128 integration, 13 recovery and 18 PTY tests passed. |
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

The executed engineering gates above describe the reviewed `v1.0.0` source.
Postrelease documentation and verification tooling must pass their applicable CI
checks separately; they do not change the source or artifact already published.

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
