# CLI contract

Status: planned `1.0.0` command surface. `devices`, the `--json` dashboard, `alerts check`, `scan`, `explore`, `snapshots list|diff`, `clean`, `clean plan`, `clean apply`, `history`, `undo`, and `find duplicates|empty|broken` are implemented; `report`, `timer`, `completion`, and `find stale` are declared in the parser and refuse with `not-implemented`. The JSON output contract in [`schemas/cli/v1/`](../schemas/cli/v1/) is normative and is validated by `tests/contract/cli-schema.test.mjs` against examples and by `tests/integration/cli-output.test.mjs` against what the CLI actually writes on a running host. The parser and generated help are normative now; completions become normative when they are implemented. See [PLAN.md](../PLAN.md#cli-and-outputs).

## What works today

| Command | Behaviour |
| --- | --- |
| `disktop` | Opens the 80×24 dashboard when stdin and stdout are both terminals, and prints the text dashboard otherwise. |
| `disktop --json` | One `dashboard.json` envelope: capability, filesystems, and alerts. |
| `disktop devices [--json]` | Physical disks counted once with their partitions, plus every mounted filesystem joined to its backing disk. |
| `disktop alerts check [--threshold PERCENT] [--json]` | Space and inode thresholds. Exits `1` when one is reached. |
| `disktop scan [PATH] [--json]` | Walks `PATH` (the working directory by default) through the helper, writes the detailed index, and saves a snapshot. `--accounting allocated\|apparent`, `--cross-filesystems`, `--throttle RATE`, `--max-depth DEPTH`. Ctrl+C stops it at a directory boundary and still reports what was measured. |
| `disktop explore [PATH] [--json]` | One page of `PATH` and everything below it, from the most recent scan covering it. `--sort`, `--order`, `--kind`, `--min-size`, `--max-size`, `--ext`, `--name`, `--older-than DAYS`, `--limit`, `--cursor`, `--type-totals`. |
| `disktop snapshots list\|diff [--json]` | Lists saved snapshots, or compares two of them (`--from`, `--to`; the two most recent by default). |
| `disktop clean [--json]` | Lists what every detector found, and changes nothing. `--dry-run` is accepted and redundant. `--category CATEGORY` narrows the list, `--limit COUNT` shortens it, and `--no-sizes` skips measurement so every size stays unknown. |
| `disktop clean plan [FINDING_ID] [--path PATH] [--operation trash\|permanent\|empty-trash] [--json]` | Reviews one finding or path into a stored, expiring plan. Changes nothing. `--operation empty-trash` needs no subject and can name only this user's own Trash. |
| `disktop clean apply PLAN_ID --yes [--permanent] [--json]` | Applies an already-reviewed plan, revalidating every item against the identity the plan recorded. |
| `disktop history [--json]` | The durable action journal, with interrupted records resolved as it is read. |
| `disktop undo ACTION_ID --yes [--json]` | Puts back what one Trash action moved. |
| `disktop find empty\|broken [--path PATH] [--limit COUNT] [--json]` | Empty directories and dangling symlinks, read out of the most recent scan covering the path. |
| `disktop find duplicates [--path PATH] [--min-size SIZE] [--keep oldest\|newest\|in-path] [--keep-under PATH] [--limit COUNT] [--json]` | Groups of files holding the same bytes, with the copy a keep rule would keep. Reads content; changes nothing. |
| `disktop --units iec\|si` | Switches human-readable units. Byte values in JSON never change. |
| `disktop --help`, `disktop --version` | Generated from the one command table in `src/cli/parser.ts`. |

Everything else parses, validates its options, and then refuses with `not-implemented` and exit `2`, in the same envelope shape a working command uses.

## Scanning, exploring, and growth

`scan` does not delete or move anything. It walks the tree through the Rust helper, which opens every directory with `openat2` containment: it never follows a symlink, and without `--cross-filesystems` it refuses to descend into a nested mount, including a bind mount of the same filesystem. A directory it cannot open is counted and named, never treated as empty, and any scan that missed something reports `complete: false` with at least one warning.

Bytes are counted once per inode. A second hardlink to an inode the scan already counted is listed with `shared: true`, and its bytes are reported as `sharedBytes` rather than added to the totals, because deleting that path frees nothing.

A directory's `allocatedBytes` and `apparentBytes` are the totals for its whole subtree; a file's are its own. Per-extension totals cover regular files only, for the same reason: adding directory rows to them would count the same bytes twice.

`explore` never scans. It reads the index a previous `scan` wrote, and the path narrows the listing to that directory and everything below it, so exploring `~/Downloads` after scanning `~` answers about Downloads. If no stored scan covers the path, or the path was not in the scan, it says so and names the command that would produce one.

A scan of a tree with many unreadable directories reports every one of them in `inaccessibleDirectories`, but lists at most a few hundred individually and then summarises the rest as a `warnings-truncated` warning giving the count per code. Nothing is hidden; the list is bounded so that the output, the index, and every stored snapshot do not grow with the filesystem.

`snapshots diff` compares two snapshots only when they measured the same thing: same roots, same excludes, same accounting mode, same mount policy, same depth limit, and the same filesystems — the ones the walk actually read, which is not the same as the ones the roots sit on once a scan is allowed to cross a mount. The comparison reports the column the scan measured, so an apparent-accounting history shows apparent growth; a sparse image that grows by gigabytes without allocating a block is exactly why that matters. Anything else is refused, because subtracting a scan that excluded a directory from one that did not produces a number indistinguishable from real growth. A diff is marked `uncertain` whenever either scan was partial or a directory appears on only one side, since that is also what a rename looks like.

### Comparing against `du`

`disktop scan --json` reports `allocatedBytes` on the same basis as `du -x --block-size=1`: `st_blocks × 512`, each inode counted once, no mount crossing. The two agree exactly on the same tree, and `tests/integration/scan.test.mjs` asserts it.

`sharedBytes` is reported in the same unit as the totals beside it, so the two can be compared directly.

Apparent bytes are not comparable against `du`. `du --apparent-size` leaves the directories' own `st_size` out of its total and Disktop includes it, so the two are answering different questions. Neither figure is what `df` reports either: reflinks, compression, snapshots, and open-but-deleted files all make a tree's size differ from a filesystem's free space.

## Command tree

```text
disktop                                      Open the TUI
disktop --json                               Dashboard without a TTY
disktop devices --json
disktop scan [PATH] --accounting allocated|apparent --cross-filesystems --json
disktop explore [PATH] --sort allocated --min-size 1GiB --ext log --json
disktop find duplicates|stale|empty|broken [PATH] --json
disktop snapshots list|diff --json
disktop clean --dry-run --json
disktop clean plan FINDING_ID --operation trash|erase|move|compress|hardlink --json
disktop clean plan --path PATH --operation trash --json
disktop clean apply PLAN_ID --yes --json
disktop clean apply PLAN_ID --yes --permanent --json
disktop history --json
disktop undo ACTION_ID --yes --json
disktop report --format json|csv|html --output FILE
disktop alerts check --threshold 90 --json
disktop timer install|uninstall
disktop completion bash|zsh|fish
```

The parser in `src/cli/parser.ts` will define commands and options once, and drive help plus completions. The CLI and TUI invoke the same application use cases. Any command that scans shows progress on stderr, can be cancelled, and reports an incomplete result when it could not inspect the full selected scope. Disktop does not use an interactive prompt when `--json` is requested or stdout is not a TTY.

## Listing what was found

`disktop clean` runs every detector and prints what they found. It applies
nothing: `clean plan` and `clean apply` still refuse with `not-implemented`,
and no detector can delete.

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
footprints unknown, and stays complete.

Ctrl+C stops discovery at the next detector boundary. `clean` prints no
progress while it runs; that is Phase 7's work.

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
`find stale` is declared and refuses; it needs the timestamp-confidence work that is
not built yet.

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

## Machine output

- Every `--json` command writes exactly one `envelope.json` object to stdout: `schemaVersion`, `command`, `generatedAt`, `status`, `exitCode`, optional `warnings`, and then `data` or, when the status is `error`, `error`. An incomplete result must carry at least one warning.
- Filesystem identities, counts, byte values, and nanosecond timestamps are decimal strings, never JSON numbers. A path is `{bytesBase64, display, utf8?}`; only `bytesBase64` is lossless, and `display` carries no character that can command a terminal or reorder what follows it. Two different names can still display the same, so nothing resolves a target from `display`. See [adr/0005](adr/0005-lossless-values-in-contracts.md).
- Objects are closed to unknown fields, so new output requires a schema change in the same commit.
- Structured output goes to stdout. Progress, diagnostics, and permission messages go to stderr. A failed JSON command still emits a schema-compatible error object when possible.
- Every scan result includes scope, completeness, scanned entry count, inaccessible directory count, excluded mounts, and warnings. A missing optional tool or denied permission is a capability state, not an empty successful result.
- CSV export quotes and escapes fields and prefixes dangerous spreadsheet-leading cells (`=`, `+`, `-`, `@`). HTML export escapes all file and provider text. Export formats label allocated versus apparent bytes, estimates, and partial scans.
- Human-readable units can switch between SI and IEC; the underlying byte values do not change.

## Exit status

| Code | Meaning |
| --- | --- |
| `0` | Requested operation completed. |
| `1` | `alerts check` reached its capacity or inode threshold. |
| `2` | Invalid input, unavailable capability, permission failure, or other operational error. The scaffold also uses this for unimplemented commands. |
| `3` | Scan or action ended incomplete, including partial results. |
| `130` | Interrupted before a completed or partial result could be reported. |

An alert threshold is an expected monitoring outcome, so `1` is reserved for that command: `disktop --json` reports the same alerts and still exits `0`. Incomplete reporting takes precedence over both, so an `alerts check` that reached a threshold on readings it could not complete exits `3` rather than `1`; an alert drawn from partial readings is not the whole picture. Contract tests must check stdout, stderr, status, and schema together.

An inventory is incomplete whenever anything could not be read: a mount whose `statfs` was denied, a missing `lsblk`, an unparsable `mountinfo` line, or a configuration file that could not be applied. Each one adds a warning naming what was missed, and no missing reading is ever reported as a zero.

## Configuration and scheduled alerts

Configuration is planned at `$XDG_CONFIG_HOME/disktop/config.toml` with the standard home fallback. It will contain excludes, units, thresholds, provider settings, and bounded declarative cleanup rules. Rules never contain shell commands and pass through the same preview and apply path.

`timer install` adds an opt-in systemd **user** timer for `alerts check`, optionally using `notify-send`. It never schedules cleanup. `timer uninstall` removes only Disktop-owned user units. Neither command elevates the whole CLI.
