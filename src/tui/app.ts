import type { DashboardService } from "../application/dashboard.js";
import { intentForKey } from "./keys.js";
import type { Renderer } from "./render.js";
import { initialState, reduce, type AppState } from "./state.js";
import type { Theme } from "./themes.js";
import { renderDisks } from "./views/disks.js";

export interface TuiOptions {
  readonly dashboard: DashboardService;
  readonly units: "iec" | "si";
  readonly theme: Theme;
  createRenderer(theme: Theme): Promise<Renderer>;
}

const EXIT_COMPLETE = 0;
const EXIT_INCOMPLETE = 3;
const EXIT_INTERRUPTED = 130;

/**
 * Run the dashboard until the user leaves, then restore the terminal.
 *
 * Restoration is registered before the first draw and runs on a normal exit, on
 * `SIGINT`, `SIGTERM`, and `SIGHUP`, and after an uncaught exception. A user
 * whose terminal Disktop broke would have no reason to trust it with a deletion.
 */
export async function runTui(options: TuiOptions): Promise<number> {
  const view = await options.dashboard.dashboard();
  const renderer = await options.createRenderer(options.theme);
  const restore = new TerminalRestoration(renderer);

  let state: AppState = initialState(view, options.units);
  let exitCode = view.complete ? EXIT_COMPLETE : EXIT_INCOMPLETE;

  try {
    restore.arm();
    await renderer.start();

    exitCode = await new Promise<number>((resolve) => {
      const paint = (): void => renderer.draw(renderDisks(state, renderer.size(), options.theme));

      renderer.onResize(paint);
      renderer.onKey((key) => {
        const intent = intentForKey(key);
        if (intent.kind === "quit") {
          resolve(key === "CTRL_C" ? EXIT_INTERRUPTED : exitCode);
          return;
        }
        const next = reduce(state, intent);
        if (next !== state) {
          state = next;
          paint();
        }
      });

      paint();
    });
  } finally {
    restore.disarm();
  }

  return exitCode;
}

/**
 * Owns terminal restoration for the lifetime of the TUI. `stop` is idempotent,
 * so running it twice on the way out of a signal is harmless.
 */
class TerminalRestoration {
  readonly #renderer: Renderer;
  readonly #signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  #onSignal: ((signal: NodeJS.Signals) => void) | undefined;
  #onException: ((error: unknown) => void) | undefined;
  #onExit: (() => void) | undefined;

  constructor(renderer: Renderer) {
    this.#renderer = renderer;
  }

  arm(): void {
    this.#onExit = () => this.#renderer.stop();
    this.#onSignal = (signal) => {
      this.#renderer.stop();
      this.disarm();
      process.kill(process.pid, signal);
    };
    this.#onException = (error) => {
      this.#renderer.stop();
      this.disarm();
      process.exitCode = 2;
      // The terminal is already restored, so the report is readable.
      console.error(error);
      process.exit(2);
    };

    process.on("exit", this.#onExit);
    process.on("uncaughtException", this.#onException);
    process.on("unhandledRejection", this.#onException);
    for (const signal of this.#signals) {
      process.on(signal, this.#onSignal);
    }
  }

  disarm(): void {
    this.#renderer.stop();
    if (this.#onExit !== undefined) {
      process.off("exit", this.#onExit);
    }
    if (this.#onException !== undefined) {
      process.off("uncaughtException", this.#onException);
      process.off("unhandledRejection", this.#onException);
    }
    if (this.#onSignal !== undefined) {
      for (const signal of this.#signals) {
        process.off(signal, this.#onSignal);
      }
    }
    this.#onExit = undefined;
    this.#onException = undefined;
    this.#onSignal = undefined;
  }
}
