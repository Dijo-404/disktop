# Native helper protocol schemas, version 1

These files are the normative wire contract between Node and the bundled `disktop-fs`
helper. `request.json` is one line of the helper's stdin, `event.json` one line of its
stdout, `common.json` the shared definitions, and `hello-result.json` the only completion
shape the current helper build can produce.

What the schemas fix now, before the operations exist:

- Paths cross the boundary as base64 raw bytes only. A display string is not a valid
  path value, so a target can never be reconstructed from sanitized text.
- Device and inode numbers, byte sizes, and nanosecond timestamps are base-10 strings,
  outside the range where a JSON number would round.
- Every mutation request carries the reviewed `planId` and, per target, the
  `{device, inode, mountId, kind, apparentBytes, modifiedNanoseconds}` the plan observed.
  There is no shape for a mutation without a plan or without a fingerprint.
- `scan` has no option to follow symlinks, because it never does.
- Requests and events are closed to unknown fields, and `requestId` is restricted to an
  alphabet that is safe to echo into logs.
- `requestId` may be null only on an event the helper could not correlate.

The operation list is complete for `1.0.0`; argument schemas exist for the operations
whose contract is fixed (`hello`, `probe`, `cancel`, `scan`, `trash`, `erase`,
`empty-trash`, `journal-reconcile`). The remaining planned operations validate as an
open `arguments` object until the phase that implements them narrows it here, in the same
change as the code and `docs/native-protocol.md`.

The current helper implements `hello` and `probe`. Every other operation in the enum is
recognized and refused with `unsupported-operation`; anything outside it is
`unknown-operation`. `tests/contract/native-schema.test.mjs` validates the examples and
`tests/integration/native.test.mjs` validates the real helper's output against
`event.json`.
