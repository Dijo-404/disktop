# Fixture generators

`generate.mjs` builds throwaway trees for the shapes Disktop has to survive: sparse
files, hardlinks, symlinks including a loop and a broken link, an unreadable directory,
deep nesting, and names carrying invalid UTF-8, a newline, a terminal escape, an emoji,
or the maximum 255 bytes.

Every tree is created with `mkdtemp` under the system temporary directory, and `cleanup`
refuses any root it did not create, so a destructive test cannot be aimed at real data.
`createStandardFixture` returns a manifest naming each entry, and `createLargeFixture`
builds a wide tree of a chosen size for the scan budget. `createHostileNameFixture`
builds a tree whose names are built to break an export — a spreadsheet formula, a script
tag, quotes and commas, line breaks, terminal escapes, a direction override, invalid
UTF-8, an emoji, a 255-byte name — with each one's exact bytes in its manifest.

`node scripts/generate-fixtures.mjs standard` (or `large 1000000`) builds one outside the
test runner and prints its path; removing it is then your job.

Mount behaviour — bind mounts, nested mounts, removable and network mounts — cannot be
faked with files. Those tests need a mount namespace or a virtual machine and arrive with
the scanner in Phase 2.
