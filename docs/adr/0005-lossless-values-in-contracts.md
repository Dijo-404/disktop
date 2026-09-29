# ADR 0005: Decimal strings and base64 path bytes in every contract

Status: accepted

## Context

Two Linux facts break the obvious JSON encoding. Filenames are byte strings that need not
be valid UTF-8, and filesystem integers — inode numbers, byte totals, nanosecond
timestamps — exceed 2^53, where an IEEE 754 double silently rounds. A rounded byte total
is a wrong number in a report. A path that has been through a lossy decode is a wrong
target for a delete.

## Decision

In native IPC, persisted plans, and public CLI JSON, every filesystem identity, count,
byte size, and nanosecond timestamp is a base-10 string. Node parses them as `BigInt`
and never converts them to `number`. A path is an object: `bytesBase64` holds the raw
bytes and is the only value an operation may resolve, `display` is sanitized text for
terminals, HTML, CSV, and logs, and `utf8` is present only when the bytes decode
losslessly.

Sanitizing replaces C0 control bytes with their Unicode Control Pictures, DEL with its
picture, and invalid sequences with U+FFFD. C1 controls, the line and paragraph
separators, and the bidirectional marks, overrides, and isolates become `<U+XXXX>`,
because U+009B is CSI to a terminal reading UTF-8 and U+202E makes one name render as
another. Zero-width joiners are left alone: they carry meaning inside real emoji
sequences. CSV additionally prefixes a cell beginning `=`, `+`, `-`, or `@`; HTML escapes
every value.

This makes display text safe to print. It does not make it unique — two byte sequences
can still render the same — which is why an operation is identified by `bytesBase64` and
never by what the user reads. A confirmation prompt therefore shows scope and counts, not
a name alone.

The JSON Schemas in `schemas/` enforce this: a byte total typed as a JSON number and a
path given only as a display string both fail validation, and the negative examples in
`examples/invalid/` exist to prove it.

## Consequences

Consumers must parse strings to get numbers, which is the trade being made deliberately:
a slightly less convenient contract in exchange for values that are never silently wrong.
Internally the same rule means `bigint` in domain types and no arithmetic that passes
through `number`. Every new field in a public contract has to pick the correct
representation, and the schema's negative examples are how that stays true.

## Alternatives considered

JSON numbers with a documented "may round above 2^53" caveat puts the burden on every
consumer and produces reports that are quietly wrong. Percent-encoded paths are
lossless but are easy to feed back into an operation still encoded. Emitting only the
display string was rejected outright: it cannot round-trip, which is exactly the property
a delete target needs.

## Evidence and follow-up

`tests/contract/cli-schema.test.mjs` and `tests/contract/native-schema.test.mjs` validate
the examples on both sides, `tests/unit/sizes.test.mjs` covers integers past
`Number.MAX_SAFE_INTEGER`, and `tests/unit/paths.test.mjs` covers invalid UTF-8, control
bytes, and segment-boundary containment. Phase 7 adds the CSV and HTML injection
fixtures.
