# CLI JSON schemas, version 1

These files are the normative shape of Disktop's `--json` output. `envelope.json` is the
one object every `--json` command writes to stdout; `common.json` holds the shared
definitions; each remaining file narrows the envelope for one command.

Rules the schemas enforce rather than merely document:

- Filesystem identities, counts, byte totals, and nanosecond timestamps are base-10
  strings (`common.json#/$defs/decimalInteger`), never JSON numbers.
- A path is an object with lossless `bytesBase64` plus a sanitized `display` string.
  `display` cannot contain C0 or C1 controls, DEL, the line and paragraph separators, or
  the bidirectional marks, overrides, and isolates, so a crafted filename can neither
  inject terminal escapes nor reorder what a consumer renders. It is safe to print, not
  unique: two different names can still display the same, so nothing resolves a target
  from `display`.
- Every object is closed to unknown fields, so adding output requires a schema change.
- `status: "error"` requires an `error` object; any other status requires `data`;
  `status: "incomplete"` requires at least one warning.
- A missing tool or denied permission is a `capability`, never a zero.

Each command's file narrows the envelope for that command; `error.json` covers a
command that cannot produce its payload, including one that is declared but not yet
built. Exit `1` belongs to `alerts check` alone: the dashboard reports the same alerts
and still exits `0`.

`report-document.json` is the one schema here that is not an envelope. It is the
standalone document `disktop report --format json` writes: a file somebody keeps, so it
carries its own `schemaVersion`, `generatedAt`, and generator version, and each of its
sections says whether it is complete. It reuses the definitions in `common.json`, so a
filesystem, an entry, or a finding has one shape whether it arrives in a report or in
`--json` output. `report.json` is the envelope `report --output FILE --json` writes about
the file it published.

`examples/valid/` and `examples/invalid/` are checked by `tests/contract/cli-schema.test.mjs`.
Each file is named `<schema>.<case>.json`, and the invalid cases exist to prove a rule
still bites. `tests/integration/cli-output.test.mjs` validates what the CLI actually
writes on a running host against these same schemas, so an example cannot drift away from
the output it claims to describe.

Commands gain their schema in the phase that implements them; a schema change that is not
backward compatible needs a new version directory, not an edit here.

`devices` includes `volumes`: every persistent partition and logical volume, including firmware/recovery, swap, optical media and unknown signatures. `deviceIds` preserves all physical parents for RAID/LVM; `mounts` carries byte-exact visible mount points. `unknown` means no readable signature, never empty. `in-use` means a backing partition has open logical children. No volume is mounted, unlocked or mutated by inventory. Missing topology or unreadable capacity remains an incomplete result with warnings. The existing `unmounted` data-volume subset remains available. Reports reuse the same volume contract.
