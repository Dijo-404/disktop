# Linux support matrix

Status: **1.0.0 validation matrix**. Rows distinguish automated coverage,
actual host checks and remaining unproven environments. The [validation record](release-readiness.md)
records publication and independent registry/provenance verification on 2026-10-07, local engineering
evidence and the release owner's 2026-10-07 decision
to defer the remaining hardware/VM checks to testers after the initial publication.
Deferred checks are still unvalidated. The published artifact passed the automated
release gates and protected workflow approval; that does not validate the deferred hosts.

## Fixed minimums

| Requirement | Minimum | Behaviour below it |
| --- | --- | --- |
| Node.js | 24.21.0 LTS or 26.10.0 Current, within those major lines | The CLI refuses older and unsupported majors. npm checks `engines`, but may only warn unless `engine-strict` is enabled. |
| Linux kernel for scanning and mutation | 5.6, for `openat2` with `RESOLVE_BENEATH` and `RESOLVE_NO_MAGICLINKS` | The helper's `hello` reports `openat2` unavailable with the errno reason; scans and every mutation are refused as `unsupported-kernel`. Inventory stays available. |
| Kernel with `openat2` present but blocked (a seccomp policy, some container runtimes) | — | Identical to the above: probed at startup, refused explicitly, never retried through an unsafe path. |
| Architecture and libc | x86-64 or ARM64, glibc or musl | No bundled binary matches; `unsupported-architecture`, helper-backed features disabled, inventory still available. `package.json` deliberately declares no `cpu`, because npm would then refuse the install and take the inventory away too. |
| glibc, for the glibc helper builds | 2.28 (Debian 10, RHEL 8, Ubuntu 20.04 and later) | Node 24's own Linux binaries need 2.28, so Node does not start below it. The helpers ask for no newer symbol; `scripts/build-release.mjs` refuses a build that does. |
| musl, for the musl helper builds | any; the builds are static | Selected when Node itself runs on musl (Alpine and others). |
| Operating system | Linux, enforced by `os` in `package.json` | Not installable. The macOS adapter boundary exists; no macOS behaviour ships in `1.0.0`. |

`openat2` is the hard floor because containment is what the safety rules rest on; there
is no degraded traversal mode. See [adr/0003](adr/0003-prebuilt-binary-packaging.md) for
binary selection and [adr/0002](adr/0002-native-helper-and-index.md) for why the helper
owns traversal.

## Runtime and binary targets

| Component | Target | Required validation before release |
| --- | --- | --- |
| Node.js | 24 LTS baseline; 26 Current compatibility | CLI, TUI, reports, and packed-package smoke tests on the latest patched release of each supported line. |
| Linux kernel | 5.6 or newer for full native scan and mutation | Probe `openat2` and action behavior. Older or restricted kernels must show explicit unsupported states. |
| x86-64 glibc | `vendor/bin/disktop-fs-linux-x64-gnu` | Check checksum, permissions, protocol, and clean-account install. |
| x86-64 musl | `vendor/bin/disktop-fs-linux-x64-musl` | Same checks in a musl environment. |
| ARM64 glibc | `vendor/bin/disktop-fs-linux-arm64-gnu` | Same checks on ARM64. |
| ARM64 musl | `vendor/bin/disktop-fs-linux-arm64-musl` | Same checks on ARM64 musl. |
| macOS | Platform boundary only | No macOS behavior promised in Linux `1.0.0`. |

The package must select a binary without running a Rust compiler during installation. If there is no matching helper or required kernel primitive, inventory and other safe read-only functions may remain available, but unsupported scans or actions must be disabled explicitly. Binary packaging and integrity checks are a publication gate.

### What CI runs for each target

`scripts/build-release.mjs` builds all four helpers on every push, and the publish
workflow builds the release the same way; see [adr/0003](adr/0003-prebuilt-binary-packaging.md).

| Check | Where it runs |
| --- | --- |
| Build `--release --locked` with `cargo zigbuild`; ELF machine, interpreter, stripping, and glibc floor checked against each name; `SHA256SUMS` written and checked with `sha256sum --check --strict` | x86-64 runner, all four targets |
| `hello` handshake: package version and a release build checksum | each glibc build on its own runner (Ubuntu 24.04) and on AlmaLinux 8 (glibc 2.28); each musl build on Alpine and on the glibc runner |
| Package smoke test: allowlist, modes, checksums, global install and `npm exec` with a throwaway home and npm cache, `--help`, `--version`, `--json`, `devices --json`, a scan through the packaged helper, and refusal of a tampered helper or `SHA256SUMS` | Node 24 and 26 on x86-64 and ARM64 runners (glibc builds); `node:24-alpine` on x86-64 and ARM64 (musl builds); Ubuntu, Fedora, and Arch containers |
| The published artifact | the same smoke test on the one released tarball: x86-64 glibc in the build job, then ARM64 glibc and x86-64 and ARM64 musl, each checked by SHA-256 first |

Locally, `npm run test:package` runs the same smoke test once `vendor/bin/` holds this
machine's helper (`node scripts/build-release.mjs --target host`).

Node 24 remains the [LTS baseline](https://nodejs.org/en/about/previous-releases). Security fixes are issued on maintained release lines, including [the July 2026 fixes for both 24.x and 26.x](https://nodejs.org/en/blog/vulnerability/july-2026-security-releases), so a newer major alone is not a security update. The minimum versions above include the published fixes available on 2026-09-30; users should keep their chosen supported line at its latest security release. Node 25 is end of life and is not a supported runtime.

## Linux distribution test targets

| Environment | Planned checks | Current status |
| --- | --- | --- |
| Ubuntu | TypeScript/Rust checks, dpkg and apt adapters, integration tests, PTY tests, packed install. | CI container (`ubuntu:24.04`): PTY, read-only manager discovery/kernel preview, inventory and package smoke tests as an ordinary account; root inventory from a root-owned global install. Actual apt cache cleanup passed through a reviewed plan, exact-command sudo and native journal in a disposable Ubuntu 24.04 container. Kernel purge and other manager mutations still need separate checks. |
| Fedora | rpm/dnf adapters and Linux integration tests in container or VM. | CI container (`fedora:latest`): the same checks, including dnf cache discovery and kernel preview. Actual DNF5 cache cleanup passed through the real reviewed pipeline on Fedora 44; old-kernel removal remains unproven. |
| Arch | pacman adapter and Linux integration tests in container or VM. | CI container (`archlinux:latest`): the same checks, including pacman cache discovery. Actual pacman cache cleanup passed through the real reviewed pipeline in a disposable Arch container. |
| Host or VM with systemd and representative mounts | User timer, scoped privilege, mount topology, SMART where hardware permits, Btrfs/ZFS where available. | Partly, on one Arch host (kernel 6.18, util-linux 2.42): Btrfs on LUKS with six subvolume mounts scanned as one filesystem (291 GiB of 331 GiB used found, the rest unreadable to the user or shared between files), a FAT `/boot` and the pseudo filesystems refused, an unmounted NTFS partition and a locked LUKS drive listed, and the read-only measurement as root through pkexec's desktop dialog (583 unreadable directories, 55.9 GiB). The current timer and mount-fault checks are recorded below. Non-cache privileged manager cleanup, SMART health and ZFS remain unvalidated. |
| WSL | Detect Windows mounts and exclude `/mnt/c` by default; explicit path selection after setting `exclude_windows_mounts = false` in the `[scan]` section of `config.toml`. | Not validated. |
| tmux and SSH terminal | 80×24 layout, mouse fallback, `NO_COLOR`, ASCII rendering, and terminal restoration. | tmux drew at 80×24, handled resize and below-minimum states, and restored the shell screen. A real rootless loopback SSH server passed ASCII/NO_COLOR output and quit/SIGINT restoration, including exact stty state. Mouse input is exercised by PTY tests; mouse through a remote SSH/tmux chain remains unproven. |

Containers cannot prove hardware health, real mount behavior, privilege prompts, or terminal behavior for every host. Those cases need a host or VM check before a support claim is made. Linux distribution names above describe the CI targets, not a complete compatibility list.

## Manager adapters and what was checked

| Adapter | Distribution | Checked here |
| --- | --- | --- |
| apt (`apt-get clean`), old kernels (`dpkg --purge`, simulated with `apt-get -s purge`) | Debian, Ubuntu | Actual cache cleanup through scoped sudo and the native journal on Ubuntu 24.04; kernel removal remains fixture coverage. |
| dnf (`dnf clean packages`), old kernels (`rpm -e`, tested with `rpm -e --test`) | Fedora | Actual DNF5 cache cleanup through scoped sudo and the native journal on Fedora 44; kernel removal remains fixture coverage. |
| pacman (`pacman -Sc`) | Arch | Actual cache cleanup through scoped sudo and the native journal in Arch; host cache discovery remains read-only and kernels report nothing to remove. |
| journald (`journalctl --vacuum-size`) | systemd hosts | Disk usage read on an Arch host (read-only). |
| Snap (`snap remove --revision`) | Ubuntu and others | Fixture output; not run on a host. |
| Flatpak (`flatpak uninstall --unused`) | any | Installations listed on an Arch host (read-only). |
| Docker, Podman | any | Docker read on an Arch host (read-only), including the named-versus-anonymous volume split; Podman from fixture output. |
| systemd-tmpfiles (`--clean`, crash prefixes) | systemd hosts | Dry runs on an Arch host. |
| `sudo -n` refusal | any | Observed on an Arch host where sudo needs a password. |
| systemd user timer | systemd hosts | Real user-manager runtime install, fixture alert execution, disable and removal passed using throwaway unit files. Existing timer units are preserved. |

The mandatory disposable-manager gate runs real apt/DNF5/pacman cache cleanup as an
ordinary account, with only the exact reviewed command granted sudo rights. It refuses
host execution, writable repository mounts, cache mounts and any cache containing more
than its root-certified fixture. It checks plan review, started/finished journal
acknowledgements, removal, live verification, preserved package databases/sentinel data,
complete history and refused undo. No fake command runner participates. Other manager
mutations retain real-helper/fake-runner integration coverage and the host gaps above.

The 2026-10-07 host inventory found both connected NVMe SSDs and all eleven persistent
partition/mapper/LVM entries, including EFI/reserved/swap partitions. Actual private
mounts proved same-filesystem coverage and bind/other-filesystem exclusions. The
isolated container fault gate proved full output, full journal, read-only source and
cross-device actions without skips. The real user timer and SSH checks are now
validated, as are actual apt/DNF5/pacman cache mutations in disposable containers.
Non-cache manager mutations, SMART hardware health, ZFS and WSL remain the outstanding
environment checks, assigned to testers after initial publication. See the
[tester guide](tester-guide.md) for checks and evidence to attach to a result PR.
The packed CLI's actual SMART queries under read-only NVMe device
mappings reported permission denial and incomplete discovery safely, without claiming
health or widening privileges. Earlier read-only scoped `du`/pkexec and Btrfs
host results above remain evidence for those narrower behaviors.

## Optional dependency behavior

| Dependency | Feature area | If absent or denied |
| --- | --- | --- |
| `lsblk`, mountinfo, `statfs` | Device, mount, capacity and inode inventory | Report what source is unavailable and mark inventory incomplete. |
| `lsof` | Deleted-but-open files | Show `missing-tool` or `permission-denied`; do not report zero open files. memfds, shared memory and anonymous inodes are excluded from the total, because those bytes were never on a disk. |
| `smartctl` | SMART health | Show unavailable or permission state. smartctl exits non-zero with an empty stderr when it cannot open a device, so the denial is read from its own JSON. |
| apt/dnf/pacman, Snap, Flatpak | Package counts, sizes, managed cleanup | Disable only the affected adapter and show why. |
| Docker/Podman | Container footprint and cleanup | Disable the affected manager action; never delete its storage directly. |
| `btrfs`, `zfs` | Subvolume and snapshot listing | A machine without them is a machine without them, not an incomplete reading; a denial is reported and makes the result incomplete. |
| `notify-send`, systemd user instance | Opt-in desktop alert timer | CLI alert check remains usable; notification/timer capability is separate. |
| `sudo` or `pkexec` | Reviewed privileged manager action | Refuse that action when scoped elevation cannot run. Never elevate the whole npm process. |

Network and removable mounts are shown in inventory but scanned only on explicit selection. Scans stay on one filesystem by default, which includes that filesystem's other subvolume mounts below the root (Btrfs `/home` under `/`); unmounted data partitions and locked encrypted containers are listed with their size and no usage. Permission-denied paths and optional-tool gaps must remain visible in TUI and JSON. A successful read-only inventory does not imply that cleanup is supported on the same host.

Crash cleanup uses filesystem birth time to distinguish recycled staging inodes.
On a filesystem that does not report it through `statx`, a partial output whose
size or modification time changed since staging was recorded is kept and named in
history for review. Undo requires the journal's complete moved-file fingerprint;
older internal records lacking it remain readable but their undo is refused.
