# ADR 0004: One reviewed action pipeline and one durable journal

Status: accepted

## Context

Disktop deletes things. The failure that matters is not a crash, it is quietly removing
data a user did not agree to lose, or claiming to have freed space it did not free.
Findings come from many providers, actions run through several mechanisms — the helper
for user files, fixed-argument adapters for package and container managers — and any of
them could grow its own delete path.

## Decision

Every mutation, from any source, goes through one pipeline: discover, preview into an
immutable expiring `ActionPlan`, confirm, revalidate per item, journal intent, apply,
journal outcome, verify. Only `src/application/apply-action.ts` may commit a plan. Only
the Rust helper may mutate arbitrary filesystem paths, and only the Rust helper writes
the durable action journal — including for manager-backed operations, which report
through `manager-begin`, `manager-append`, and `manager-finish`.

A provider proposes; it never deletes. A CLI handler and a TUI view call application
services; they never invoke the helper or a Linux command. This is enforced by the layer
rules in `eslint.config.mjs`, not only by review.

The plan fixes the operation before review: Trash versus permanent removal, move
destination, compression output, hardlink replacement. `--permanent` at apply time only
acknowledges a plan that already contains irreversible removal; it cannot upgrade a Trash
plan. Trash is the default, and a Trash move on the same filesystem usually frees nothing
until Trash is emptied, so results report selected bytes, bytes moved to Trash, and
observed free-space change as three separate numbers.

Protected roots are policy in `src/domain/protected-paths.ts` and are re-enforced
independently inside the helper. No flag overrides them.

## Consequences

Adding an action means extending the pipeline, not adding a code path, which is more work
per feature and the point of the decision. Recovery has one place to look: the journal is
the only durable record, so startup reconciliation is well defined and an action result
without a journal outcome is a protocol violation. Because the helper repeats Node's
checks, a bug on the Node side is not sufficient to delete the wrong thing.

The residual risk this design does not remove is documented in
[threat-model.md](../threat-model.md): an actor who can write to a target's parent
directory can still swap the final component between check and operation.

## Alternatives considered

Letting each provider perform its own cleanup is simplest and is how tools of this kind
usually grow a data-loss bug. A Node-side journal was rejected because two writers cannot
give one ordering across a crash, and because the process that performs the mutation is
the only one that knows what actually happened. Trusting Node's protected-path check
alone was rejected because the helper is the component holding the descriptors.

## Evidence and follow-up

Phase 4's gate: sandbox, symlink and bind-mount, collision, protected-root, invalid-byte,
crash-injection, and undo tests, with moved-to-Trash and observed free-space reported as
distinct values. Fault injection runs before and after every journal transition.
