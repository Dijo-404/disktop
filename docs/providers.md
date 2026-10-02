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

## The detectors this release ships

Every one is registered in `src/providers/index.ts` and nowhere else, so the
set a release discovers is readable in one place.

| Provider id | What it reads |
| --- | --- |
| `dev.conda` | conda and mamba prefixes, their environments, and the package cache. A `conda-meta` directory is the proof; a directory under `envs` without one is somebody's notes. |
| `dev.python-envs` | Virtual environments in the collection directories and, through a stored scan, inside projects. `pyvenv.cfg` is the proof. |
| `dev.pyenv` | Interpreters pyenv built, with the one `~/.pyenv/version` names marked in use. |
| `dev.node-versions` | nvm, fnm, Volta and asdf Node installations, with the default alias marked in use. |
| `dev.rustup` | Toolchains and the download cache, with the toolchain `settings.toml` names marked in use. |
| `dev.project-artifacts` | Build output found through the stored scan index. A `target` beside a `Cargo.toml` is likely; one on its own is uncertain. |
| `cache.language` | npm, Yarn, pnpm, pip, uv, Cargo, Go, Maven, Gradle, Composer and NuGet caches. |
| `cache.ai` | Hugging Face, Ollama, PyTorch, Keras and Whisper model stores, all marked in use. |
| `cache.ide` | JetBrains, VS Code, Android SDK and emulator directories. |
| `cache.browser` | Chromium and Firefox profiles and their caches, kept apart. |
| `cache.electron` | Chromium caches inside any application's data directory, found by looking rather than by a list of applications. |
| `storage.steam` | Steam libraries, games sized from their own manifests, and Proton prefixes. |
| `storage.wine` | Wine, Lutris, Bottles and PlayOnLinux prefixes, proved by `system.reg`. |
| `storage.virtual-machines` | Disk images, with allocated and apparent bytes reported apart. |
| `storage.system-snapshots` | Timeshift snapshots, btrfs subvolumes and ZFS snapshots. Read-only. |
| `storage.swap` | Active swap areas and inactive swap files. Read-only. |
| `apps.installed` | dpkg, rpm, pacman, snap, Flatpak, global npm and pip, and configured AppImage roots. |
| `diagnostic.logs` | Oversized files under `/var/log` with their logrotate evidence, and the journal's own footprint. |
| `diagnostic.crash` | Crash and core dump directories; only a user-owned one is offered. |
| `diagnostic.open-deleted` | Files deleted while a process still holds them open, which is why `du` and `df` disagree. |
| `diagnostic.smart` | Each disk's own health report. |
| `diagnostic.windows-subsystem` | Under WSL, what the default excludes leave out. |
| `diagnostic.per-user` | Owner totals from the stored scan index. |

### What a detector may not do

No provider traverses a tree, runs a command directly, or deletes anything;
`npm run lint` refuses all three. A provider names paths and the application
service measures them through the `FootprintPort`. Commands go through the
`ToolPort`, whose allowlist in `src/platform/linux/tools.ts` is the whole set
of programs Disktop can run; a name outside it is refused before anything is
spawned.

### Incomplete is not empty

A detector that could not look says so. `missing-tool` and the `unsupported-*`
states leave the run complete, because the feature is genuinely absent on this
machine. `permission-denied` does not: the data is there and Disktop could not
read it, so the whole result is incomplete and `disktop clean` exits `3`. A
detector that throws is reported and skipped rather than ending the run, and
its report carries `ran: false` so it is never mistaken for one that looked
and found nothing.

Two tools cannot be read this cleanly and say so instead of guessing.
`btrfs subvolume list /` prints the same "Operation not permitted" on a
filesystem that is not btrfs and on one that needs privilege, so the warning
names both possibilities and the run stays complete. `smartctl` exits non-zero
with an empty stderr and puts the reason inside its JSON, so the denial is
read from the document.

### Nothing a detector did not establish

A detector never asserts what it could not check. nvm writes `lts/iron` into
its alias file, so when the alias cannot be resolved every version is reported
as possibly in use rather than as idle — calling them all idle would offer
somebody's only Node runtime for removal. A disk image cannot be proved idle
without privilege, so every image is `active`. A `target` directory with no
`Cargo.toml` beside it is `uncertain`.

Text that came from outside Disktop — a filename, a package name, a Steam
manifest, a drive model, a line of `/etc/passwd` — is sanitized before it
reaches a title or a piece of evidence. A title is written to a terminal
unescaped, and a directory named with an escape sequence would otherwise
colour the output or split a row in two.

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

## Which actions a finding may offer

A finding names the operations a reviewed plan could later fix for it, and nothing
more: `availableActionIds` is a suggestion a surface may show, never a capability a
detector holds. Two rules are applied in `buildFinding` rather than left to each
detector to remember, so a new detector gets them for free:

- Data that is in use offers no generic action. A browser profile, a model store, an
  SDK and an emulator image are worth reporting and are not things to move to Trash
  behind somebody's back. Mark such a finding `active` and every path-based operation
  is dropped from it.
- A finding that names no path offers nothing generic, because there is nothing for a
  generic action to act on. Only `manager` can reach a manager's own state, and the
  manager adapters are Phase 6.

`clean plan` re-checks the path against the protected-path policy afterwards, and the
helper checks it again from the other side of the process boundary. The rules here are
the floor, not the guarantee. `tests/unit/provider-actions.test.mjs` holds every
built-in detector to them against three fixture homes.

## Cleanup rules somebody wrote themselves

`[[rules]]` blocks in `config.toml` become findings through the `rules` provider, which
has the same shape as every other detector and deliberately no more power.

A rule is data and only data: roots, name patterns, excludes, kinds, a minimum age, a
minimum size, and hard limits on how much it may select. There is no field for a command
and no combination of fields that becomes one. `config.toml` is a file other programs can
write to, and a configuration format that could name a command is a configuration format
that can be made to run anything.

Roots go through `isRefusedAsAllowedRoot`, the same check that bounds `additional_allowed_roots`,
so a protected system root or a shared container root such as `/home` is refused as the
file loads. A pattern that is absolute or that holds a `..` segment is refused for the
same reason: a rule may not reach outside the roots it declares. Patterns match against the path's own text rather than its sanitized rendering, and a
name that does not decode cleanly is left unmatched — the safe direction, since nobody
can type a pattern for bytes that are not text.

`*` matches within one path segment, `**` across segments, and `?` one character;
nothing else is special. A trailing `**` matches the directory it names and everything
under it, so `excludes = ["private/**"]` protects that whole tree — an exclusion that
silently matched nothing would be the worst possible failure for a rule that removes
files. `**` is a whole path segment on its own: `a**` is refused rather than guessed at.
Matching is a direct walk of the pattern rather than a compiled regular expression,
because a regular expression built from several `**` segments backtracks, and a pattern
that takes seconds to fail is one that hangs this program.

A rule's name is printed, so it may not hold control or direction-changing characters,
and two rules whose names reduce to the same identifier are refused rather than silently
merged.

`maximum_count` and `maximum_bytes` are enforced during selection rather than checked
afterwards. A rule that says "at most twenty gigabytes" and produces a plan for two
hundred has already failed at the thing the limit was written for; the finding stops at
the limit and its evidence says it did.

The provider reads a stored scan's index through `IndexSearchPort.entriesUnder`. It never
walks a tree, never runs a command, and never removes anything. A root no stored scan
covers makes the result incomplete and names the scan that would fix it, because "nothing
matched" and "nobody looked" are different answers.

A plan built from a rule records that rule's hash, which is taken over the rule's fields
in a fixed order so that reordering the file changes nothing and editing the rule changes
everything. `disktop clean apply` reads the rules again and refuses a plan whose hash no
longer matches: the confirmation somebody gave was for the selection the old rule
described, and it does not carry over to a new one.
