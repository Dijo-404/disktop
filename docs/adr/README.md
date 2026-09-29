# Architecture decision records

Architecture decision records (ADRs) explain choices that affect multiple modules or are hard to reverse. This directory starts as a template and index; no decision record has been finalized in the scaffold.

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

The first records should cover the terminal renderer, Rust child-process and SQLite index design, prebuilt binary packaging, and safe action/journal approach. An ADR does not override [PLAN.md](../../PLAN.md) or [AGENTS.md](../../AGENTS.md); if a decision changes a contract, update the plan, schema, tests, and affected docs in the same change.
