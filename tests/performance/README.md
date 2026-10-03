# Performance tests

`scan-memory.test.mjs` measures the budget recorded in
[ADR 0002](../../docs/adr/0002-native-helper-and-index.md). `npm run test:performance`
runs it on a 100,000-entry tree; `npm run bench` builds a release helper and runs it on
the million-entry reference tree (`DISKTOP_BENCH_ENTRIES=1000000`). Timings are binding
only against a release helper; a debug build's are reported and not enforced.

- Node's peak RSS for the same scan at a tenth and at the full size, which must stay
  under budget and must not grow with the entry count, then one `explore` page timed
  end to end including process start.
- One directory holding half the entries, every file empty so every size ties: its row
  is found with `atPath`, then its children are paged by `parentId` in every sort order,
  200 per page, through one long-lived helper. The median page must stay under 50 ms,
  and the helper's resident set must not move by 4 MiB over ten further cycles of every
  page, which is what a per-page leak would show.
- The helper's own first progress event and peak RSS for the full tree.

Record the machine, its filesystem, and the entry count beside any figure you quote.
