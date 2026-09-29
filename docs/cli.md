# CLI contract

Status: planned `1.0.0` command surface. `devices`, the `--json` dashboard, and `alerts check` are implemented; every other command is declared in the parser and refuses with `not-implemented`. The JSON output contract in [`schemas/cli/v1/`](../schemas/cli/v1/) is normative and is validated by `tests/contract/cli-schema.test.mjs` against examples and by `tests/integration/cli-output.test.mjs` against what the CLI actually writes on a running host. The parser and generated help are normative now; completions become normative when they are implemented. See [PLAN.md](../PLAN.md#cli-and-outputs).

## What works today

| Command | Behaviour |
| --- | --- |
| `disktop` | Opens the 80×24 dashboard when stdin and stdout are both terminals, and prints the text dashboard otherwise. |
| `disktop --json` | One `dashboard.json` envelope: capability, filesystems, and alerts. |
| `disktop devices [--json]` | Physical disks counted once with their partitions, plus every mounted filesystem joined to its backing disk. |
| `disktop alerts check [--threshold PERCENT] [--json]` | Space and inode thresholds. Exits `1` when one is reached. |
| `disktop --units iec\|si` | Switches human-readable units. Byte values in JSON never change. |
| `disktop --help`, `disktop --version` | Generated from the one command table in `src/cli/parser.ts`. |

Everything else parses, validates its options, and then refuses with `not-implemented` and exit `2`, in the same envelope shape a working command uses.

## Command tree

```text
disktop                                      Open the TUI
disktop --json                               Dashboard without a TTY
disktop devices --json
disktop scan [PATH] --json
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

## Reviewed actions

`clean --dry-run` lists eligible findings and actions. `clean plan` creates an expiring immutable plan for a finding or explicitly selected path. The plan contains its operation, scope, exact or estimated totals, warnings, reversibility, and required permission. Move and compression plans also fix the destination and whether the original source goes to Trash or is permanently removed. Large manifests remain disk-backed.

`clean apply PLAN_ID --yes` applies the already-reviewed operation after live revalidation. `--yes` does not skip planning. `--permanent` only acknowledges a plan that already contains irreversible removal; it does not alter a Trash plan. CLI cleanup defaults to dry-run. `undo` uses the action journal and refuses destination collisions or changed outputs. Manager actions expose estimated or unknown scope honestly when a manager cannot preview exact counts.

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
