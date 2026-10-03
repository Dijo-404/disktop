# Terminal UI

`disktop` with no arguments on a terminal opens the TUI. It is built from three
layers, and only the last one talks to the terminal:

- `state.ts`, `controller.ts` — what is on screen, and what each key does where
  it lands. Every piece of work (a scan, an index page, discovery, a plan, an
  apply) is a task with its own `AbortController`; a newer task of the same kind
  supersedes an older one, and a task writes its result only while it is still
  the current one, so a slow old answer never overwrites a new one. Tasks that
  change the disk are never abandoned: Esc and Ctrl+C ask them to stop after the
  current item, and leaving waits for them to report.
- `screen.ts`, `views/`, `widgets/` — pure functions from state to a `Frame`:
  exactly as many rows as the terminal, none wider than it, measured in
  terminal cells (`text.ts`) so wide and emoji names keep columns aligned.
- `render.ts` — the terminal-kit adapter behind the `Renderer` interface. It
  writes only the rows that changed, in one write, through `noFormat` so that
  `%` and `^` in a filename are never read as terminal-kit syntax, and strips
  control characters from every span as the last line of defence. It owns
  fullscreen, raw input, mouse, resize, and suspend/resume around a `sudo`
  prompt.

The TUI reaches only application services (`services.ts`), the same ones the
CLI handlers receive; the dependency rule forbids anything else.

Themes (`themes.ts`): colour depth comes from `TERM`/`COLORTERM`; `NO_COLOR`
(non-empty) removes colour and keeps bold and inverse; glyphs are Unicode only
when the locale is UTF-8 and `TERM` is not the kernel console, or
`DISKTOP_ASCII=1` forces ASCII. `TERM=dumb` gets the text dashboard instead.
`DISKTOP_NO_MOUSE=1` leaves mouse reporting off.

Terminal state is restored on a normal exit, on `SIGINT`, `SIGTERM`, `SIGHUP`,
and after an uncaught exception or unhandled rejection.
