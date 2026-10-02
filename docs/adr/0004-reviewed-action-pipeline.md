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

Phase 4 met this gate. `tests/integration/actions.test.mjs` drives the real helper
through the CLI against a throwaway home: a Trash move and its undo, a hostile name
that round-trips byte for byte, a collision that keeps both files, a protected root
refused at planning time, a symlinked parent that is not followed, a permanent erase
that removes a link without following it and offers no undo, `--permanent` refused on
a Trash plan, an expired plan, a changed target that is skipped, a journal record
behind every action, and moved-to-Trash reported apart from an observed free-space
change of zero. `tests/recovery/journal.test.mjs` kills the helper partway through a
list of targets and asserts that the record never reads as complete, that no item is
left claiming to be running after reconciliation, that nothing left its original path
without the journal accounting for it, and that reconciling twice changes nothing.

One limit survives and is documented rather than papered over. (A second one, that a
reviewed directory was revalidated only by its own identity, was closed later: plans
now carry a digest of everything below a directory, checked again before it is
touched.) The last-component rename race in
[threat-model.md](../threat-model.md) is unchanged: the helper narrows the window to
one `statx` and one syscall against a parent descriptor it opened itself, and refuses
a parent any user can write to without a sticky bit, but it does not claim to have
closed it.

Phases 5 and 6 extend the same pipeline to move, compression, hardlink replacement,
and the manager adapters. None of them may add a code path around it.
