# Action threat model

Status: Phase 0 contract. It covers the actions Disktop performs on a user's filesystem;
it is the reasoning behind the rules in [safety.md](safety.md) and
[ADR 0004](adr/0004-reviewed-action-pipeline.md). Disktop makes no network requests and
collects no telemetry, so there is no remote attack surface to model.

## What is being protected

A user's data, and the user's correct belief about what happened to it. The second
matters as much as the first: a result that overstates what was freed, or understates
what was removed, is a failure even when no bytes were lost.

## Who the attacker is

Disktop runs as the user, on the user's machine, so the interesting attackers are not
remote. They are:

1. **Another local process running as the same user** — a compromised browser extension,
   a build script, a background sync client. It can create, move, and delete anything the
   user can, at any moment, including between Disktop's check and Disktop's action.
2. **A local user who can write into a directory Disktop will act in** — anyone with
   write access to a shared or world-writable parent, `/tmp` most obviously.
3. **Whoever authored the filenames** — an extracted archive, a downloaded dataset, a
   dependency's cache. Names are attacker-controlled input.
4. **Whoever authored a manager's output** — `apt`, `docker`, `snap` and friends produce
   text Disktop parses; a package name is also attacker-influenced input.
5. **The user, by mistake** — the most common case. Selecting the wrong directory,
   answering a prompt without reading it, or believing an estimate was a measurement.

The user acting deliberately is not an attacker. Disktop refuses protected paths anyway,
because an intentional `rm -rf /usr` is not a use case it needs to serve.

## Trust boundaries

| Boundary | What crosses it | Why it is not trusted |
| --- | --- | --- |
| Filesystem to scanner | names, sizes, link counts, mount topology | attacker-controlled; changes while being read |
| Provider to application | findings, estimates, scopes | a provider is ordinary code that can be wrong |
| Stored plan to apply | an expiring reviewed plan | a file the same user, or anything running as them, can edit |
| Node to helper | requests over stdin | a bug in Node must not be sufficient to delete the wrong thing |
| Manager to adapter | command output and exit status | free-form text from another program |
| Disktop to screen, report, log | filenames and paths | a name can contain escape sequences, newlines, or a formula |
| User to privileged action | a `sudo`/`pkexec` confirmation | authority for one fixed command, not for the process |

## Attacks and what stops them

**Swap the target between check and action (TOCTOU).** Resolve every operation from a
verified parent directory descriptor, never from a path string, with `openat2` refusing
symlinks and mount crossings; compare the live `{device, inode, mount, type, size, mtime}`
against the fingerprint the reviewed plan recorded and skip anything that differs. This
narrows the window to the last component. *It does not close it* — see residual risks.

**Point a symlink at something else.** Symlinks are never followed, during scan or
during deletion. A selected symlink can be removed as the link object, under the same
policy, and removing it never touches its target.

**Reach a protected path by another name.** `/home/user/link-to-etc`, a bind mount of
`/etc` under the home directory, `..` inside a plan, a path with a trailing slash or a
doubled separator. Targets must be absolute and already normalized — unnormalized input
is refused rather than resolved — containment is compared segment by segment over bytes,
and backing mount and root identity are checked so an alias does not inherit the
allowance. `/home/example-backup` is not inside `/home/example`.

**Escalate through configuration.** `additional_allowed_roots` cannot name a protected
root, and it cannot name a shared container root either — `/home`, `/tmp`, `/var/tmp`,
`/mnt`, `/media`, `/run/media` — because allowing `/home` would otherwise reach every
other account on the machine. An allowed root is the scope of cleanup, never a target
itself, so widening the allowlist cannot turn a whole root into one selection. An unknown
key or section is an error, and a key that would become an object's prototype is refused
at the parser, so a misspelling cannot disable a guard by leaving it at a default the user
believes they changed. Every integer setting is bounded, so a typo cannot make a reviewed
plan effectively never expire. There is no `--force` for a protected path.

The policy works on path bytes and cannot see ownership, so a root the user configures
inside their own home but which another account can write to is not detected here; the
helper checks ownership and parent safety against live descriptors before acting.

**Edit a stored plan.** A plan carries a checksum and an expiry, which detect corruption
and staleness. They do not defend against deliberate editing by the same user — nothing
can, since the user owns the file — which is why revalidation against live fingerprints
happens at apply time regardless of what the plan claims, and why the helper repeats the
protected-path check independently.

**Inject through a filename.** A name containing `\u001b[2J`, `\u009b2K`, U+202E, a
newline, or a leading `=` reaches a terminal, a log, an HTML report, and a CSV cell.
Display text is sanitized at the boundary where it is created, not at each use: C0
controls and DEL become Unicode Control Pictures, C1 controls, the line and paragraph
separators, and the bidirectional marks, overrides and isolates become `<U+XXXX>`,
invalid UTF-8 becomes U+FFFD, HTML escapes every value, and CSV prefixes a cell starting
`=`, `+`, `-`, or `@`. The lossless bytes travel separately and are what the operation
uses. The schemas reject a display string containing any of those characters, so this
cannot regress silently.

What this does *not* give is uniqueness: distinct byte sequences can render identically,
and a file named `\u2400` looks like one containing a NUL byte. Two targets can therefore
look alike in a prompt, which is why confirmation shows scope and counts rather than
relying on a name.

**Feed the parser a hostile response.** The helper rejects unknown fields, unknown
operations, wrong protocol versions, malformed base64, out-of-range integers, and
requests over 1 MiB, draining an oversized line so the next request stays in sync. Node
validates every event before acting on it and never treats a missing final event as
success.

**Escalate a privileged action.** Only a specific adapter escalates, with fixed
arguments, an absolute trusted executable path, and after plan confirmation. The npm
process is never run as root for cleanup; under EUID 0 generic mutation is disabled and
administrator scans are read-only. A failed authentication is a permission result, never
a fallback to unprivileged deletion.

**Make the user believe a wrong number.** Estimated selected bytes, bytes moved to Trash,
and observed free-space change are three separate values, never summed into one claim.
Manager-reported counts stay labelled estimated or unknown and are never promoted to
exact. A missing tool is a capability state, not a zero. The observed free-space change
may include unrelated activity, and Disktop says so rather than attributing it.

**Interrupt at the worst moment.** Intent is journalled before any side effect and the
outcome after it, by a single writer. `Ctrl+C` stops before the next item and records a
partial result. Startup reconciles unfinished records before offering undo. Recovery
tests inject failure around every journal transition and verify replay does not repeat a
successful destructive operation.

## Residual risks, accepted and documented

- **Last-component name swap.** An actor with write access to a target's parent directory
  can replace the final component between fingerprint verification and the operation.
  The window is minimized and tested, unsafe shared-writable parents are refused, and
  Disktop does not claim to eliminate this race.
- **A plan edited by its owner.** Detected only insofar as revalidation and the helper's
  independent checks reject what it asks for. A checksum cannot authenticate against the
  user who owns the key material, and Disktop does not pretend otherwise.
- **Reclaimed space is not always predictable.** Reflinks, compression, snapshots, and
  files still held open by another process mean the bytes a scan counted and the bytes
  `statfs` reports freed can legitimately differ. Disktop reports both rather than
  reconciling them.
- **Trash frees nothing immediately.** A Trash move on the same filesystem relocates data
  without increasing free space until Trash is emptied. This is stated in the preview and
  in the result.
- **A caller that supplies an incomplete context.** `classifyGenericTarget` fails closed
  on an empty mount or excluded-root list rather than skipping those rules, but it cannot
  detect a context that is merely wrong — a stale mount list, for example. The helper's
  independent checks are what catch that.
- **Manager actions can be irreversible and imprecise.** A manager may not offer a
  preview or exact counts. Disktop refuses an action whose destructive scope cannot be
  bounded, and labels the rest honestly instead of inventing precision.
