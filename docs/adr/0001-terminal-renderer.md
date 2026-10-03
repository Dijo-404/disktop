# ADR 0001: Terminal renderer

Status: accepted

## Context

The TUI must work at 80×24, over SSH and inside tmux, with vim keys and mouse input, with
colour, an ASCII fallback, and `NO_COLOR`. It must restore the terminal after a normal
exit, an uncaught exception, and a signal. Disktop is installed with `npx`, so every
runtime dependency is downloaded on first use and any native addon would break the
"no install script" rule in ADR 0003.

## Decision

Render with `terminal-kit`, reached only through a `Renderer` interface in `src/tui/render.ts`.
Views build a description of what to draw; the adapter is the only module that touches
the library or writes escape sequences. Terminal restoration is owned by the app
lifecycle in `src/tui/app.ts`, registered before the first draw, and runs on normal exit,
`SIGINT`, `SIGTERM`, `SIGHUP`, and an uncaught exception.

## Consequences

The library choice stays replaceable: a second renderer only has to satisfy the
interface, and PTY tests target the interface's observable output rather than
`terminal-kit` internals. Views cannot smuggle escape sequences into the screen, which
is what makes the sanitized display string from `domain/paths.ts` meaningful — a filename
reaches the screen as text, never as control bytes. The cost is an indirection layer and
the risk that a future requirement needs a library feature the interface does not expose;
that widens the interface rather than bypassing it.

## Alternatives considered

`blessed` and `neo-blessed` are effectively unmaintained. `ink` pulls in React and a
reconciler for a table-heavy, keyboard-driven application that needs none of it.
`ratatui` in the Rust helper would move the UI into the binary and leave the
`npx`-installable Node package as a thin launcher, which loses the non-interactive CLI's
shared code path. Writing raw escape sequences was rejected because terminal restoration
and input decoding are exactly the parts that are easy to get subtly wrong.

## Evidence and follow-up

`tests/pty/` must cover 80×24, `NO_COLOR`, `TERM=dumb`, vim keys, mouse toggling, tmux,
and restoration after `SIGINT` and after a thrown exception. The choice is not locked
until those pass on a real PTY; ADR 0001 is revisited if `terminal-kit` fails any of them.

Phase 1 evidence: `tests/pty/cli.test.mjs` drives a real 80×24 pseudo-terminal and covers
the dashboard drawing, vim keys, `NO_COLOR`, `TERM=dumb`, quitting with `q`, and terminal
restoration on the way out and after Ctrl+C. Keys are sent only once the program has taken
the keyboard; sent sooner they are handled by the line discipline, which tests the kernel
rather than Disktop. `terminal-kit` restores the cursor with the terminal's own sequence
rather than a fixed `?25h`, so the assertion accepts either form.

Phase 7 evidence, which locks the choice: `tests/pty/cli.test.mjs` now also covers a
mouse click on a tab (SGR reporting requested on entry and switched off on exit), a
non-UTF-8 locale drawing ASCII only, `NO_COLOR` writing attributes but no colour
parameter, every tab drawing in a real terminal, and an exception thrown from a timer
while the TUI runs: the terminal is restored before the reason is written and the
process exits `2`. `tests/pty/tmux.test.mjs` drives the TUI inside tmux and checks what
the pane shows after keys, after resizing to 60×18 and below the 40×10 minimum, and after
quitting. SSH adds nothing a PTY does not exercise; it remains a host check in the
support matrix rather than a test.

Two things the library does that the adapter now guards against: `terminal(text)` reads
`%` and `^` in its argument as format and markup syntax, so every frame is written with
`noFormat`; and redrawing by erasing the screen flickers, so the adapter keeps the last
frame and writes only the rows that changed, in one write.
