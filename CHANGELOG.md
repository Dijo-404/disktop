# Changelog

All public changes will be recorded here when the first complete Linux release is published.

## Unreleased

### Phase 0: contracts and threat model

- Added normative JSON Schemas for CLI output (`schemas/cli/v1/`) and the native helper
  protocol (`schemas/native/v1/`), each with valid and invalid examples under contract test.
- Added byte-exact path handling and the protected-path refusal policy in `src/domain`.
  Display text neutralizes C0 and C1 controls, DEL, line and paragraph separators, and
  bidirectional overrides; the policy refuses shared container roots such as `/home`,
  refuses an allowed root as its own target, and fails closed on an incomplete context.
- Added XDG location resolution, configuration defaults, and a strict TOML subset reader
  in `src/storage`, with a documented `docs/config.example.toml`.
- The source dependency rule is now enforced by `eslint.config.mjs` and proven by a test.
- Added the filesystem fixture generator and the `npm run fixtures` entry point.
- Specified `cancel` in the helper protocol; it is recognized and refused as unsupported.
- Fixed the kernel and architecture minimums, added `docs/threat-model.md`, and recorded
  ADRs 0001 to 0005.

### Earlier

- Added the project plan, agent guide, architecture documents, and development scaffold.
- No storage inspection or cleanup feature is available yet.
