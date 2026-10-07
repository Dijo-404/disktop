# Testing Disktop on real systems

The release owner assigned the remaining SMART hardware health, ZFS, WSL and
non-cache manager checks to testers after the initial `1.0.0` publication on
2026-10-07. Their status remains **unvalidated** in the
[support matrix](support-matrix.md) until results are reviewed. Automated CI and
the guarded publishing workflow still run their required checks.

## Get the version under test

Once `1.0.0` is available on npm, install it as an ordinary account:

```sh
npm install -g disktop@1.0.0
disktop --version
disktop --help
node --version
uname -srmo
```

Supported runtimes are Node 24.21.0+ within Node 24, or Node 26.10.0+ within Node 26.
Full scanning and cleanup need Linux 5.6+ with `openat2` available. The package
contains helpers for x86-64 and ARM64 on glibc and musl; it needs no Rust compiler.

Before publication, use the exact tarball from a CI artifact or the release build.
Install it into a separate prefix and record its checksum:

```sh
sha256sum /absolute/path/disktop-1.0.0.tgz
npm install --prefix "$HOME/disktop-acceptance" --ignore-scripts \
  /absolute/path/disktop-1.0.0.tgz
"$HOME/disktop-acceptance/node_modules/.bin/disktop" --version
```

For a source build, follow [CONTRIBUTING.md](../CONTRIBUTING.md) and record
`git rev-parse HEAD`. Use the installed command's absolute path when several
Disktop builds are present, so evidence identifies the artifact actually tested.

## Record useful evidence

Use the repository's [test-result form](https://github.com/Dijo-404/disktop/issues/new?template=test_result.yml)
for passed, failed or blocked checks, or open a PR updating the relevant support
matrix row with the same evidence. Report ordinary defects through the
[bug form](https://github.com/Dijo-404/disktop/issues/new?template=bug_report.yml).
Follow [SECURITY.md](../SECURITY.md) for exploitable or destructive bugs.

Include the package version, source commit or tarball checksum where applicable,
distribution, kernel, Node version, installation method, relevant tool versions,
fixture/setup, exact commands, exit codes, expected behavior and observed behavior.
Attach relevant sanitized JSON or terminal captures. Remove tokens, credentials,
private paths and unrelated device identifiers before sharing them.

Exit `0` means complete, `2` means invalid input or an operational failure, `3`
means incomplete readings, and `130` means interrupted. `alerts check` uses `1`
when an alert threshold is reached. A denied hardware reading that reports its
reason correctly can pass the denial check; it does not prove actual health support.
A missing tool or an empty cleanup plan does not prove that its action works.

## SMART hardware health

On a machine with a real supported drive and `smartctl` installed:

```sh
disktop devices --json
disktop clean --category diagnostic --no-sizes --json
```

Compare the SMART finding with the same device's read-only `smartctl -H -A -j`
health output. Record the drive type, smartctl version, permissions and exit codes.
Check both a readable health result and a denied reading. A denied device must
remain explicitly unavailable/incomplete, never appear healthy or contribute a
made-up zero. A drive reporting failed health should produce a FAILED health
finding; readable failed-health readings can still be complete.
Do not run `sudo npx disktop` or grant broad device access for this test; privileged
read-only Disktop execution requires a root-owned runtime and installation as
described in [safety](safety.md).

## ZFS snapshots

Use a disposable VM with a test pool and a known snapshot. Record its
`zfs list -H -p -t snapshot -o name,used` output, then run:

```sh
disktop clean --category system-snapshot --no-sizes --json
```

Verify names and the ZFS-reported used-byte figures quoted in each finding's
evidence match. Snapshot footprints remain unknown; the quoted ZFS figure is not
added to measured filesystem totals. Check the ordinary-account permission failure
and missing-tool cases too. Denied, failed or malformed readings must carry warnings and incomplete
status; a missing optional tool is an absent capability. This detector is read-only
and offers no snapshot deletion. Never create a test pool on a disk holding real data.

## WSL

Use actual WSL 2 and record the Windows/WSL versions along with the Linux readings.
Create a small directory on the Windows side containing files with known content
and sizes; do not scan the whole Windows drive for this check.

1. Run `disktop devices --json` and the diagnostic command above. Mounted Windows
   storage and WSL diagnostics should be identifiable.
2. With the default configuration, scanning that fixture below `/mnt/c` must report
   its exclusion rather than claim a complete reading of it.
3. In `config.toml`, set `exclude_windows_mounts = false` under `[scan]`, then select
   the same fixture explicitly:

   ```sh
   disktop scan /mnt/c/path/to/test-directory --accounting apparent --json
   disktop explore /mnt/c/path/to/test-directory --kind file --json
   ```

   Check names, apparent sizes and completeness against the fixture. Preserve any
   other configured excludes. Naming the path or using `--cross-filesystems` alone
   does not disable the Windows exclusion. Restore your prior setting afterwards.

## Non-cache manager actions

Actual apt, DNF5 and pacman cache cleanup already passed in disposable containers.
The remaining actions need real manager environments; fake-runner integration
coverage is recorded separately. Use a disposable VM with a snapshot and fixture
data for every mutation. Run Disktop as an ordinary account and grant only the
exact reviewed manager command the required privilege.

| Manager | Fixture and preservation check |
| --- | --- |
| journald | Seed archived journals beyond the configured retention; vacuum them and preserve active journals. |
| Snap | Remove a disabled revision and preserve the active revision. |
| Flatpak, user/system | Remove an unused runtime and preserve installed apps and their required runtimes. |
| Docker/Podman | Exercise each supported cleanup action; preserve running containers, retained images, named volumes and volumes still in use. |
| dpkg/rpm kernels | Install a removable old kernel; preserve the running and newest kernels, then verify the VM still boots. |
| systemd-tmpfiles, user/system/crash | Seed files matching the actual cleanup policy; remove eligible aged fixtures and preserve fresh or out-of-scope sentinels. |

Discover with `disktop clean --no-sizes --json`. Review the relevant finding using
`disktop clean plan FINDING_ID --operation manager --json`. Inspect its item scope,
derived commands and privileges before applying in the disposable VM. Every manager
plan is irreversible and needs both `--yes` and `--permanent`; it has no undo.
Follow the [manager CLI contract](cli.md#manager-actions).

Capture the reviewed plan, apply result, history, manager state before and after,
and preserved sentinels. A successful run requires actual fixture removal, passed
live verification and finished journal commands. Denied authorization or
cancellation must not claim success. Once execution begins, retain the finished
or incomplete/uncertain journal; cancellation or refusal during preflight may
produce an error without starting an action. Limit a support-matrix update to the
action and environment you actually tested.
