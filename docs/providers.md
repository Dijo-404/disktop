# Findings and providers

Status: the finding contract and the Phase 3 detectors. See [PLAN.md](../PLAN.md#provider-inventory-for-the-one-release) for the full acceptance matrix.

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

## What a finding carries

`src/domain/findings.ts` defines the value and the policy; `schemas/cli/v1/common.json`
publishes it. Every finding has:

| Field | Meaning |
| --- | --- |
| `id` | `<providerId>:<slug>`, stable across releases so a saved plan keeps its meaning. |
| `providerId`, `providerVersion` | Which rule produced it, and which version of that rule. |
| `category` | One of a closed set, so a surface can group findings without parsing prose. |
| `title`, `evidence` | What it is, and what proved it. |
| `paths` | The bytes the finding is about. Empty when the scope belongs to a manager. |
| `managerScope` | A bounded manager selection, never a shell line. |
| `size` | `{ bytes?, basis, explanation }`. |
| `confidence` | `observed`, `likely`, or `uncertain`. |
| `capability` | Why a reading is absent, when it is. |
| `availableActionIds` | What a later phase could offer. Phase 3 applies nothing. |
| `regenerationCost` | What getting the data back would cost, when it is reproducible. |
| `active` | True when the data is in use: a browser profile, a model store, a disk image. |

### No unlabelled size

`size.basis` is one of `measured-allocated`, `measured-apparent`,
`manager-reported`, `stat`, or `unknown`. There is no basis that means "zero
because nobody looked": a footprint nothing measured is `unknown` and carries
no number at all, in memory and in JSON. `findingSize` refuses a number with an
`unknown` basis and refuses any other basis without a number, so the rule
cannot be broken by a provider that forgets it.

A provider does not measure its own directories. It reports the paths, and
`src/application/footprint.ts` measures them through the `FootprintPort`, which
reads the helper's scan index. Nothing in `src/providers` walks a tree.

### No duplicate findings

Two providers can legitimately reach the same directory: an Electron detector
and an IDE detector both see `~/.config/Code/Cache`. `deduplicateFindings`
keeps the broader scope and drops the narrower one when it comes from a
*different* provider, recording the dropped id in the survivor's evidence so
nothing disappears silently. A provider is trusted about its own tree, so
`dev.conda` may report a prefix and the `pkgs` cache inside it. A repeated id
survives once.

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
