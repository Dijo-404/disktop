# Findings and providers

Status: planned provider contract and release inventory. See [PLAN.md](../PLAN.md#provider-inventory-for-the-one-release) for the full acceptance matrix.

## Provider boundary

A provider is a read-only discovery component. It receives a bounded scan or known manager scope through ports and returns `Finding` objects. A finding includes a stable, versioned provider ID, category, evidence, path or manager scope, allocated/apparent size or a manager estimate, confidence, capability, and available action IDs. Provider output is a suggestion, never a deletion command.

The application service deduplicates overlapping findings and creates an immutable action plan. `src/providers` cannot mutate arbitrary files, call `fs.rm`, or invoke cleanup commands. `src/platform/linux/managers` implements fixed-argument manager adapters and their probe, bounded preflight, apply, and verification steps. Even those adapters operate only after the common reviewed action pipeline accepts a plan.

Every new provider must state:

1. Its discovery roots or manager query and how scope stays bounded.
2. How size is measured, whether hardlinks or shared caches affect totals, and whether bytes are estimates.
3. How it recognizes active data, user data, and regenerable cache; unknown data must not be relabeled as safe cache.
4. The capability and permission states it can produce.
5. Its action reversibility and what a partial or failed result looks like.
6. Its stable ID and effect on public JSON or saved plan compatibility.
7. Its fixture and [feature-matrix](../PLAN.md#feature-acceptance-matrix) acceptance check.

## Capability states

The common capability value is `available`, `missing-tool`, `permission-denied`, `unsupported-kernel`, `unsupported-filesystem`, or `unsupported-architecture`, accompanied by an explanation. A provider can also return a complete or incomplete discovery result with inaccessible paths and excluded scopes. Missing Conda, `smartctl`, or Docker is reported as an unavailable relevant feature, not as proof that it uses zero bytes. Some providers are read-only even when their discovery succeeds.

## Provider areas for `1.0.0`

| Area | Planned coverage | Action boundary |
| --- | --- | --- |
| Developer environments | Conda environments and package cache; venvs; pyenv, nvm/fnm, and rustup versions. | Prefer manager-owned removal when available. Otherwise, reviewed Trash for eligible inactive user-owned artifacts. |
| Project artifacts | `node_modules`, Rust `target`, Python `__pycache__`, `.next`, and configured build outputs across projects. | Show project context and last modification before offering a reviewed action. |
| Language and AI caches | npm, yarn, pnpm, pip, Cargo, Go, Maven, Gradle, Hugging Face, Ollama, and PyTorch hub. | Separate model or source assets from reproducible cache and label regeneration cost. |
| IDE, Android, browser, Electron | JetBrains, VS Code, Android SDK/emulators, Chrome/Chromium, Firefox, and application `Cache`/`GPUCache` directories. | Never equate a browser profile, SDK, emulator image, or extension with disposable cache. |
| Games and VM data | Steam libraries and games, Wine/Proton prefixes, VirtualBox/libvirt/GNOME Boxes images, Timeshift data. | Footprint first; active images and snapshots need special gates. |
| System cleanup | User temp, thumbnails, Trash, apt/dnf/pacman caches, archived journal logs, old kernels, Snap revisions, unused Flatpak runtimes, Docker/Podman resources, crash/core files. | Manager-owned data uses manager adapters; `/tmp` and crash data require explicit policy and selection. |
| Diagnostics | Oversized logs and likely cause, deleted-but-open files, SMART, Btrfs/ZFS snapshots, swap and hibernation, per-user usage. | Primarily read-only. Never truncate active logs or remove swap just because they are large. |
| Installed applications | dpkg, rpm, pacman, Snap, Flatpak, global npm/pip, configured AppImage roots. | Report counts and manager-provided installed sizes separately from measured app data and cache. |

Provider fixtures should include missing tools, denied paths, overlapping results, active files, hardlinks, invalid-byte names, and manager output changes. A detector is complete only when its preview and capability behavior are understandable in both TUI and JSON.
