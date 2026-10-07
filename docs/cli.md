# CLI contract

Status: planned `1.0.0` command surface. Every command the parser declares is implemented: `devices`, the `--json` dashboard, `alerts check`, `scan`, `explore`, `snapshots list|diff`, `clean`, `clean plan`, `clean apply`, `history`, `undo`, `find duplicates|stale|empty|broken`, `timer install|uninstall`, `report`, and `completion bash|zsh|fish`. The JSON output contract in [`schemas/cli/v1/`](../schemas/cli/v1/) is normative and is validated by `tests/contract/cli-schema.test.mjs` against examples and by `tests/integration/cli-output.test.mjs` against what the CLI actually writes on a running host. The parser, the generated help, and the generated completions are normative. See [PLAN.md](../PLAN.md#cli-and-outputs).

## What works today

| Command | Behaviour |
| --- | --- |
| `disktop` | Opens the [terminal UI](#terminal-ui) when stdin and stdout are both terminals and `TERM` can address the cursor, and prints the text dashboard otherwise (a pipe, `TERM=dumb`, or no `TERM`). |
| `disktop --json` | One `dashboard.json` envelope: capability, filesystems, and alerts. |
| `disktop devices [--json]` | All connected persistent disks (including separate SSDs, USB storage, memory cards and optical drives), their partitions and logical volumes (`volumes`), and every readable mounted filesystem. Firmware, recovery, reserved, swap and partitions with unknown filesystem signatures remain visible. RAID/LVM volumes name every backing disk. Usage is unknown without a readable mount; nothing is mounted or unlocked automatically. The legacy `unmounted` array remains the data-only subset. |
| `disktop alerts check [--threshold PERCENT] [--notify] [--json]` | Space and inode thresholds. Exits `1` when one is reached. `--notify`, or `alerts.notify` in the configuration, also sends one desktop notification; one that could not be sent is a warning and never changes the exit status. |
| `disktop scan [PATH] [--json]` | Walks `PATH` (the working directory by default) through the helper, writes the detailed index, and saves a snapshot. `--accounting allocated\|apparent`, `--cross-filesystems`, `--throttle RATE`, `--max-depth DEPTH`, `--sudo`. Ctrl+C stops it at a directory boundary and still reports what was measured. |
| `disktop explore [PATH] [--json]` | One page of `PATH` and everything below it, from the most recent scan covering it. `--sort`, `--order`, `--kind`, `--min-size`, `--max-size`, `--ext`, `--name`, `--older-than DAYS`, `--limit`, `--cursor`, `--type-totals`, `--owners`. |
| `disktop snapshots list\|diff [--json]` | Lists saved snapshots, or compares two of them (`--from`, `--to`; the two most recent by default). |
| `disktop clean [--json]` | Lists what every detector found, and changes nothing. `--dry-run` is accepted and redundant. `--category CATEGORY` narrows the list, `--limit COUNT` shortens it, and `--no-sizes` skips measurement so every size stays unknown. |
| `disktop clean plan [FINDING_ID] [--path PATH] [--operation trash\|permanent\|empty-trash\|move\|compress\|hardlink\|manager] [--json]` | Reviews one finding or path into a stored, expiring plan. Changes nothing. `--operation empty-trash` needs no subject and can name only this user's own Trash. A `managers:` finding is planned as a manager action without naming the operation. |
| `disktop clean apply PLAN_ID --yes [--permanent] [--json]` | Applies an already-reviewed plan, revalidating every item against the identity the plan recorded. |
| `disktop history [--cursor CURSOR] [--limit COUNT] [--json]` | The durable action journal, newest first, with interrupted records resolved as it is read. A cursor the journal did not issue is an input error. A record lists at most 1000 of its items and says how many it left out in `itemsOmitted`; its counts still cover every item, and `undo` reads the whole record. |
| `disktop timer install\|uninstall [--json]` | The opt-in hourly systemd user timer that runs only `alerts check --notify`. |
| `disktop undo ACTION_ID --yes [--json]` | Puts back what one Trash action moved. |
| `disktop report --format json\|csv\|html [--output FILE] [--path PATH] [--limit COUNT] [--findings] [--json]` | One standalone report: capacity, and optionally a stored scan and what the detectors found. Written to stdout, or to a new file that is never put over an existing one. See [Reports](#reports). |
| `disktop completion bash\|zsh\|fish` | Prints a completion script generated from the same command table the parser reads. See [Shell completions](#shell-completions). |
| `disktop find empty\|broken [--path PATH] [--limit COUNT] [--json]` | Empty directories and dangling symlinks, read out of the most recent scan covering the path. |
| `disktop find duplicates [--path PATH] [--min-size SIZE] [--keep oldest\|newest\|in-path] [--keep-under PATH] [--limit COUNT] [--json]` | Groups of files holding the same bytes, with the copy a keep rule would keep. Reads content; changes nothing. |
| `disktop find stale [--path PATH] [--older-than DAYS] [--limit COUNT] [--json]` | Files not modified for a threshold, with a statement of what that measures on this mount. |
| `disktop --units iec\|si` | Switches human-readable units. Byte values in JSON never change. |
| `disktop --help`, `disktop --version` | Generated from the one command table in `src/cli/parser.ts`. |

A command declared in the table before it is built is marked `[planned]` in the help, parses and validates its options, and then refuses with `not-implemented` and exit `2`, in the same envelope shape a working command uses. None is at present.

## Scanning, exploring, and growth

`scan` does not delete or move anything. It walks the tree through the Rust helper, which opens every directory with `openat2` containment: it never follows a symlink, and without `--cross-filesystems` it stays on the filesystem the root is on. That filesystem includes its other mounts below the root that show a part of it nothing else in the scan reaches — Btrfs subvolumes mounted at `/home`, `/var/log`, or `/.snapshots` are the common case, and a scan of `/` that stopped at them would account for a fraction of what `df` reports as used. A mount of a different filesystem (`/boot`, `/proc`, a USB disk) is refused, and so is a bind mount repeating a tree the scan already reaches, so nothing is counted twice; each refused mount is listed in `excludedMounts` with a warning saying which of the two it was. A directory it cannot open is counted and named, never treated as empty, and any scan that missed something reports `complete: false` with at least one warning.

`--sudo` then measures the directories the scan could not read, with administrator rights: the system's own root-owned `du` runs read-only through `pkexec` (a desktop password dialog) or `sudo` (a password prompt on the terminal), with fixed flags and the absolute paths as its only arguments. Nothing Disktop ships runs as root. The sizes are kept beside the scan, one level deep, and are never added into its totals; the scan stays `incomplete` because the index still cannot browse inside those directories. `scan --json` reports them under `elevated` (`common.json#/$defs/elevatedMeasurement`); a refused or cancelled password prompt is `status: "denied"`, and a machine where nothing can ask for administrator rights is `unavailable`. `explore` and `report` show the measured sizes where they apply, and the TUI does the same from Explore with `A`.

Bytes are counted once per inode. A second hardlink to an inode the scan already counted is listed with `shared: true`, and its bytes are reported as `sharedBytes` rather than added to the totals, because deleting that path frees nothing.

A directory's `allocatedBytes` and `apparentBytes` are the totals for its whole subtree; a file's are its own. Per-extension totals cover regular files only, for the same reason: adding directory rows to them would count the same bytes twice.

`explore` never scans. It reads the index a previous `scan` wrote, and the path narrows the listing to that directory and everything below it, so exploring `~/Downloads` after scanning `~` answers about Downloads. If no stored scan reaches the path — none has a root above it, or every one that does stayed out of a mount or exclude between the two — it says so and names the command that would produce one. A directory the scan never went inside is listed with `?` for its size and says why (`another mount, not scanned`, or `unreadable, size unknown`), or with its size measured as root when `--sudo` measured it; its own few bytes are never printed as though it were nearly empty.

A scan of a tree with many unreadable directories reports every one of them in `inaccessibleDirectories`, but lists at most a few hundred individually and then summarises the rest as a `warnings-truncated` warning giving the count per code. Nothing is hidden; the list is bounded so that the output, the index, and every stored snapshot do not grow with the filesystem.

`snapshots diff` compares two snapshots only when they measured the same thing: same roots, same excludes, same accounting mode, same mount policy, same depth limit, and the same filesystems — the ones the walk actually read, which is not the same as the ones the roots sit on once a scan is allowed to cross a mount. The comparison reports the column the scan measured, so an apparent-accounting history shows apparent growth; a sparse image that grows by gigabytes without allocating a block is exactly why that matters. Anything else is refused, because subtracting a scan that excluded a directory from one that did not produces a number indistinguishable from real growth. A diff is marked `uncertain` whenever either scan was partial or a directory appears on only one side, since that is also what a rename looks like.

### Comparing against `du`

`disktop scan --json` reports `allocatedBytes` on the same basis as `du -x --block-size=1`: `st_blocks × 512`, each inode counted once, no other filesystem entered. The two agree exactly on the same tree, and `tests/integration/scan.test.mjs` asserts it. On Btrfs they differ by design: `du -x` stops wherever the device number changes, which is at every subvolume, mounted or not, while Disktop walks the subvolumes of the filesystem it is scanning.

`sharedBytes` is reported in the same unit as the totals beside it, so the two can be compared directly.

Apparent bytes are not comparable against `du`. `du --apparent-size` leaves the directories' own `st_size` out of its total and Disktop includes it, so the two are answering different questions. Neither figure is what `df` reports either: reflinks, compression, snapshots, and open-but-deleted files all make a tree's size differ from a filesystem's free space.

## Command tree

```text
disktop                                      Open the TUI
disktop --json                               Dashboard without a TTY
disktop devices --json
disktop scan [PATH] --accounting allocated|apparent --cross-filesystems --sudo --json
disktop explore [PATH] --sort allocated --min-size 1GiB --ext log --json
disktop find duplicates|stale|empty|broken [PATH] --json
disktop snapshots list|diff --json
disktop clean --dry-run --json
disktop clean plan FINDING_ID --operation trash|permanent|move|compress|hardlink --json
disktop clean plan --path PATH --operation trash --json
disktop clean apply PLAN_ID --yes --json
disktop clean apply PLAN_ID --yes --permanent --json
disktop history --json
disktop undo ACTION_ID --yes --json
disktop report --format json|csv|html [--output FILE] [--path PATH] [--findings]
disktop alerts check --threshold 90 --json
disktop timer install|uninstall
disktop completion bash|zsh|fish
```

The parser in `src/cli/parser.ts` defines commands and options once, and drives help plus completions. The CLI and TUI invoke the same application use cases. Any command that scans shows progress on stderr, and only when stderr is a terminal: redirected into a log or a pipe, a carriage-return progress line is noise, and `--json` never draws one. It can be cancelled, and reports an incomplete result when it could not inspect the full selected scope. Disktop does not use an interactive prompt when `--json` is requested or stdout is not a TTY.

## Listing what was found

`disktop clean` runs every detector and prints what they found. It applies
nothing, and no detector can delete; acting on a finding is `clean plan` and
`clean apply`.

Four rules shape the output. Every detector appears in `providers` with its
capability, including the ones that could not look; `ran` is false when it
never answered, whether it was absent, denied, or it threw. A detector that is
`permission-denied` makes the whole result incomplete — the data is there and
Disktop could not read it — and the command exits `3`; a `missing-tool`
detector does not, because the feature is genuinely absent. Every size carries
a `basis`: a footprint nothing measured is `unknown` and carries no number,
never zero. And a `categoryTotal` counts each byte once: `nested` is how many
findings in that category sit inside another one, so a browser profile and the
cache directories inside it do not add up to more than the filesystem holds.

Sizes are measured in one pass after discovery, by the same scan index `scan`
and `explore` read, so every number in one result shares an accounting mode.
Asking for sizes and getting none is an incomplete result, not a complete one.
`--no-sizes` skips the pass on purpose, which is much faster, leaves directory
footprints unknown, and does not itself make discovery incomplete.

Detectors inspect known directory structures within a 4,096-entry listing bound.
A directory above that bound produces an explicit warning and an incomplete result,
never a sampled count presented as exact. Package-cache discovery also inspects at
most 10,000 entries across all of a manager's cache directories. An affected manager
preview is refused when either bound is exceeded.
Use `scan` and `explore` for larger directories; their native index streams entries
without this discovery limit.

Ctrl+C stops discovery at the next detector boundary. `clean` writes nothing
while it runs; measuring sizes over a large home directory can take a while,
and `--no-sizes` is the quick look. The TUI shows the same discovery with a
spinner and Esc to stop it.

## Reviewed actions

`clean --dry-run` lists eligible findings and actions. `clean plan` creates an expiring immutable plan for a finding or explicitly selected path. The plan contains its operation, scope, exact or estimated totals, warnings, reversibility, and required permission. Move and compression plans will also fix the destination and whether the original source goes to Trash or is permanently removed. Large manifests remain disk-backed.

`clean apply PLAN_ID --yes` applies the already-reviewed operation after live revalidation. `--yes` does not skip planning. `--permanent` only acknowledges a plan that already contains irreversible removal; applying it to a Trash plan is refused rather than taken as an upgrade. CLI cleanup defaults to dry-run. `undo` uses the action journal and refuses destination collisions or changed outputs. Manager actions will expose estimated or unknown scope honestly when a manager cannot preview exact counts.

A plan expires: past `expiresAt` it describes a filesystem that may have moved on, and
applying it is refused rather than retried against whatever is there now. The expiry
is `cleanup.plan_expiry_minutes` in `config.toml`, sixty minutes by default.

An apply reports three numbers and never folds them into one. **Selected bytes** is
what the plan reviewed. **Bytes moved to Trash** is the reviewed size of what actually
moved, which on one filesystem is not space anybody got back until Trash is emptied.
**Observed free-space change** is `statfs` before and after; it is absent rather than
zero when either reading failed, and other processes write to the same filesystem, so
it is never presented as this action's doing alone.

An action that skipped or failed anything exits `3`, so a script that never reads the
JSON still learns that what was reviewed is not what happened.

`--operation move` and `--operation compress` fix two more things that apply time may
not change: `--destination PATH`, the directory the output is published into, and
`--source trash|permanent`, what becomes of the original once that output is verified.
A move has to name a destination — "somewhere else" is the whole point of one and
there is no disk Disktop may pick on somebody's behalf — while a compress publishes
beside the source unless told otherwise. A move onto the source's own filesystem is
refused: it frees nothing, and `mv` already does it.

A destination is judged by its own policy rather than by the one that bounds what
Disktop may remove, because a cross-disk move means writing outside the user's roots by
definition. `/mnt/archive` is a legitimate destination and an illegitimate target. What
still applies is everything that says "not yours to write into": the protected system
roots, the shared container roots themselves, and Trash and Disktop's own state.

`--operation hardlink` replaces one copy of a file with a second name for another copy,
freeing the replaced copy's bytes. It is irreversible, so it needs `--permanent` at apply
time like any other irreversible plan. From an explicit path it takes a pair: `--path` is
the copy that survives and `--replace PATH` is the copy that becomes a name for it. The
plan records which one is kept rather than leaving it to the order of its entries. Before
anything is linked, the helper reads both files in full and refuses unless they hold
exactly the same bytes, and refuses again if their owner, group, or permissions differ —
one inode has one set of those, and linking would silently change the replaced file's.

`--source permanent` makes the whole plan irreversible and carries the warning that
says so, because publishing a copy and then releasing the original's bytes is a
permanent removal with an extra step.

`--operation compress` writes `<name>.zst` for a file and `<name>.tar.zst` for a
directory, beside the source unless `--destination` says otherwise. The archive is
verified by decompressing it and comparing what comes out against what went in, before
it is published and before the source is touched.

A move is carried out as a staged copy, not a rename: the bytes are written under a
partial name in the destination, read back off the device and compared against what was
read from the source, and only then published with a rename that refuses to overwrite.
The source is not touched until that has happened, so a move that fails at any point
leaves it exactly where it was.

A plan built from one of your own `[[rules]]` records that rule's identity. If you edit
the rule before applying the plan, the apply is refused and asks you to review it again:
what you confirmed was the selection the old rule described. See
[providers.md](providers.md#cleanup-rules-somebody-wrote-themselves) and
[config.example.toml](config.example.toml).

Planning by `FINDING_ID` rediscovers first, so it takes as long as `disktop clean`
does. Planning `--path` does not. A path whose bytes are not valid UTF-8 cannot be
given as `--path`, because process arguments are UTF-8; such a path is still
discovered, planned from its finding, moved, and restored byte for byte.

## Finding empty directories and broken links

`find empty` and `find broken` read the index a previous `scan` wrote; neither scans.
The walk counted each directory's entries as it read them and asked once per symlink
whether its target resolved, so both answers are already in the index. A directory the
scan could not open carries no child count at all and therefore never answers a search
for empty ones — "nobody looked" and "nothing is there" are different answers.
## Finding stale files

The question people ask is "what have I not opened in six months?" and on a normal
Linux system that question has no answer. Mounts are `relatime` by default, which
updates a file's access time at most once a day and only when it is already older than
the modification time; many are `noatime`, which never updates it at all. A listing
built on that and labelled "not opened since" would be confidently wrong about files
somebody uses every day.

So `find stale` measures the **modification** time — when the contents last changed —
and says so. Every answer carries a `basis`, whose `field` is always `modified` and
whose `confidence` comes from the options of the mount holding the search path:
`absent` for `noatime`, `coarse` for `relatime`, `maintained` otherwise, and `unknown`
when the mount table could not be read. `unknown` is deliberately not `maintained`: a
reading that did not happen is not a reassuring one. The mount's options change the
sentence, never the measurement, because no column in the scan index holds an access
time to measure instead.

The threshold is `--older-than DAYS`, defaulting to `find.stale_after_days` in the
configuration, which is 183 days. The listing covers regular files only.

## Finding duplicates

`find duplicates` reads the same index to decide what is worth opening, then reads
content, so it costs more than the other three and answers a different kind of
question. It starts from the sizes more than one regular file shares, narrows those by
a digest of each file's first and last 64 KiB, and narrows what is left by a digest of
every byte. A file with no possible twin is never opened.

The answer is a list of groups rather than a page of rows, because which copy pairs
with which is the only thing anybody reading it is deciding about. Each group carries
`reclaimableBytes` — the group's size times one fewer than its members, because one
copy always stays — and the result's own `reclaimableBytes` is the sum over the groups
that have a keeper.

Two names for one inode are one member of a group, not two: removing the second frees
nothing. `--min-size` defaults to 1 MiB; without it the listing fills with small files
whose duplication costs nothing to keep.

`--keep` says which copy survives. `oldest` and `newest` read the **modification**
time, which is when a file's contents last changed; nothing here reads an access time,
because no column in the index holds one and on a `relatime` or `noatime` mount it
would not mean what a reader would take it to mean. When copies share a timestamp the
first path in byte order is kept and the decision says `arbitrary: true` rather than
presenting a coin toss as a judgement. `--keep in-path PATH` requires `--keep-under`
and keeps the single copy under that directory; if no copy is there, or more than one
is, the group is reported `undecidable` with its reason and contributes nothing to the
reclaimable total. It never falls back to another rule — somebody who asked to keep
what is under `~/Pictures` is not asking to keep the oldest instead.

The digests group candidates and authorise nothing. Acting on a group goes through
`clean plan` and `clean apply` like everything else, and the helper re-opens both files
and compares them byte for byte before it touches either. See
[adr/0006](adr/0006-content-identity-and-archive-dependencies.md).

A search that hits a cap, cannot read a file, or is cancelled reports
`status: incomplete` with a warning saying so, and exits `3`. A scan the index has
pruned is refused by name with the command that would make a new one; it is never
answered with no duplicates.

## Reports

`disktop report` exports what Disktop knows as one document a person or a program can
keep: a JSON document, a CSV table, or a standalone HTML page. It reads; it changes
nothing, and it adds no reading of its own — every number in it comes from the same
services `disktop --json`, `explore`, and `clean` use.

```text
disktop report --format json|csv|html [--output FILE] [--path PATH] [--limit COUNT]
               [--findings] [--units iec|si] [--json]
```

A report has up to three sections, and each one says whether it is complete:

- **Capacity**, always: every filesystem with its size, available bytes, the share used
  counted the way `df` counts it, the share of inodes used where the filesystem reports
  inodes, every alert, every block device, and the partitions holding data that nothing
  has mounted, whose usage is unknown. This is the dashboard's joined view.
- **Scan**, with `--path PATH`: the newest stored scan that reached the path — its
  scope, totals, completeness, and warnings — plus, each cut at `--limit` (50 by default,
  at most 1000) and ranked by allocated bytes: what is directly inside the path
  (`children`, which do not overlap and so add up to the path's size), the largest files
  anywhere under it (`largestFiles`), and every entry under it (`entries`, where a
  directory is ranked beside its own ancestors), with the bytes per file extension under
  it. Unreadable directories under the path that were measured as root afterwards
  (`scan --sudo`, or `A` in the TUI) are listed under `elevated`, never added to the
  totals. A scan that stayed out of a mount or exclude between its root and the path does
  not count as reaching it. The totals are the whole scan's; the entries and type totals are
  the path's. Without `--path` there is no scan section, and the report says so: the
  working directory is never assumed, so a report run from a timer or a script does not
  quietly depend on where it was started. A path no stored scan covers is an input error
  naming the `disktop scan` that would cover it. When the scan's index has been pruned or
  cannot be read, the section keeps the stored summary, leaves out the entries rather
  than listing none, and is incomplete.
- **Findings**, with `--findings`: what every detector found, with sizes measured, as
  `disktop clean` lists it — every detector with its capability, including the ones that
  could not look, and per-category totals that count each byte once. A denied detector
  makes the section incomplete exactly as it makes `clean` exit `3`.

An unknown size is reported as unknown in every format, never as zero, and a short
section carries its warnings into every format.

### Where it goes

Without `--output` the report is the whole of stdout, so it can be piped or redirected;
warnings go to stderr. With `--output FILE` it is written to a new file:

1. the content is written to a staging file Disktop creates exclusively, with mode
   `0600`, in the same directory;
2. it is flushed to the device;
3. it is published under `FILE` with `link`, which fails rather than replace anything
   already there — a file, a directory, or a symlink, dangling or not — and the staging
   name is removed;
4. the directory is flushed, so the new name survives a power cut as well as a crash.

A crash leaves at most a hidden `.disktop-report-*.partial` staging file, never a
truncated report under the name you asked for. On a filesystem that has no hard links,
such as vfat or exFAT on a USB stick, Disktop refuses report publication with an
actionable `unsupported` error. Choose an output directory on ext4, Btrfs or another
filesystem supporting hard links. A placeholder followed by an ordinary rename cannot
guarantee that a concurrently replaced destination remains untouched.

An existing `FILE` is refused with exit `2` before anything slow runs, and there is no
option to overwrite one: move the old report away or name a new one. Run as root,
Disktop writes no file itself, so `--output` is refused; redirect stdout instead,
`disktop report --format html > report.html`, and the shell you chose does the writing.

With `--json`, stdout carries one [`report.json`](../schemas/cli/v1/report.json) envelope
describing what was written — the format, the output path with its bytes, the bytes
written, and the sections included — so the report itself needs `--output`; `--json`
without it is refused as ambiguous. The exit status is `0` when every included section
is complete, `3` when any is not (or the file was written but its directory could not be
flushed), `2` for an input or operational error, and `130` when Ctrl+C stopped the report
before it was written, in which case nothing is written at all.

### JSON

`--format json` writes one [`report-document.json`](../schemas/cli/v1/report-document.json)
document. It is not a CLI envelope: it is versioned on its own (`schemaVersion`), names
the `document` it is (`disktop-report`), when it was `generatedAt`, and the
`generator`'s name and version. Its `status` is `incomplete` when any section is, and
each section carries its own `complete` and `warnings`. A section that was not asked for
is `{ "included": false, "reason": "..." }`. Filesystems, devices, alerts, entries, type
totals, and findings use the same shapes as `--json` output, so every integer that can
exceed 2^53 is a decimal string and every path carries `bytesBase64` beside its
sanitized `display`.

### CSV

`--format csv` writes RFC 4180: UTF-8 with no byte-order mark, every record ending in
CRLF, a field quoted when it holds a comma, a quote, or a line break, and every quote
inside it doubled. Every row has the same columns, so the file loads as one table:

```text
section,id,kind,path_display,path_bytes_base64,allocated_bytes,apparent_bytes,shared_bytes,
size_bytes,size_basis,total_bytes,free_bytes,available_bytes,used_percent,
inodes_used_percent,threshold_percent,entries,modified_at,status,detail
```

`section` says what a row is, and a row fills only the columns that apply to it. An
empty cell means "does not apply" or "not known", never zero: an unmeasured finding has
an empty `size_bytes` beside `size_basis` `unknown`, and a filesystem that reports no
inode counts has an empty `inodes_used_percent`. Byte columns are exact decimal integers;
a spreadsheet may display a large one rounded, and the file still holds it exactly.

| `section` | One row per | Columns it fills |
| --- | --- | --- |
| `report` | fact about the report: `id` is `schema-version`, `generated-at`, `generator`, `status`, or a section name with `kind` `section` | `status` (`complete`, `incomplete`, or `omitted`), `detail` |
| `capability` | capability of the capacity reading (`id` `capacity`) and of the detectors (`id` `findings`) | `status`, `detail` |
| `filesystem` | filesystem, with its first mount point | `id`, `kind` (type), path, `total_bytes`, `free_bytes`, `available_bytes`, `used_percent`, `inodes_used_percent`, `status` (`read-only` or `read-write`), `detail` |
| `mount` | further mount point of a filesystem | `id`, path |
| `device` | block device | `id`, `kind` (`ssd`, `hdd`, `unknown`), `total_bytes`, `entries` (partitions), `detail` |
| `volume` | every persistent partition or logical volume | `id`, `kind` (filesystem signature or `unknown`), `path_display`, `total_bytes`, `status`, `detail` |
| `unmounted` | partition with data that nothing has mounted | `id`, `kind` (filesystem type), `path_display` (the device node), `total_bytes`, `status` (`unmounted` or `locked`), `detail` |
| `alert` | alert | `id` (filesystem), `kind`, `used_percent`, `threshold_percent`, `detail` |
| `scan` | included scan | `id` (scan), `kind` (accounting), path (the `--path`), `allocated_bytes`, `apparent_bytes`, `shared_bytes` (whole scan), `entries` (scanned), `modified_at` (when scanned), `status`, `detail` |
| `scan-root`, `excluded-mount` | root of the scan, mount it did not enter | `id` (scan), path |
| `child`, `largest-file` | entry directly inside the path; largest file under it | `id`, `kind`, path, `allocated_bytes`, `apparent_bytes` (both empty with `status` `not-entered` for a directory the scan never went inside), `entries`, `modified_at`, `status` |
| `measured-as-root` | unreadable directory measured afterwards with administrator rights | `id` (scan), path, `size_bytes`, `size_basis`, `modified_at` (when measured), `detail` |
| `entry` | listed entry, largest first | `id`, `kind`, path, `allocated_bytes`, `apparent_bytes`, `entries` (a directory's children), `modified_at`, `status` (`shared-hardlink`, `broken-symlink`) |
| `entry-limit` | listing cut at `--limit` | `entries` (the limit), `detail` |
| `type-total` | file extension, `id` empty for none | `id`, `allocated_bytes`, `apparent_bytes`, `entries` |
| `finding` | finding | `id`, `kind` (category), `size_bytes`, `size_basis`, `entries` (paths), `status` (capability), `detail` |
| `finding-path` | path of a finding, so a finding's size is counted on one row | `id` (finding), path |
| `provider` | detector asked | `id`, `kind` (`ran`, `did-not-run`), `entries` (findings), `status` (capability), `detail` |
| `category-total` | finding category | `id`, `size_bytes`, `entries` (findings), `detail` |
| `warning` | warning | `id` (code), `kind` (the section it belongs to), path, `detail` |

"Path" is the pair `path_display` and `path_bytes_base64`. `path_display` is the
sanitized form, safe to show; `path_bytes_base64` is the name's exact bytes and the only
column a program should treat as the name.

Every cell is sanitized first, so no control character survives into one: a newline in a
filename is its Control Picture `␊`, not a record break. A cell that would then begin
with `=`, `+`, `-`, or `@` — `=cmd|' /C calc'!A0`, `@SUM(A1)`, `+1`, `-1` — is prefixed
with an apostrophe so a spreadsheet shows it as text rather than evaluating it; tab and
carriage return are covered by the same rule, though sanitizing has already turned them
into `␉` and `␍`. A cell that already begins with an apostrophe gains one more. To get a
cell's original text back, remove exactly one leading apostrophe from any cell that has
one; nothing else changes. Base64 of an absolute path always begins with `L`, so the
bytes column is never touched.

### HTML

`--format html` writes one standalone page: no script, no external stylesheet, font, or
image, and no link that leaves the page. Its first element after the character set is a
`Content-Security-Policy` of `default-src 'none'; style-src 'unsafe-inline'`, so even a
mistake in escaping could neither run a script nor fetch anything; inline styles are the
only thing it allows. Every value on the page — names, mount sources, device models,
finding titles, explanations, warnings — is sanitized and then has `&`, `<`, `>`, `"`,
and `'` escaped, in text and in attributes alike. A name shown with substitutions,
because it was not valid UTF-8 or held a character that had to be replaced, is marked
`†`, and its exact bytes in base64 are in its tooltip, because two different names can
be shown the same.

Sizes are shown in the `--units` you chose with the exact byte count in a tooltip;
capacity is drawn as bars whose width is the used percentage, red where an alert has
been raised; a page follows the reader's light or dark preference. Incomplete sections
are badged and their warnings listed at the top, one line per kind of warning that opens
(an HTML `details` element, no script) to every path it names. The scan section shows
what is directly inside the path with each entry's share of it, then the largest files,
then the file types; a directory the scan never went inside shows `unknown` and why,
rather than a size.

## Shell completions

`disktop completion bash|zsh|fish` prints a completion script to stdout and installs
nothing. The script is generated from the command table in `src/cli/parser.ts` — the
same table the parser validates against and the help is rendered from — so it offers
exactly the commands, subcommand words, options, and option values this version
accepts. It completes:

- command words, including the words that lead to one (`alerts` then `check`, `clean`
  then `plan` or `apply`);
- operand keywords: `find duplicates|stale|empty|broken`, `snapshots list|diff`,
  `timer install|uninstall`, and `completion bash|zsh|fish`;
- each command's own options, `--help`, and `--version` at the top level;
- an option's fixed values, such as `--format json|csv|html` or `--units iec|si`;
- file names wherever a path belongs: the `PATH` operand of `scan` and `explore`, and
  every option whose value is a `PATH` or `FILE`, such as `--output` and `--path`.

An option's value is never mistaken for a command word, wherever it sits, which is the
same rule the parser follows; a plan or action ID, a count, or a size completes nothing
rather than offering file names that would be wrong. An unknown shell is refused with
exit `2`. Regenerate the script after upgrading Disktop.

**bash** (needs bash 4 or later, which every supported distribution ships). For your
account, with the `bash-completion` package installed:

```sh
mkdir -p ~/.local/share/bash-completion/completions
disktop completion bash > ~/.local/share/bash-completion/completions/disktop
```

Without `bash-completion`, add `source <(disktop completion bash)` to `~/.bashrc`.

**zsh**. Put the script in a directory on `$fpath` under the name `_disktop`, before
`compinit` runs:

```sh
mkdir -p ~/.zfunc
disktop completion zsh > ~/.zfunc/_disktop
# in ~/.zshrc, before compinit:
fpath=(~/.zfunc $fpath)
autoload -Uz compinit && compinit
```

Alternatively, add `source <(disktop completion zsh)` to `~/.zshrc` after `compinit`.
zsh shows each command's and option's summary beside it.

**fish**:

```sh
disktop completion fish > ~/.config/fish/completions/disktop.fish
```

fish loads it the next time `disktop` is completed.

## Machine output

- Every `--json` command writes exactly one `envelope.json` object to stdout: `schemaVersion`, `command`, `generatedAt`, `status`, `exitCode`, optional `warnings`, and then `data` or, when the status is `error`, `error`. An incomplete result must carry at least one warning.
- Filesystem identities, counts, byte values, and nanosecond timestamps are decimal strings, never JSON numbers. A path is `{bytesBase64, display, utf8?}`; only `bytesBase64` is lossless, and `display` carries no character that can command a terminal or reorder what follows it. Two different names can still display the same, so nothing resolves a target from `display`. See [adr/0005](adr/0005-lossless-values-in-contracts.md).
- Objects are closed to unknown fields, so new output requires a schema change in the same commit.
- Structured output goes to stdout. Progress, diagnostics, and permission messages go to stderr. A failed JSON command still emits a schema-compatible error object when possible.
- Every scan result includes scope, completeness, scanned entry count, inaccessible directory count, excluded mounts, and warnings. A missing optional tool or denied permission is a capability state, not an empty successful result.
- CSV export quotes and escapes fields and prefixes an apostrophe to any cell a spreadsheet would evaluate (one starting `=`, `+`, `-`, `@`, tab, or carriage return) and to one already starting with an apostrophe, so the rule can be undone. HTML export escapes all file and provider text and can neither run a script nor load anything. Export formats label allocated versus apparent bytes, estimates, and partial results. See [Reports](#reports).
- Human-readable units can switch between SI and IEC; the underlying byte values do not change.

## Exit status

| Code | Meaning |
| --- | --- |
| `0` | Requested operation completed. |
| `1` | `alerts check` reached its capacity or inode threshold. |
| `2` | Invalid input, unavailable capability, permission failure, an unimplemented command, or another operational error. |
| `3` | Scan or action ended incomplete, including partial results. |
| `130` | Interrupted: Ctrl+C, SIGTERM, or a hangup stopped the command before it finished. |

Ctrl+C asks `scan`, `clean`, `clean plan`, `clean apply`, `undo`, and `find` to stop at their next safe boundary — a directory, a detector, an item. Each still reports and journals what it did, marked incomplete with a warning, and exits `130`; with `--json` that partial result is the envelope, with `exitCode: 130`. A command interrupted before it had any result is an error envelope whose failure code is `cancelled`, also exit `130`. A command that had already finished everything when the interrupt landed reports `complete` and exits `0`, because nothing was left undone. A second Ctrl+C does not abandon the item in progress, which is the one moment a record could stop matching the disk; it says the command is already stopping. SIGTERM and SIGHUP are handled the same way.

`--help`, `--version`, and a command line that does not parse are answered from the command table before anything else runs: no configuration is read and, as root, the install is not inspected, so help is available even where every real command would refuse to start. An empty value or operand (`--path=`, or `--path "$UNSET"`) is refused rather than resolved to the working directory, a value option given twice is refused rather than letting one silently win, and an argument holding bytes that are not UTF-8 is refused because Node has already replaced them and the path it would name is not the one typed. A refused command line exits `2` with its reason on stderr and nothing on stdout; with `--json` the reason is instead one `invalid-input` error envelope on stdout. Anything a command did not expect is reported as one sanitized line (or one `internal-error` envelope) and exit `2`, never as a stack trace.

A reader that stops early — `disktop devices | head -1` — is not an error: the rest of the output is dropped, the command finishes, and it exits with its own status. Any other failure to write stdout, such as a full disk behind a redirect, is reported on stderr and exits `2`, because nobody received the answer.

An alert threshold is an expected monitoring outcome, so `1` is reserved for that command: `disktop --json` reports the same alerts and still exits `0`. Incomplete reporting takes precedence over both, so an `alerts check` that reached a threshold on readings it could not complete exits `3` rather than `1`; an alert drawn from partial readings is not the whole picture. Contract tests must check stdout, stderr, status, and schema together.

An inventory is incomplete whenever anything could not be read: a mount whose `statfs` was denied, a missing `lsblk`, an unparsable `mountinfo` line, or a configuration file that could not be applied. Each one adds a warning naming what was missed, and no missing reading is ever reported as a zero.

A `statfs` that does not answer within five seconds — a hard NFS mount whose server has gone does this — is a `statfs-timeout` warning and that filesystem is left out. The kernel call cannot be cancelled and keeps one Node worker thread until it returns, so a mount still stuck is not asked again by the same process, and a finished command exits even while the call is pending. Device models, transports, and filesystem types are sanitized where they are read: a USB device chooses its own model string and any user who can mount FUSE chooses a filesystem subtype that every other user's dashboard prints.

## Manager actions

`disktop clean` lists what package and container managers can clean, as findings whose
id starts with `managers:` and whose `managerScope` is the exact command line they would
run. `disktop clean plan managers:<action>` asks the manager again, now, and stores a
plan holding the action, its items, and its parameters. The command is derived from
those by a fixed template every time the plan is read, so an edited plan file cannot
name a different program or option, and the plan's JSON shows the derived argument
vectors under `manager.commands`.

A manager plan is irreversible and needs `--permanent` at apply time. Apply runs a live
preflight first: an item that is gone or in use again is skipped, and a kernel purge is
refused outright if the running kernel has become one of the reviewed packages or the
simulated removal now takes anything else. A command that needs root is run as
`sudo -- /usr/bin/TOOL ARGS` (with `-n` when there is no terminal or `--json` was given)
or, interactively without sudo, `pkexec`. Nothing else is escalated. A refused password
skips the rest of the action, is recorded, and exits `3`.

Counts and sizes are what the manager says, labelled `exact`, `estimated`, or
`unknown`; `selectedBytes` is absent when the manager could not say beforehand. The
result's free-space readings are the measurement.

What is offered, and never more: package files apt, dnf, or pacman downloaded; archived
journal files beyond `managers.journal_keep_bytes`; disabled Snap revisions; Flatpak
runtimes Flatpak itself judges unused; dangling images, stopped containers, and
anonymous volumes for Docker and Podman, never forced; Docker build cache nothing refers
to; kernels that are neither running nor the newest, only when a simulated removal takes
exactly their packages; and what systemd-tmpfiles' own age rules allow, for temporary
files and, under `/var/crash` and `/var/lib/systemd/coredump`, crash files. A named
volume is reported and never offered.

Run as root, Disktop plans and applies no change to a file itself; reviewed manager
actions still run.

## Who owns the bytes

`disktop explore PATH --owners` adds bytes per owning user under `PATH`, over regular
files, from the scan that covers it, with account names from `/etc/passwd` where it can
be read. A scan that could not open some directories makes every total a floor: the
result exits `3` and says so, and names the read-only administrator scan that would
complete it — `disktop scan` run as root from a root-owned install, never `sudo npx`.

## Configuration and scheduled alerts

`timer install` writes `disktop-alerts.service` and `disktop-alerts.timer` under
`$XDG_CONFIG_HOME/systemd/user`, each starting with a `# Managed by Disktop` line, and
enables the timer. The service runs `alerts check --notify` hourly and nothing else; it
never cleans. Install refuses to overwrite a unit that does not carry the marker, and
reports failed reload or enable steps with an error and the systemctl diagnostic.
`timer uninstall` disables the timer before removing marked units; if disable fails,
the units remain in place and the error warns that the timer may still run. A failed
reload after removal gives the recovery command. Uninstall is safe to run twice.
Neither command elevates anything.

Configuration is `$XDG_CONFIG_HOME/disktop/config.toml` with the standard home fallback;
[config.example.toml](config.example.toml) documents every key. Rules never contain
shell commands and pass through the same preview and apply path.

## Terminal UI

`disktop` with no command, on a terminal, opens the TUI. It is a surface over the same
application services as the commands above and can do nothing they cannot: every change
is a reviewed plan, applied through `clean apply`'s service, and journalled.

| Tab | Shows | Keys beyond the common ones |
| --- | --- | --- |
| 1 Disks | Connected drive counts, readable filesystems with usage bars, and every other partition or logical volume. The selected filesystem separates used, root-reserved, and available space, device, inodes, and mounts. Locked, swap, RAID/LVM backing, and unknown-signature storage have explicit states; unknown never means empty. | Enter explore a mounted tree, `S` scan it |
| 2 Explore | A stored scan, a directory at a time: size, share of the parent, growth since the previous comparable snapshot, a trend sparkline of the total, file types. A directory the scan never entered shows `?` and why; after `A`, an unreadable one shows its size measured as root and opens to one level of what is inside. | Enter/`l` open, `h`/Backspace up, `s` sort, `f` finders (largest, duplicates, stale, empty, broken), `/` filter, `t` types, `n` more, `c` plan, `S` scan, `A` measure unreadable directories as root (asks for your password) |
| 3 Clean | Findings a plan could act on, totalled by category, then informational ones. | Enter details, `c` plan, `p` detectors, `r` look again |
| 4 Dev, 5 Apps | The same findings narrowed to development or to applications. | as Clean |
| 6 History | The journal, item by item. | `u` undo a Trash action, `n` older |

Common keys: `j`/`k`/arrows, `g`/`G`, PgUp/PgDn, Ctrl+U/Ctrl+D, `1`–`6`, Tab and `[`/`]`,
`U` units, `r` refresh, `?` help, Esc close or stop, `q` and Ctrl+C quit. The mouse
selects rows, switches tabs, and scrolls.

The filter after `/` is words (name contains), `ext:log` or `.log`, `>1GiB`/`<5MB`
(allocated size), `age>30` (not modified for 30 days), and `type:file|dir|link|other`.
It compiles to the same `EntryFilter` as `explore`'s flags. Long filters scroll their text to keep the
newest input and its cursor visible. In the detector list (`p`), `j`/`k`, paging, and
`g`/`G` reach every detector; the selected explanation appears below the list.

A plan is reviewed in a dialog showing its operation, whether and how it can be undone,
the selected bytes and item count, the permission it needs, its expiry, its warnings,
and its entries. `y` applies a reversible plan; an irreversible one needs `yes` typed
and Enter. `o` re-plans with the next operation on offer. The TUI plans Trash,
permanent removal, emptying Trash, manager actions, and — for an Explore entry, or a
finding that offers them — a move to another disk and a compression; for a copy in a
duplicate group it offers Trash or a hardlink replacement (byte-compared by the helper)
and never a plain permanent removal. A move or a compression asks first, in a dialog
that plans nothing, for the directory its output goes into (absolute, or `~/` for
home; a compression left empty goes beside its source) and, with Tab, whether the
source then goes to Trash or is removed permanently — the same `--destination` and
`--source` that `clean plan` takes. The last answer is offered again, and `o` on a
move review asks again for a compression with it. A plan that needs root
suspends the TUI while `sudo` or `pkexec` asks for the password, then takes the
terminal back. Results keep selected bytes, bytes moved to Trash, and the observed
free-space change apart, as `clean apply --json` does.

Esc stops a running scan (what it read is indexed and marked incomplete), a discovery,
an index query, or a duplicate search. An apply or undo stops after its current item and still reports;
`q` is refused while one runs, and Ctrl+C asks it to stop, waits for it to journal, and
exits `130`. A normal quit exits `0`, or `3` when the inventory was incomplete.

The TUI uses [Catppuccin Mocha](https://catppuccin.com/palette/#mocha): mauve accents,
dark surfaces, teal usage bars, yellow warnings, and soft red failures. `COLORTERM=truecolor`
or `24bit` selects the original RGB palette; 256- and 16-colour terminals use
approximations. Selection, state glyphs, and distinct distribution fills remain
readable without colour. The scan activity bar is indeterminate: a tree's total extent
is unknown until traversal finishes. A duplicate listing retains at most 10,000 rows;
if a group exceeds this, its true copy count and the limit are shown, and a smaller
directory can be searched. Short dialogs centre around their content, and result
dialogs show the journal id and preserve partial or uncertain outcomes.

Environment: `NO_COLOR` (non-empty) removes colour and keeps bold and inverse; a locale
that is not UTF-8, `TERM=linux`, or `DISKTOP_ASCII=1` draw ASCII glyphs;
`DISKTOP_NO_MOUSE=1` leaves mouse reporting off. The layout is designed for 80×24 and
stays usable down to 40×10, below which it says so. A plan is reviewed and confirmed
only at 60×20 or larger, so its target, operation, and confirmation are all on screen;
smaller, the review says so and offers no confirmation. Terminal state is restored on exit,
on `SIGINT`, `SIGTERM`, `SIGHUP`, and after an uncaught exception.
