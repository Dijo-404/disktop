# ADR 0007: Manager actions are derived argv, journalled by the helper, escalated one command at a time

Status: accepted

## Context

Package caches, the journal, Snap and Flatpak, Docker and Podman, old kernels, and
tmpfiles-managed state belong to programs that know their own invariants. Disktop must
not delete their files itself ("never `rm -rf` manager-owned state directly"), many of
the commands need root, and the plan a person reviews is a file anything running as them
can edit. A manager action is also the one kind of action whose side effect happens in a
process the helper does not control, so the journal has to record it from outside.

## Decision

A manager plan stores an action id, its items, and its parameters, and nothing else.
`src/domain/managers.ts` holds the whole set of actions and, for each, a fixed template
that derives the argv from the validated items and parameters. Commands are never stored
in a plan file: the decoder rebuilds them, so an edited plan can change which reviewed
items are named but cannot name a different program or option. Every item is checked
against its action's pattern, and an id that could read as an option is refused.
Removals of images, containers, and volumes are never forced, so the engine refuses
anything in use; only anonymous Docker and Podman volumes are ever offered.

Adapters in `src/platform/linux/managers/` discover and preview through the read-only
`ToolPort`, whose allowlist now matches whole argument vectors, preflight live before
anything runs, and verify by asking the manager again afterwards. The executor opens one
helper session for the whole action: `manager-begin` records the commands and items,
`manager-append started` is durable before each command is spawned and `finished` after
it, and `manager-finish` records every item's outcome. Only the helper process that began
an action may append to it, so a crash leaves a command that started and never finished,
which reconciliation reads as `uncertain`.

A root-privilege command is wrapped in `sudo` (with `-n` when nobody can answer a prompt)
or, interactively and without sudo, `pkexec`, around the absolute trusted executable. The
npm process is never escalated. sudo's own refusal is told apart from the command's
failure by its `sudo:` prefix and becomes a skipped item and a failed check, never a
fallback. Under EUID 0 Disktop refuses every generic mutation, in Node and in the helper,
and still runs reviewed manager actions.

## Consequences

Adding a manager action means adding a template, a pattern, and an adapter's discover,
preflight, and verify, plus the queries the adapter makes to the allowlist. A manager may
not say beforehand how much it will remove; such a plan has no `selectedBytes` and says
so. Flatpak and tmpfiles decide their own selection, so what they removed is recorded
afterwards as observed items. The free-space readings around an action remain the
measurement; a manager's own figures are estimates.

## Alternatives considered

Storing argv in the plan and checking it against an allowlist at apply time was
rejected: the template is the allowlist, and deriving is simpler than comparing. Letting
the helper run manager commands would have put command execution in the component whose
job is to refuse; Node already has the fixed-argv runner. Escalating the whole CLI for a
root action was rejected by the privilege contract.

## Evidence and follow-up

`tests/unit/managers.test.mjs` and `plan-store.test.mjs` pin derivation and the refusal
of an edited plan; `manager-execute.test.mjs` the journal order, preflight refusal,
denial, and cancellation; `privilege.test.mjs` escalation and denial; the per-adapter
tests their parsers against fixtures from Debian, Fedora, Arch, Snap, Flatpak, Docker,
Podman, and systemd-tmpfiles output. `tests/recovery/journal.test.mjs` kills the helper
after a command started. `tests/integration/managers-host.test.mjs` reads this host's
managers without changing anything, and `managers-pipeline.test.mjs` applies a manager
plan against the real helper journal with a fake runner. No real manager command is run
by the test suites.
