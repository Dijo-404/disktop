# Recovery tests

`journal.test.mjs` kills the real helper partway through a list of targets and reads
the journal back through the same `journal-reconcile` operation Disktop itself uses.

It asserts the four things the phase gate asks for: an interrupted record never reads
as complete; no item is left claiming to be running once reconciliation has looked at
it; nothing left its original path without the journal accounting for it; and
reconciling twice changes nothing the second time. A fifth case runs an action to
completion, so the others cannot pass by the helper simply failing.

Every tree lives under the system temporary directory and holds nothing but fixture
bytes. Run them with `npm run test:recovery`, which is part of `npm run check`.
