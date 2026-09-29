# Linux support matrix

Status: **release targets, not validated support claims**. The repository is a scaffold, and no platform row below is certified yet. Phase 0 fixes exact minimums and Phase 8 supplies install and acceptance evidence before publishing the single `1.0.0` release.

## Runtime and binary targets

| Component | Target | Required validation before release |
| --- | --- | --- |
| Node.js | 24 LTS | CLI, TUI, reports, and packed-package smoke tests. |
| Linux kernel | 5.6 or newer for full native scan and mutation | Probe `openat2` and action behavior. Older or restricted kernels must show explicit unsupported states. |
| x86-64 glibc | Bundled `disktop-fs` binary | Check checksum, permissions, protocol, and clean-account install. |
| x86-64 musl | Bundled `disktop-fs` binary | Same checks in a musl environment. |
| ARM64 glibc | Bundled `disktop-fs` binary | Same checks on ARM64. |
| ARM64 musl | Bundled `disktop-fs` binary | Same checks on ARM64 musl. |
| macOS | Platform boundary only | No macOS behavior promised in Linux `1.0.0`. |

The package must select a binary without running a Rust compiler during installation. If there is no matching helper or required kernel primitive, inventory and other safe read-only functions may remain available, but unsupported scans or actions must be disabled explicitly. Binary packaging and integrity checks are a publication gate.

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
