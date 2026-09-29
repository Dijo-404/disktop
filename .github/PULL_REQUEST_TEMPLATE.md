## Change

Describe the behavior or documentation changed and why it matters to a user.

## Plan traceability

- Owning folder or module:
- [PLAN.md](https://github.com/Dijo-404/disktop/blob/main/PLAN.md) phase and feature acceptance row:
- Port, schema, provider ID, or persisted format changed (or `none` with a reason):

## Safety and public behavior

For a cleanup or scanner change, describe the capability and permission checks, protected-path or mount behavior, reversibility, cancellation, and how partial results are shown. For other changes, state why these do not apply.

Describe any CLI syntax, JSON schema, exit-code, TUI, or report change. Link the corresponding documentation or schema update, or explain why none is needed.

## Verification

- Fixture or sandbox used:
- Acceptance test added or updated:
- Commands run and results:
- Remaining limits or follow-up work:

Do not mark a plan phase or the single `1.0.0` release gate complete without its required evidence. Destructive tests must use temporary sandboxes; mount and privilege behavior needs a mount namespace or VM.
