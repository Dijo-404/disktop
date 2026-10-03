# Architecture decision records

Architecture decision records (ADRs) explain choices that affect multiple modules or are hard to reverse.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-terminal-renderer.md) | `terminal-kit` behind a renderer interface, with lifecycle-owned terminal restoration | accepted |
| [0002](0002-native-helper-and-index.md) | A Rust child process owns traversal, the SQLite index, and mutation; the scan budget | accepted |
| [0003](0003-prebuilt-binary-packaging.md) | Prebuilt helper binaries in one npm tarball, with no install script | accepted |
| [0004](0004-reviewed-action-pipeline.md) | One reviewed action pipeline and one durable journal | accepted |
| [0005](0005-lossless-values-in-contracts.md) | Decimal strings and base64 path bytes in every contract | accepted |
| [0006](0006-content-identity-and-archive-dependencies.md) | A digest groups candidates, a byte compare authorises a mutation | accepted |
| [0007](0007-manager-adapters-and-scoped-privilege.md) | Manager actions are derived argv, journalled by the helper, escalated one command at a time | accepted |

Create one numbered Markdown file per decision, for example `0001-terminal-renderer.md`. Use this structure:

```markdown
# ADR 0001: Decision title

Status: proposed | accepted | superseded

## Context

What requirement or constraint creates the decision?

## Decision

What will the implementation do?

## Consequences

What changes for code, tests, packaging, users, and maintainers?

## Alternatives considered

Which credible options were evaluated and why were they not selected?

## Evidence and follow-up

Which fixture, benchmark, or acceptance test validates the choice?
```

An ADR does not override [PLAN.md](../../PLAN.md) or [AGENTS.md](../../AGENTS.md); if a decision changes a contract, update the plan, schema, tests, and affected docs in the same change.
