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

`dashboard.json`, `devices.json`, and `alerts.json` cover the implemented commands;
`error.json` covers a command that cannot produce its payload, including one that is
declared but not yet built. Exit `1` belongs to `alerts check` alone: the dashboard
reports the same alerts and still exits `0`.

`examples/valid/` and `examples/invalid/` are checked by `tests/contract/cli-schema.test.mjs`.
Each file is named `<schema>.<case>.json`, and the invalid cases exist to prove a rule
still bites. `tests/integration/cli-output.test.mjs` validates what the CLI actually
writes on a running host against these same schemas, so an example cannot drift away from
the output it claims to describe.

Commands gain their schema in the phase that implements them; a schema change that is not
backward compatible needs a new version directory, not an edit here.
