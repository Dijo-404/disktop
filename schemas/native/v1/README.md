# Native helper protocol schemas, version 1

These files are the normative wire contract between Node and the bundled `disktop-fs`
helper. `request.json` is one line of the helper's stdin, `event.json` one line of its
stdout, `common.json` the shared definitions, and `hello-result.json`, `scan-result.json`, and
`query-index-result.json` the completion shapes whose result object is fixed.

What the schemas fix now, before the operations exist:

- Wherever a path argument is specified, it is base64 raw bytes. A display string is not
  a valid value for one, so a target can never be reconstructed from sanitized text.
- Device and inode numbers, byte sizes, and nanosecond timestamps are base-10 strings,
  outside the range where a JSON number would round.
- For the mutations whose arguments are fixed here — `trash`, `erase`, `empty-trash` —
  the request carries the reviewed `planId` and, per target, the
  `{device, inode, mountId, kind, apparentBytes, modifiedNanoseconds}` the plan observed;
  there is no valid shape without both. `restore`, `copy-move`, `compress`, and
  `dedup-hardlink` still validate as an open `arguments` object and must adopt
  `common.json#/$defs/mutationArguments` in the phase that implements them. Until then the
  schema does not constrain them, and the helper refuses them outright.
- `scan` has no option to follow symlinks, because it never does. Its completion fixes
  `complete`, the scanned-entry and inaccessible-directory counts, allocated, apparent,
  and shared byte totals, the mounts it refused to cross, and a warning list; a result
  with `complete: false` is invalid unless it carries at least one warning, so a partial
  scan cannot be read as a short one.
- `query-index` returns one bounded page of index rows plus an optional opaque cursor and
  optional per-extension totals. There is no request shape that asks for the whole tree.
- Requests and events are closed to unknown fields, and `requestId` is restricted to an
  alphabet that is safe to echo into logs.
- `requestId` may be null only on an event the helper could not correlate.

The operation list is complete for `1.0.0`; argument schemas exist for the operations
whose contract is fixed (`hello`, `probe`, `cancel`, `scan`, `query-index`, `trash`,
`erase`, `empty-trash`, `journal-reconcile`). The remaining planned operations validate as an
open `arguments` object until the phase that implements them narrows it here, in the same
change as the code and `docs/native-protocol.md`.

The current helper implements `hello`, `probe`, `scan`, `query-index`, and `cancel`. Every
other operation in the enum is recognized and refused with `unsupported-operation`; anything outside it is
`unknown-operation`. `tests/contract/native-schema.test.mjs` validates the examples and
`tests/integration/native.test.mjs` validates the real helper's output against
`event.json`.
