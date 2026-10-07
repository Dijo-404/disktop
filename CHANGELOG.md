# Changelog

All notable changes to Disktop are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

## 1.0.0 — unreleased (release candidate)

The first public release. Everything below the Phase headings was built in internal
phases that were never published; this is the first version anybody can install.

### Status, 2026-10-07

Not published. Phases 0–7 are complete. Phase 8 (whole-product validation and the sole
release) is in progress:

- **Done and verified locally:** the package, the four-helper release build and its
  checksums, the packed-tarball install test, the hardening audit of every mutation, and
  a first run on real hardware — an Arch laptop with Btrfs on LUKS, subvolume mounts, a
  Windows partition, and a locked 4 TB LUKS drive. Those hardware runs exposed
  accounting and mount-policy defects now covered by regressions. The local gate (`npm run check`,
  the Rust format, lint, and test gates) passes: 1,084 unit and contract tests,
  128 integration, 13 recovery, 18 PTY, and 266 helper tests. The seven ordinary
  integration skips are external-tool, namespace, second-filesystem and opt-in timer
  or disposable-manager cases; separate gates passed real cross-device/full-disk/
  full-journal/read-only actions, actual apt/DNF5/pacman cache cleanup, a real user
  timer and SSH terminal restoration. All ten package checks
  passed on Node 26 glibc, Node 24 glibc and Node 24 musl. The million-entry benchmark
  passed all seven resource and latency checks. See [validation evidence](docs/release-readiness.md).
- **Publication gates:** green CI at the reviewed commit, including the ARM64 runners; the
  host and VM checks the support matrix still lists as not validated (distribution
  non-cache manager mutations under privilege, SMART health, ZFS and WSL); and,
  after publishing, provenance and a registry install verified on clean accounts.
- **Known limits, stated rather than hidden:** on Btrfs, reflinked and compressed files
  each report their full size, so a scan's file total can exceed what `df` reports as
  used (`uv`'s cache reflinks packages into virtualenvs); `du -x`, used for the
  measurement taken as root, stops at a Btrfs subvolume nested inside an unreadable
  directory; that measurement lists one level below each directory and is not
  browsable further.

### Phase 8: production hardening and release engineering

- Inventory includes every persistent partition and connected storage device, including
  unmounted filesystems, locked encrypted containers, swap, recovery partitions and
  partitions with unknown signatures. Shared RAID/LVM parents are counted once, and
  large `lsblk` byte counts retain their exact value in JSON and reports.
- The TUI uses Catppuccin Mocha, compact navigation, centered confirmation dialogs,
  aligned capacity and distribution bars, and clear partial-action outcomes. Small
  terminals, no color, ASCII rendering and repeated-session resource use have regressions.
- Wide directory snapshots, hardlink maps and duplicate size classes spill to bounded
  scratch indexes. Cancelled and superseded UI tasks retain one pending request per kind;
  native progress is coalesced while durable item outcomes apply backpressure.
- Hardlink replacement checks ACLs and extended attributes using open descriptors,
  including after exchange. Undo verifies the restored identity and rolls back a changed
  Trash entry. Journal files refuse symlinks, extra hardlinks and unsafe ownership.
- Stored plans and helper checksum files have bounded, no-follow reads. Plans and reports
  publish without replacing existing files; reports refuse filesystems without a safe
  publication primitive. Unavailable network mounts cannot exhaust Node's worker pool.
- Read-only discovery commands propagate cancellation to their process groups. User
  timer failures report the failing systemctl step and preserve units when disable fails.
  A real user-manager integration test exercises runtime timer installation and removal.
- Directory discovery refuses listings above its 4,096-entry bound explicitly, and
  package-cache discovery enforces a 10,000-entry bound across repositories; an
  omitted AppImage or package cache can no longer masquerade as a complete empty result
  or an exact zero count.
- Denied, failed or malformed ZFS snapshot readings report an incomplete result while
  retaining readable snapshots. Missing optional tools remain benign, and snapshot
  queries propagate cancellation without returning an empty success.
- Private mount-namespace tests cover a full output filesystem, a read-only source and
  cross-device moves, with source bytes preserved on refusal. Dependency advisory checks
  now gate both CI and publication, and distro CI exercises read-only manager adapters.
- Mandatory disposable-container checks run real apt/DNF5/pacman cache cleanup through
  reviewed plans, scoped sudo, live verification and the native journal. Cache fixtures
  are removed while package databases and sentinel data remain unchanged; wrapper
  cancellation cleans up its containers and temporary runtime.

### Phase 7: the complete terminal UI, reports, and completions

- The TUI is the whole product in a terminal, at 80×24 and down to 40×10:
  - **Disks**: usage bars per filesystem, and for the selected one a stacked bar that
    separates used, root-reserved, and available space, with its device, inodes, and
    every mount.
  - **Explore**: a stored scan, a directory at a time, with each entry's share of its
    parent, growth since the previous comparable snapshot, a trend sparkline of the
    total, and a file-type distribution. `f` cycles largest files, duplicates, stale
    files, empty directories, and broken links; `/` filters with
    `words ext:log >1GiB age>30 type:dir`, compiled to the same filter as `explore`.
  - **Clean**, **Dev**, **Apps**: findings with sizes that never pass an estimate (`~`)
    or an unmeasured size (`unknown`) off as a measurement, actionable findings totalled
    by category apart from informational ones, and which detectors could not run.
  - **History**: the journal item by item, with undo behind its own confirmation.
  - Reviewed plans: `c` reviews, `y` applies a reversible plan, an irreversible one
    needs `yes` typed. A plan that needs root suspends the TUI for the password prompt.
    Results keep selected bytes, bytes moved to Trash, and observed free space apart.
  - Scans with live progress; Esc stops a scan and keeps what it read.
  - Vim keys, arrows, number keys, mouse (rows, tabs, wheel), and `?` help.
  - `NO_COLOR` removes colour and keeps bold and inverse; a non-UTF-8 locale, the
    kernel console, or `DISKTOP_ASCII=1` get ASCII glyphs; `TERM=dumb` gets the text
    dashboard. Mocha foreground and background colors stay paired in colored modes;
    `NO_COLOR` uses the terminal's own colors.
- The renderer writes only the rows that changed, in one write, and measures terminal
  cells so wide and emoji names keep columns aligned. terminal-kit read `%s` and `^r`
  in a filename as its own format and markup syntax; frames now go through `noFormat`.
- Every piece of TUI work is cancellable and generation-checked, so a slow answer to an
  old question never replaces a newer one; leaving waits for an action to journal its
  current item. The TUI holds at most 10,000 rows of a directory and asks for a filter
  beyond that.
- `disktop report --format json|csv|html [--output FILE]` exports capacity, a stored
  scan (`--path`), and findings (`--findings`). CSV neutralises formulas and carries raw
  path bytes; HTML is one escaped file with no scripts and a restrictive CSP. A report
  never replaces an existing file.
- `disktop completion bash|zsh|fish`, generated from the command table that drives
  `--help`.
- The README carries a demo rendered from the TUI's own frames.

### Phase 8: hardening and release engineering

- Validated on a real dual-boot laptop (Btrfs on LUKS with subvolume mounts, an
  unmounted Windows partition, a locked 4 TB LUKS drive), which showed the following
  wrong answers; each fix has a test that failed first.
  - **A scan of `/` measured 22 GiB of a filesystem `df` says has 326 GiB used.** Every
    Btrfs subvolume mount (`/home`, `/.snapshots`, `/var/log`, ...) was refused as a
    nested mount, and `home/` showed `0 B`. The walk now enters a mount of the same
    filesystem that shows a part of it nothing else in the scan reaches, decided from
    `/proc/self/mountinfo` (same superblock, non-overlapping mount roots) and checked
    again on the opened descriptor; another filesystem and a bind mount repeating a
    reached tree are still refused, and the warning now says which. The same scan now
    accounts for 291 GiB. Snapshots record the policy (`sameFilesystemMounts`), so a scan
    from before is never subtracted from one after; the walk also stopped naming the
    filesystem of a mount point it only stat'ed, which had made the two look comparable
    and reported all of `/home` as growth.
  - **A directory the scan never entered read as empty.** Explore, `explore`, and the
    report show `?`/`unknown` and why (another mount, or unreadable) instead of its own
    few bytes. Opening a mount the newest scan stayed out of now offers a scan instead of
    an empty listing, and detectors, `explore`, `report --path`, and the TUI pick the
    newest scan that actually reached a path; three detectors used to fail with "That
    path is not in this scan".
  - **Partitions nothing had mounted were invisible.** `devices`, the Disks tab, and the
    report list data partitions and locked encrypted containers with their size, type,
    and label, and say how to mount or unlock them (`unmounted` in `devices --json`).
  - **Directories an ordinary user cannot read could only be counted.** `scan --sudo` and
    `A` in Explore measure them as root, read-only: the system's own `du` is raised
    through `pkexec` (the desktop's password dialog) or `sudo`, never anything Disktop
    ships. Sizes are kept beside the scan, open one level deep, and are never added to
    its totals. The index gained an `unentered` filter to list them.
  - zram swap (compressed RAM) was reported as 15 GiB of disk; it is left out.
  - Versioned and rotated names were their own file types (`libssl.so.3` as `.3`,
    `app.log.1` as `.1`); trailing version numbers are now skipped.
  - A FAT root's missing timestamp read as "56y ago" and 1970-01-01; it is unknown.
  - The HTML report listed the scan root first and every directory beside its own
    ancestors; it now shows what is directly inside the path with shares that add up,
    the largest files, unmounted partitions, and measurements taken as root, and groups
    hundreds of identical warnings into one line per kind. JSON and CSV carry the same
    (`children`, `largestFiles`, `elevated`, `unmounted`).
  - CLI warnings name their path, and the third and later of one kind are counted
    instead of printed hundreds of times.
- The package is `disktop@1.0.0`: only compiled JavaScript, the four helpers and their
  `SHA256SUMS`, the public CLI schemas, README, LICENSE, and this changelog. No install
  script; `prepublishOnly` refuses outside the guarded publish workflow.
- Four prebuilt helpers (x86-64 and ARM64, glibc 2.28+ and static musl) are built by
  `scripts/build-release.mjs`. The locator, the build, and both workflows agree on their
  names and on `SHA256SUMS`, and a test fails if they ever disagree again; before, a
  packaged install would never have found its helper.
- `npm run test:package` packs the tarball, checks it against an allowlist, installs it
  into a clean prefix, runs it, and proves a tampered helper is refused. CI builds all
  four helpers, runs the musl one on Alpine and the glibc one on the 2.28 floor, runs
  the recovery and performance suites, and tests the packed package on each target.
- Node side:
  - The helper client no longer crashes on a helper that stops reading (EPIPE), keeps a
    bounded line buffer, times out a handshake that never comes, and always reaps the
    process.
  - `--help` and `--version` answer without reading any configuration; a closed pipe
    (`disktop devices | head -1`) exits quietly with the command's own status; an
    unexpected error is one sanitized line and exit `2`.
  - Ctrl+C makes every long command stop at a safe boundary, report what it did, and
    exit `130`; a second Ctrl+C never abandons an item in progress.
  - Every external tool is bounded in output and time and killed if it overstays;
    preview and apply now reach the same Docker daemon; a manager command stopped before
    it started is reported as never run.
  - A dead network mount no longer hangs the dashboard; device and filesystem names
    cannot carry terminal escapes.
  - A snapshot whose recorded id did not match its file name could make pruning delete
    outside the snapshot store; it is now refused. Disktop's own files are read as
    regular files only, bounded, and written atomically with a directory fsync.
  - Under root, every file of the install, every symlink in it, and the Node binary
    itself must be root-owned.
  - Empty, repeated, and undecodable arguments are refused instead of guessed at.
- Helper (every mutation re-audited; each fix has a test that failed first):
  - A cross-filesystem move with permanent disposal could lose the only copy on a power
    cut: the destination directory is now fsynced after publishing and before the
    source is touched.
  - A source that changed while it was being copied could be published torn; it is
    revalidated before publishing and skipped as changed. Archive members are held to
    their header size.
  - A save landing between a hardlink replacement's byte compare and its exchange could
    be swapped out and lost; the compared descriptor is held across the exchange and
    anything else is exchanged back.
  - A file saved over a Trash target just before the rename went to Trash under the
    wrong identity; what arrives is checked and put back if it is not what was
    reviewed.
  - Very deep trees (beyond the stack) crashed the helper mid-item; every walk uses an
    explicit stack with one 512-level limit, refused at plan time and again before
    anything is touched.
  - Archive verification closed a descriptor twice, which could close an unrelated file.
  - Staging is created exclusively and only Disktop's own staged output is ever
    removed; read-only directories (Go's module cache) move correctly; an
    irreversible removal of a tree that contains one is refused before it starts
    rather than stopping halfway.
  - An item whose source could not be disposed of after publishing is settled as
    uncertain instead of staying "in progress" forever.
  - Cancel is honoured inside a large copy, archive, or verification, up to the
    publish; the staged output is removed and the item is skipped.
  - Names near `NAME_MAX` can be trashed, moved, and compressed; undo restores the full
    name.
  - `statx` is a raw syscall, so the static musl helper needs no libc version cfg.
  - A history page is bounded: a record lists at most 1000 items and counts the rest in
    `itemsOmitted`; undo still reads the whole record.
  - Reconciliation no longer treats the helper's own in-flight actions as abandoned.
  - A move into Trash and an undo's move back are durable before the journal records
    them: both directories are fsynced after the rename, and an fsync that fails leaves
    the item uncertain. A power cut could otherwise leave History saying a file moved
    while the disk still had it where it was.
  - A sparse file keeps its holes when it is moved to another disk; it was written out
    in full, so a disk image could arrive as large as it claimed to be and fill a
    destination the free-space check said it fit.
  - A file with several names inside a moved tree is copied once and linked under the
    rest, and inside a compressed tree it is stored once with tar hard-link members;
    each name used to become a copy of its own, needing more room than the plan
    measured.
- Scan and index (measured on a million-entry tree, release build):
  - Each scan is its own SQLite file, appended to with no secondary index and indexed
    once when the walk ends: a million-entry scan takes 5.2 s instead of 48 s and its
    index 241 MB instead of 565 MB.
  - Every query shape a surface uses is index-backed with row-value cursors: a
    directory's children come back in 0.2–1.7 ms at any page, a ranked subtree in
    0.6 ms, type totals in 85 ms instead of 712 ms. Query plans are asserted in tests.
  - The index directory and files were world-readable (`0755`/`0644`), exposing every
    name below a scan root to other users; they are now `0700`/`0600`.
  - Measuring a finding's size no longer evicts the person's own scan from the index:
    measurements get their own index.
  - A directory removed mid-scan is reported as a change during the scan rather than
    as unreadable; a fast scan sends at most ten progress events a second.
  - The duplicate search holds one size class at a time (helper peak memory 114 MiB →
    33 MiB on a million entries) and stops within milliseconds when cancelled.
  - A new `atPath` filter returns the one row at a path, which is how the TUI browses a
    directory even where a directory's own size ties with its files (Btrfs).
  - `explore` and `find` over a scan the index has since pruned say which scan to run
    again instead of failing as an internal error.
- The TUI plans a move to another disk and a compression, which it used to send to
  `disktop clean plan`: `o` on an Explore entry's review goes on to them, and a dialog
  that plans nothing asks for the destination (absolute or `~/`; a compression left
  empty goes beside its source) and, with Tab, whether the source then goes to Trash or
  is removed permanently. The review shows the destination, and `o` now steps through
  every operation on offer rather than only the first other one.
- Category totals no longer compare every finding with every other: at the most
  findings discovery returns, a findings tab redraws in 3 ms instead of half a second.
- Ctrl+C typed at a terminal reached the helper too (it shared the terminal's process
  group) and killed it mid-item, so a scan could not report and an action could not
  journal its item. The helper now runs in its own process group and is asked to stop
  by request ID; it still ends when Disktop is killed, because its stdin closes.
- TUI fixes from an independent review, each with a test that failed first:
  - A signal never abandons an action on a timer: it is asked to stop after its
    current item and waited for. Ctrl+C at a sudo or pkexec password prompt cancels
    that action and the TUI carries on.
  - A plan answered late can no longer replace an open dialog, so a key meant for one
    dialog cannot confirm another; a confirming key within 400 ms of a dialog
    appearing is ignored; a stopped plan's answer is dropped.
  - A duplicate copy is offered Trash or a byte-compared hardlink, never a plain
    permanent removal.
  - A plan is confirmed only at 60×20 or larger, where all of it is on screen; a
    manager review counts every command it will run.
  - One change to the disk at a time; History refreshes when an action finishes; a
    failed or superseded scan no longer leaves or steals the progress panel; cursors
    never outlive their query; flag and keycap emoji are measured two cells wide.

### Phase 6: manager cleanup, alerts, and the gaps earlier phases left

- `disktop clean` now lists what package and container managers can clean: apt, dnf, and
  pacman caches, archived journal files, disabled Snap revisions, unused Flatpak
  runtimes, dangling Docker and Podman images, stopped containers, anonymous volumes,
  Docker build cache, old kernels, and tmpfiles-policy temporary and crash files. Each
  finding shows the exact command it would run.
- `disktop clean plan managers:<action>` reviews one into a manager plan from a live
  preview; `clean apply --yes --permanent` runs it. Commands are derived from the plan's
  items by a fixed template and never stored. Root commands ask `sudo` or `pkexec` for
  that command only, and a refused password is reported, never worked around.
- A named Docker or Podman volume is reported and never offered; only volumes the engine
  marked anonymous are selectable. Old kernels keep the running and the newest one, and
  a purge is offered only when a simulated removal takes exactly those packages.
- The helper journals manager actions with `manager-begin`, `manager-append`, and
  `manager-finish`. A command that started and never reported back is `uncertain`.
- Running as root, Disktop changes no file itself and still runs reviewed manager
  actions.
- `disktop explore PATH --owners` reports bytes per owning user under any scanned path,
  and says when a total is a floor.
- `disktop alerts check --notify` (or `alerts.notify`) sends a desktop notification.
  `disktop timer install|uninstall` manages an hourly user timer that runs only the alert
  check.
- `disktop history --cursor --limit` reaches every page.
- Fixed gaps from earlier phases: a stored plan whose expiry was not a date never
  expired; a tool's stderr and a helper message reached the terminal unsanitized;
  Ctrl+C did not reach a duplicate search; a hardlink group spanning filesystems was
  only refused item by item; a crash left a partial copy nobody was told about; a
  directory with a mount below it could be a target; a reviewed directory was checked
  only by its own identity, so a change further down went unnoticed (plans now carry a
  digest of the whole subtree, taken with the new `inspect` operation, and emptying Trash
  checks it too); and a detector could ask an allowlisted tool to change something.

### Phase 5: advanced analysis and the actions that publish something

- `disktop find duplicates` reports groups of files that hold the same bytes, with the
  copy a `--keep oldest|newest|in-path` rule would keep and what removing the others
  would free. Two names for one inode are one member of a group. A rule that cannot
  separate the copies reports the group as undecided rather than guessing.
- `disktop find stale` lists files by **modification** time and says so. Nothing reads an
  access time: no index column holds one, and on a `relatime` or `noatime` mount one
  would not mean what a reader would take it to mean.
- `disktop clean plan --operation hardlink|move|compress`. A hardlink replacement names
  the copy it keeps; a move and a compression fix where they publish and what becomes of
  the source, and a `permanent` disposition makes the whole plan irreversible.
- The helper gained `hash-candidates`, `dedup-hardlink`, `copy-move`, and `compress`.
  Everything that publishes an output stages it, verifies it — by reading the written
  bytes back off the device for a copy, by decompressing it for an archive — publishes it
  with a rename that refuses to overwrite, and only then touches the source.
- A digest groups candidates; a byte compare authorises a mutation. Every operation that
  releases one copy of something because another copy exists re-reads both files in full
  immediately before the syscall. See
  [ADR 0006](docs/adr/0006-content-identity-and-archive-dependencies.md).
- `[[rules]]` blocks in `config.toml` describe cleanup you write yourself: roots,
  patterns, an age, a size, and hard limits. There is no field for a command. A plan
  records the rule's hash and an apply refuses it once the rule has been edited.
- Every action result now says what it checked afterwards, and a check that could not run
  is reported as unavailable rather than passed. A failed check keeps a result off
  `complete`.
- `disktop undo` now restores a move or a compression that trashed its source, and says
  that the copy or archive it published is still where it was put.

### Phase 4: the safe action engine

- Disktop can now change files. `disktop clean plan` reviews one finding or path
  into a stored, expiring plan and changes nothing; `clean apply PLAN_ID --yes`
  carries it out; `disktop history` reads the durable journal; `disktop undo
  ACTION_ID --yes` puts back what a Trash move moved.
- The plan fixes the operation at review time. `--permanent` acknowledges a plan
  that is already irreversible; applying it to a Trash plan is refused rather than
  read as an upgrade. A plan past its expiry describes a filesystem that may have
  moved on and is planned again rather than applied to whatever is there now.
- A result reports three numbers and never folds them into one: what the plan
  selected, what actually moved into Trash, and what the filesystem's own reading
  changed by. On one filesystem a Trash move is a large number of bytes moved and
  no space reclaimed, and the output says so. Two readings nobody could take leave
  the change unknown rather than zero.
- The Rust helper gained `trash`, `erase`, `empty-trash`, `restore`, and
  `journal-reconcile`. It resolves a target's parent one segment at a time from
  `/` with `openat2` and no symlink resolution, re-applies the protected-path
  policy from its own side of the process boundary, compares the live entry
  against the identity the plan recorded, and refuses a parent any user can write
  to without a sticky bit.
- Trash follows the freedesktop specification: the `.trashinfo` is reserved with an
  exclusive create, so two programs cannot both claim one name, and the move is
  `RENAME_NOREPLACE`, so the kernel refuses rather than overwriting. An undo moves
  back the same way, and a name something else has taken is skipped.
- Every item is journalled twice, intent before the syscall and outcome after.
  That is what makes a crash legible: an item holding only an intent reads as
  `uncertain`, and so does the action holding it. Nothing is ever promoted to
  complete. A record whose owning process is still alive is left alone.
- `disktop find empty` and `find broken` read the index a scan already wrote. The
  walk now records each directory's direct child count and whether each symlink
  resolves, so neither search is a second traversal. A directory the scan could
  not open carries no count at all and never answers a search for empty ones.
- Data that is in use offers no generic action, and a finding that names no path
  offers nothing generic. Both rules live in one place rather than in each
  detector's memory.
- `clean plan --operation empty-trash` empties Trash. It needs no subject, can
  name only this user's own Trash, and is irreversible, so applying it needs
  `--permanent`.
- An undo compares what is in Trash against the device and inode recorded when
  the move happened. A name is free again as soon as somebody takes the original
  out by hand, and an undo that trusted the name alone would move a stranger's
  file to a path it never came from.
- An item whose outcome could not be written to the journal is reported
  `uncertain` rather than completed. A stored plan's reversibility is re-derived
  from its operation rather than believed, and a plan naming an operation this
  build does not know is skipped.

### Phase 3: findings and application inventory

- `disktop clean` lists what every detector found and changes nothing. `clean plan`
  and `clean apply` still refuse; no detector can delete.
- A finding names the bytes it is about, where its number came from, how sure the
  detector is, and which operations a later phase could offer. `size.basis` is
  mandatory and there is no basis meaning "zero because nobody looked": an
  unmeasured footprint is `unknown` and carries no number, in memory and in JSON.
- Two detectors reaching the same directory merge rather than doubling the
  estimate, and the dropped finding's id is recorded in the survivor's evidence.
- Every detector appears in the output with its capability, including the ones
  that could not look. A denied detector makes the whole result incomplete and the
  command exits `3`; a missing tool does not, because the feature is absent rather
  than hidden.
- No detector traverses a tree, runs a command, or deletes. They name paths; one
  port measures all of them in a single helper scan, so every byte count in a
  result shares an accounting mode. Commands go through one allowlist.
- Detectors for conda, virtualenvs, pyenv, nvm/fnm/Volta/asdf, rustup, project
  build output, language and AI and IDE caches, browser profiles and their caches,
  Electron applications, Steam, Wine and Proton, disk images, Timeshift and btrfs
  and ZFS snapshots, swap, installed packages across seven managers, AppImages,
  oversized logs, crash dumps, deleted-but-open files, SMART health, WSL, and
  per-user usage.
- The helper gained an owner-totals index aggregate, counted over regular files
  only for the same reason the per-extension totals are.
- The helper rebuilds an index another build wrote rather than failing on the
  first write: the index is a cache, and every row in it can be scanned again.
- Text that came from outside Disktop is sanitized before it reaches a title or
  a piece of evidence, so a filename cannot colour a terminal or split a row.
- A category total counts each byte once: a finding sitting inside another one
  adds nothing and is counted separately as `nested`.

### Phase 2: scanner, index, search, and growth history

- The Rust helper walks a tree with `openat2` containment: `RESOLVE_BENEATH`,
  `RESOLVE_NO_SYMLINKS`, and `RESOLVE_NO_MAGICLINKS` on every descent, plus
  `RESOLVE_NO_XDEV` unless the scan asked to cross filesystems, so a symlink, a `..`, a
  procfs magic link, or a bind mount of the same filesystem cannot move it out of the
  subtree it was given. A kernel that refuses `openat2` gets `unsupported-kernel` and no
  scan; there is no fallback that drops the guarantee.
- The walk holds one open directory stream per level, so its descriptors and memory
  follow the tree's depth rather than its entry count, and it aggregates each directory
  on the way back up so directories can be ranked by subtree size without a second pass.
- Bytes are counted once per `(device, inode)`. A second hardlink is listed with
  `shared: true` and its bytes reported as `sharedBytes` rather than added to the totals,
  because deleting that path frees nothing.
- A directory that cannot be opened is counted and named, never rolled up as zero, and
  any scan that missed something reports `complete: false` with at least one warning.
  The schema rejects a partial result that carries no warning.
- Added the bounded SQLite index inside the helper: names as `BLOB` bytes with a separate
  normalized searchable column, parent IDs instead of repeated absolute paths, indexed
  size, extension, timestamp and owner columns, and pruning by scan count and byte
  budget. Paths are rebuilt one page at a time, so neither process holds the tree.
- Added `query-index`: keyset-paginated, filtered, sorted pages with an opaque cursor, so
  page 900 costs what page 1 costs and no row is repeated or skipped when the index is
  pruned between pages. Per-extension totals cover regular files only, because directory
  rows carry their subtree and would count the same bytes twice.
- The protocol now runs a scan on its own thread and emits `accepted`, `progress`, and a
  single `complete`. `cancel` stops a named scan at a directory boundary; it still writes
  its totals and emits a final event, so an interrupted scan leaves a usable index rather
  than nothing. Cancelling a request that is not in flight answers `unknown-request`.
- Implemented `disktop scan`, `disktop explore`, and `disktop snapshots list|diff`.
  Ctrl+C during a scan exits `130` with the partial result and its reasons. `explore`
  never scans: with no stored scan covering the path it names the command that makes one.
- Added versioned compact snapshots under `$XDG_DATA_HOME`, written to a temporary name
  and renamed into place so a crash mid-write cannot leave a truncated file that would
  later read as a smaller filesystem. Retention is by count and by byte budget, and never
  removes the only snapshot.
- `snapshots diff` compares two snapshots only when they measured the same thing: same
  roots, excludes, accounting mode, mount policy, and filesystems. Anything else is
  refused with every reason named. A diff is marked uncertain when either scan was
  partial or a directory appears on only one side, which is also what a rename looks
  like.
- Recorded the measured memory and latency budget in
  `docs/adr/0002-native-helper-and-index.md`: on a one-million-entry tree, Node's peak
  RSS is 70.6 MiB against 66.2 MiB at a tenth the size, the helper's is 14.9 MiB, first
  progress arrives in 148 ms, and an index page returns in 176 ms including process
  start. `npm run bench` reproduces them.
- Allocated totals are asserted equal to `du -x` over the same tree. Apparent totals are
  not compared: `du --apparent-size` excludes directories' own `st_size` and Disktop
  includes it.

After review, in the same phase:

- `disktop explore PATH` now narrows the listing to that path and everything below it.
  It previously used the path only to choose which scan to read, and then ranked the
  whole scan — so exploring one directory after scanning a home directory answered about
  the home directory while appearing to answer about the directory. The index records a
  subtree's primary-key range as the depth-first walk closes each directory, so the
  filter costs a key range rather than a descendant search.
- A scan's warning list is capped. One unreadable directory produced one warning with a
  full path, with no bound: 3,000 of them made a 1.7 MB JSON line and a 966 KB snapshot,
  and scanning `/` as an ordinary user is worse. Every occurrence is still counted, and
  the overflow is summarised per code as a `warnings-truncated` warning.
- Growth history follows the accounting mode the scan used. It previously reported
  allocated bytes whatever was asked for, so a sparse image growing 200 GiB of apparent
  size showed as no growth at all — the question `--accounting apparent` exists to answer.
- A scan's depth limit is part of a snapshot's scope. Without it, a depth-limited scan of
  an unchanged tree compared against a full one as a large deletion.
- A snapshot records the filesystems the walk actually read, reported by the helper,
  rather than the ones the roots sit on. Under `--cross-filesystems` the two differ, and
  two scans that traversed different mounts compared as though they had measured the same
  thing.
- `sharedBytes` is reported in the unit the scan was asked for. Under apparent accounting
  it was still allocated bytes, putting two units in one totals object and making a
  200 MiB second hardlink read as 4 KiB.
- An unexpected failure now writes one error envelope and exits `2`. A mangled `--cursor`
  previously printed a stack trace, wrote nothing to stdout, and exited `1` — which in
  Disktop's own exit codes means an alert threshold was reached, so a script could not
  tell a crash from a full disk. `--cursor` and `--limit` are validated before the helper
  is reached.
- A malformed `throttleBytesPerSecond`, `maxDepth`, `keepScans`, or filter integer is
  refused as `invalid-arguments` instead of silently falling back to a default, which
  would have run a different scan than the one asked for.
- A panicking scan worker still emits a terminal event, and a poisoned writer lock no
  longer swallows one. A client waits for a terminal event and has no timeout, so a
  dropped one hung it for as long as the helper lived.

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
