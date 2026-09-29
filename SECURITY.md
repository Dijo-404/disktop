# Security policy

Disktop inspects storage and can act on files after review. Treat a bypass of protected paths, unintended deletion, restore corruption, command injection, or an incorrect cleanup preview as a security issue.

## Supported versions

Disktop has no public release yet. Security support begins with `1.0.0` after the full release gate in [PLAN.md](PLAN.md) passes. Development snapshots and CI artifacts are not supported releases.

## Private reporting

Use the repository's **Report a vulnerability** option under the GitHub Security tab if it is enabled. Include the affected commit or version, Linux distribution and kernel, a minimal reproduction in a temporary sandbox, and the observed versus expected behavior. Do not include real filenames, home paths, credentials, or user data. If private vulnerability reporting is unavailable, contact the repository owner through a private channel before opening a public issue for an exploitable bug.

Please do not run a destructive reproduction on a real filesystem. Maintainers will reproduce filesystem behavior in a temporary sandbox, mount namespace, or VM and coordinate disclosure after a fix is ready.
