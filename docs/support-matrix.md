# Linux support matrix

Status: **release targets, not validated support claims**. Phase 0 has fixed the minimums below; no platform row is certified yet, and Phase 8 supplies install and acceptance evidence before publishing the single `1.0.0` release.

## Fixed minimums

| Requirement | Minimum | Behaviour below it |
| --- | --- | --- |
| Node.js | 24.21.0 LTS or 26.10.0 Current, within those major lines | The CLI refuses older and unsupported majors. npm checks `engines`, but may only warn unless `engine-strict` is enabled. |
| Linux kernel for scanning and mutation | 5.6, for `openat2` with `RESOLVE_BENEATH` and `RESOLVE_NO_MAGICLINKS` | The helper's `hello` reports `openat2` unavailable with the errno reason; scans and every mutation are refused as `unsupported-kernel`. Inventory stays available. |
| Kernel with `openat2` present but blocked (a seccomp policy, some container runtimes) | — | Identical to the above: probed at startup, refused explicitly, never retried through an unsafe path. |
| Architecture and libc | x86-64 or ARM64, glibc or musl | No bundled binary matches; `unsupported-architecture`, helper-backed features disabled, inventory still available. |
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
| x86-64 glibc | Bundled `disktop-fs` binary | Check checksum, permissions, protocol, and clean-account install. |
| x86-64 musl | Bundled `disktop-fs` binary | Same checks in a musl environment. |
| ARM64 glibc | Bundled `disktop-fs` binary | Same checks on ARM64. |
| ARM64 musl | Bundled `disktop-fs` binary | Same checks on ARM64 musl. |
| macOS | Platform boundary only | No macOS behavior promised in Linux `1.0.0`. |

The package must select a binary without running a Rust compiler during installation. If there is no matching helper or required kernel primitive, inventory and other safe read-only functions may remain available, but unsupported scans or actions must be disabled explicitly. Binary packaging and integrity checks are a publication gate.

Node 24 remains the [LTS baseline](https://nodejs.org/en/about/previous-releases). Security fixes are issued on maintained release lines, including [the July 2026 fixes for both 24.x and 26.x](https://nodejs.org/en/blog/vulnerability/july-2026-security-releases), so a newer major alone is not a security update. The minimum versions above include the published fixes available on 2026-09-30; users should keep their chosen supported line at its latest security release. Node 25 is end of life and is not a supported runtime.

## Linux distribution test targets

| Environment | Planned checks | Current status |
| --- | --- | --- |
| Ubuntu | TypeScript/Rust checks, dpkg and apt adapters, integration tests, PTY tests, packed install. | Not validated. |
| Fedora | rpm/dnf adapters and Linux integration tests in container or VM. | Not validated. |
| Arch | pacman adapter and Linux integration tests in container or VM. | Not validated. |
| Host or VM with systemd and representative mounts | User timer, scoped privilege, mount topology, SMART where hardware permits, Btrfs/ZFS where available. | Not validated. |
| WSL | Detect Windows mounts and exclude `/mnt/c` by default; explicit selection behavior. | Not validated. |
| tmux and SSH terminal | 80×24 layout, mouse fallback, `NO_COLOR`, ASCII rendering, and terminal restoration. | Not validated. |

Containers cannot prove hardware health, real mount behavior, privilege prompts, or terminal behavior for every host. Those cases need a host or VM check before a support claim is made. Linux distribution names above describe the CI targets, not a complete compatibility list.

## Optional dependency behavior

| Dependency | Feature area | If absent or denied |
| --- | --- | --- |
| `lsblk`, mountinfo, `statfs` | Device, mount, capacity and inode inventory | Report what source is unavailable and mark inventory incomplete. |
| `lsof` | Deleted-but-open files | Show `missing-tool` or `permission-denied`; do not report zero open files. |
| `smartctl` | SMART health | Show unavailable or permission state. |
| apt/dnf/pacman, Snap, Flatpak | Package counts, sizes, managed cleanup | Disable only the affected adapter and show why. |
| Docker/Podman | Container footprint and cleanup | Disable the affected manager action; never delete its storage directly. |
| `notify-send`, systemd user instance | Opt-in desktop alert timer | CLI alert check remains usable; notification/timer capability is separate. |
| `sudo` or `pkexec` | Reviewed privileged manager action | Refuse that action when scoped elevation cannot run. Never elevate the whole npm process. |

Network and removable mounts are shown in inventory but scanned only on explicit selection. Scans stay on one filesystem by default. Permission-denied paths and optional-tool gaps must remain visible in TUI and JSON. A successful read-only inventory does not imply that cleanup is supported on the same host.
