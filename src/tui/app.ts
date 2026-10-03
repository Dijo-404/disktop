import { TuiController } from "./controller.js";
import type { Renderer } from "./render.js";
import { renderScreen } from "./screen.js";
import type { TuiServices } from "./services.js";
import { initialState } from "./state.js";
import type { Theme } from "./themes.js";

export interface TuiOptions {
  readonly services: TuiServices;
  readonly units: "iec" | "si";
  readonly theme: Theme;
  readonly threshold?: number;
  createRenderer(theme: Theme): Promise<Renderer>;
}

/** Frames are coalesced: a burst of progress draws at most this often. */
const FRAME_MILLISECONDS = 33;
const SPINNER_MILLISECONDS = 120;

/**
 * Run the TUI until the user leaves, then restore the terminal.
 *
 * Restoration is registered before the first draw and runs on a normal exit, on
 * `SIGINT`, `SIGTERM`, and `SIGHUP`, and after an uncaught exception. A user
 * whose terminal Disktop broke would have no reason to trust it with a deletion.
 * Leaving waits for running work to stop properly: a scan writes what it read,
 * and an action finishes and journals its current item.
 */
export async function runTui(options: TuiOptions): Promise<number> {
  const services = options.services;
  const view = await services.dashboard.inventory();
  const renderer = await options.createRenderer(options.theme);
  const restore = new TerminalRestoration(renderer);
  const home = services.home.display;

  let paintTimer: NodeJS.Timeout | undefined;
  // True while the terminal is lent to a sudo or pkexec password prompt.
  let suspended = false;
  let spinner: NodeJS.Timeout | undefined;
  let resolveExit: ((code: number) => void) | undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const paint = (): void => {
    paintTimer = undefined;
    const frame = renderScreen(controller.state, renderer.size(), {
      theme: options.theme,
      now: services.now().getTime(),
      threshold: options.threshold ?? 90,
      home,
    });
    controller.setHits(frame.hits);
    renderer.draw(frame);
    syncSpinner();
  };
  const schedule = (): void => {
    if (paintTimer === undefined) {
      paintTimer = setTimeout(paint, FRAME_MILLISECONDS);
    }
  };
  // The spinner turns only while something is running, so an idle TUI wakes
  // nobody and draws nothing.
  const syncSpinner = (): void => {
    const turning = controller.active || controller.state.explore.loading;
    if (turning && spinner === undefined) {
      spinner = setInterval(() => controller.tick(), SPINNER_MILLISECONDS);
    } else if (!turning && spinner !== undefined) {
      clearInterval(spinner);
      spinner = undefined;
    }
  };

  const controller: TuiController = new TuiController(services, initialState(view, options.units, services.defaults.staleAfterDays), {
    changed: schedule,
    pageRows: () => Math.max(1, renderer.size().rows - 8),
    suspend: (message) => {
      suspended = true;
      renderer.suspend(message);
    },
    resume: () => {
      suspended = false;
      renderer.resume();
      schedule();
    },
    exit: (code) => resolveExit?.(code),
  });

  let exitCode: number;
  try {
    restore.arm({
      lentToPrompt: () => suspended,
      acting: () => controller.acting,
      cancelActions: () => controller.cancelActions(),
      shutdown: (graceMilliseconds) => controller.shutdown(graceMilliseconds),
    });
    await renderer.start();
    renderer.onResize(() => {
      if (paintTimer !== undefined) {
        clearTimeout(paintTimer);
        paintTimer = undefined;
      }
      paint();
    });
    renderer.onKey((key) => controller.handleKey(key));
    renderer.onMouse((event) => controller.handleMouse(event));
    paint();
    controller.start();
    exitCode = await exited;
    await controller.shutdown();
  } finally {
    if (paintTimer !== undefined) {
      clearTimeout(paintTimer);
    }
    if (spinner !== undefined) {
      clearInterval(spinner);
    }
    restore.disarm();
  }
  return exitCode;
}

/** What the signal handler needs to know about the work in progress. */
interface SignalPolicy {
  /** True while the terminal is lent to a password prompt. */
  lentToPrompt(): boolean;
  /** True while an action that changes the disk is running. */
  acting(): boolean;
  /** Ask running actions to stop after their current item. */
  cancelActions(): void;
  /** Stop everything; actions are waited for in full, reads for the grace. */
  shutdown(graceMilliseconds: number): Promise<void>;
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

  /**
   * `drain` asks running work to stop. A signal gets the terminal back first —
   * at once — and then up to a second for a scan or an action to record where
   * it stopped before the signal is delivered again with its default action.
   */
  arm(policy: SignalPolicy): void {
    this.#onExit = () => this.#renderer.stop();
    this.#onSignal = (signal) => {
      // While a password prompt has the terminal it is in cooked mode, so a
      // Ctrl+C there is a real SIGINT. It means "not this", about the action
      // asking for the password: that action is stopped and the TUI carries on.
      if (signal === "SIGINT" && policy.lentToPrompt()) {
        policy.cancelActions();
        return;
      }
      this.#renderer.stop();
      this.disarm();
      if (policy.acting()) {
        // An action is never abandoned on a timer: it is asked to stop after
        // its current item and waited for, however long that item takes. The
        // handlers are disarmed, so a second signal takes its default course
        // for somebody who insists.
        process.stderr.write(`Disktop received ${signal}: stopping after the current item so it is journalled. Send ${signal} again to stop at once.\n`);
        void policy.shutdown(1_000).finally(() => process.kill(process.pid, signal));
        return;
      }
      // Nothing that changes the disk is running: a scan gets up to three
      // seconds to record what it read, and then the signal takes its course.
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 3_000);
      });
      void Promise.race([policy.shutdown(1_000), limit]).finally(() => {
        clearTimeout(timer);
        process.kill(process.pid, signal);
      });
    };
    this.#onException = (error) => {
      this.#renderer.stop();
      this.disarm();
      process.exitCode = 2;
      // The terminal is already restored, so the report is readable.
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Disktop stopped unexpectedly: ${message}\n`);
      process.exit(2);
    };

    process.on("exit", this.#onExit);
    // Prepended, so the terminal is restored before any other handler writes
    // a report that would otherwise land on the alternate screen and vanish.
    process.prependListener("uncaughtException", this.#onException);
    process.prependListener("unhandledRejection", this.#onException);
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
