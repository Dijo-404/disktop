import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Capability } from "../domain/models.js";
import { PROTOCOL_VERSION, parseHandshakeResponse, type NativeHelloResult } from "./protocol.js";
import { helperTarget, locateHelper, type HelperLocation } from "./locator.js";

const STDERR_KEEP_BYTES = 8 * 1024;

/**
 * How far the client trusts the process on the other end of the pipe.
 *
 * Every bound here exists because the helper is a separate program that can
 * crash, hang, or misbehave, and Node has to stay in control when it does.
 */
export interface ClientLimits {
  /**
   * The longest line the helper may write. A line is held in memory until its
   * newline arrives, so without a bound a helper that never ends one grows
   * Node until it dies; V8 also cannot hold a string much past 512 MiB, so a
   * larger line would fail in a far less legible way than this refusal.
   */
  readonly maxLineCharacters: number;
  /** How long `hello` may take before the helper is treated as unusable. */
  readonly handshakeMilliseconds: number;
  /** How long a helper has to exit after its input closes, before it is killed. */
  readonly shutdownGraceMilliseconds: number;
}

export const DEFAULT_CLIENT_LIMITS: ClientLimits = {
  maxLineCharacters: 256 * 1024 * 1024,
  handshakeMilliseconds: 10_000,
  shutdownGraceMilliseconds: 2_000,
};

export interface HelperEvent {
  readonly protocolVersion: number;
  readonly requestId: string | null;
  readonly eventId: string;
  readonly event: string;
  readonly [field: string]: unknown;
}

export interface HelperFailure {
  readonly code: string;
  readonly message: string;
}

export type HelperStart =
  | { readonly started: true; readonly client: NativeHelperClient; readonly hello: NativeHelloResult; readonly location: HelperLocation }
  | { readonly started: false; readonly capability: Capability };

/**
 * A typed channel to one `disktop-fs` child process.
 *
 * The helper is spawned with a fixed argument vector and no shell. Its stdout
 * carries protocol messages only; stderr is diagnostics and is kept bounded.
 * Every response is matched to its request by ID, so an out-of-order or
 * unsolicited message can never be mistaken for the answer to something else.
 *
 * Whatever the helper does — exits, stops reading, writes garbage or a line
 * with no end — every pending request fails with a reason and the process is
 * reaped by `close()`. None of it may surface as an unhandled error in Node,
 * because that would end the CLI between a journalled intent and its outcome.
 */
export class NativeHelperClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #limits: ClientLimits;
  readonly #pending = new Map<string, EventStream>();
  readonly #exited: Promise<void>;
  /** Pieces of the line still waiting for its newline. */
  #partial: string[] = [];
  #partialLength = 0;
  #stderrTail = "";
  #nextRequest = 0;
  #closed = false;
  #hasExited = false;
  #exitReason: string | undefined;

  private constructor(child: ChildProcessWithoutNullStreams, limits: ClientLimits) {
    this.#child = child;
    this.#limits = limits;
    this.#exited = new Promise((resolve) => {
      const exited = (): void => {
        this.#hasExited = true;
        resolve();
      };
      child.once("close", exited);
      // A process that never started has nothing to wait for.
      child.once("error", () => {
        if (child.pid === undefined) {
          exited();
        }
      });
    });

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => this.#absorbStdout(chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      this.#stderrTail = (this.#stderrTail + chunk).slice(-STDERR_KEEP_BYTES);
    });
    // A helper that dies or stops reading turns the next write into EPIPE.
    // Without a listener that is an uncaught exception in Node, so every
    // stream reports to the requests waiting on it instead.
    child.stdin.on("error", (error) => this.#abandon(`The helper stopped reading requests: ${error.message}`));
    child.stdout.on("error", (error) => this.#abandon(`The helper's output could not be read: ${error.message}`));
    child.stderr.on("error", () => undefined);
    child.on("error", (error) => this.#fail(`The helper process failed: ${error.message}`));
    child.on("close", (code, signal) => {
      this.#fail(signal === null ? `The helper exited with status ${code ?? "unknown"}.` : `The helper was terminated by ${signal}.`);
    });
  }

  /** Spawn the helper and complete the version handshake, or explain why not. */
  static async start(): Promise<HelperStart> {
    const lookup = await locateHelper(helperTarget());
    if (!lookup.found) {
      return { started: false, capability: lookup.capability };
    }
    return NativeHelperClient.launch(lookup.location);
  }

  /**
   * Spawn an already located helper and complete the handshake.
   *
   * `start()` is the only production caller; this is separate so a test can
   * put a misbehaving program on the other end of the pipe and prove the
   * client survives it.
   */
  static async launch(location: HelperLocation, limits: Partial<ClientLimits> = {}): Promise<HelperStart> {
    const bounds = { ...DEFAULT_CLIENT_LIMITS, ...limits };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(location.executablePath, [], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    } catch (error) {
      return {
        started: false,
        capability: { status: "permission-denied", explanation: `The helper could not be started: ${describe(error)}` },
      };
    }

    const client = new NativeHelperClient(child, bounds);
    // A helper that never answers `hello` would otherwise hold the CLI forever
    // before it had done anything at all.
    const timer = setTimeout(() => {
      client.#abandon(`The helper did not answer within ${bounds.handshakeMilliseconds} ms.`);
    }, bounds.handshakeMilliseconds);
    try {
      const response = await client.request("hello", {});
      const hello = parseHandshakeResponse(JSON.stringify(response), response.requestId ?? "");
      return { started: true, client, hello, location };
    } catch (error) {
      await client.close();
      return {
        started: false,
        capability: { status: "unsupported-kernel", explanation: `The helper did not complete the protocol handshake: ${describe(error)}` },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Send one request and resolve with its terminal event.
   *
   * Aborting asks the helper to cancel by request ID and waits for it to answer,
   * so an interrupted operation still reports what it completed and what it did
   * not. It does not abandon an in-flight operation with no result.
   */
  async request(operation: string, operationArguments: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<HelperEvent> {
    let terminal: HelperEvent | undefined;
    for await (const event of this.stream(operation, operationArguments, signal)) {
      terminal = event;
    }
    if (terminal === undefined) {
      throw new Error(this.#exitReason ?? "The helper closed without answering.");
    }
    return terminal;
  }

  /**
   * Send one request and yield every event it produces, ending with the
   * terminal one.
   *
   * A long operation reports progress while it runs, and the caller stays in
   * control of what to do with it. The stream always ends on a `complete` or
   * `error` event: a helper that goes away mid-operation raises rather than
   * finishing quietly, because a missing final event is never success.
   */
  async *stream(
    operation: string,
    operationArguments: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): AsyncGenerator<HelperEvent> {
    if (this.#closed) {
      throw new Error(this.#exitReason ?? "The helper is no longer running.");
    }

    this.#nextRequest += 1;
    const requestId = `${operation}-${this.#nextRequest}`;
    const pending = new EventStream();
    this.#pending.set(requestId, pending);

    try {
      const onAbort = (): void => {
        if (pending.cancelRequested || this.#closed) {
          return;
        }
        pending.cancelRequested = true;
        this.#write({
          protocolVersion: PROTOCOL_VERSION,
          requestId: `cancel-${requestId}`,
          operation: "cancel",
          arguments: { cancelRequestId: requestId },
        });
      };

      if (signal !== undefined) {
        if (signal.aborted) {
          queueMicrotask(onAbort);
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
          pending.detach = () => signal.removeEventListener("abort", onAbort);
        }
      }

      this.#write({ protocolVersion: PROTOCOL_VERSION, requestId, operation, arguments: operationArguments });
      yield* pending.events();
    } finally {
      pending.detach?.();
      this.#pending.delete(requestId);
    }
  }

  /** The last diagnostics the helper wrote, for a capability explanation. */
  diagnostics(): string {
    return this.#stderrTail.trim();
  }

  /**
   * End the protocol stream and wait for the process to exit.
   *
   * Closing stdin is how the helper learns its client has gone; it finishes
   * what it is doing and exits. One that does not within the grace period is
   * killed, and this still waits for the kill to land, so a caller that has
   * closed a client never leaves a live helper behind it.
   */
  async close(): Promise<void> {
    if (!this.#hasExited) {
      if (!this.#child.stdin.destroyed) {
        this.#child.stdin.end();
      }
      if (!(await this.#exitWithin(this.#limits.shutdownGraceMilliseconds))) {
        this.#child.kill("SIGKILL");
        // SIGKILL cannot be ignored. A process stuck in uninterruptible I/O
        // only takes it when the I/O returns, and waiting for that forever
        // would hang the CLI on a kernel problem, so the wait is bounded too.
        await this.#exitWithin(this.#limits.shutdownGraceMilliseconds);
      }
    }
    this.#fail("The helper was closed.");
  }

  async #exitWithin(milliseconds: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), milliseconds);
    });
    try {
      return await Promise.race([this.#exited.then(() => true as const), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  #write(request: Readonly<Record<string, unknown>>): void {
    const stdin = this.#child.stdin;
    if (stdin.destroyed || stdin.writableEnded) {
      this.#abandon("The helper is no longer reading requests.");
      return;
    }
    stdin.write(`${JSON.stringify(request)}\n`);
  }

  /**
   * Split stdout into lines, looking only at the newly arrived text.
   *
   * Searching the whole accumulated buffer on every chunk would make a large
   * response quadratic in its own length; holding the pieces and joining them
   * once the newline arrives keeps it linear.
   */
  #absorbStdout(chunk: string): void {
    let start = 0;
    let newline = chunk.indexOf("\n");
    while (newline >= 0) {
      const tail = chunk.slice(start, newline);
      if (this.#partialLength + tail.length > this.#limits.maxLineCharacters) {
        this.#lineTooLong();
        return;
      }
      const line = this.#partial.length === 0 ? tail : this.#partial.join("") + tail;
      this.#partial = [];
      this.#partialLength = 0;
      if (line.trim() !== "") {
        this.#deliver(line);
      }
      start = newline + 1;
      newline = chunk.indexOf("\n", start);
    }

    if (start < chunk.length) {
      const rest = chunk.slice(start);
      this.#partialLength += rest.length;
      if (this.#partialLength > this.#limits.maxLineCharacters) {
        this.#lineTooLong();
        return;
      }
      this.#partial.push(rest);
    }
  }

  #lineTooLong(): void {
    this.#partial = [];
    this.#partialLength = 0;
    this.#abandon(`The helper wrote a line longer than ${this.#limits.maxLineCharacters} characters, so its output can no longer be trusted.`);
  }

  #deliver(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#noteUnparsable(line);
      return;
    }
    // A line that parses but is not an event object is noise from the helper's
    // side, never something to index into.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.#noteUnparsable(line);
      return;
    }
    const event = parsed as HelperEvent;

    const requestId = typeof event.requestId === "string" ? event.requestId : undefined;
    if (requestId === undefined) {
      return;
    }
    const pending = this.#pending.get(requestId);
    if (pending === undefined) {
      return;
    }
    pending.push(event);
    // `accepted` and `progress` are not terminal; only a final event ends the stream.
    if (event.event === "complete" || event.event === "error") {
      pending.end();
    }
  }

  #noteUnparsable(line: string): void {
    this.#stderrTail = `${this.#stderrTail}\nunparsable helper output: ${line.slice(0, 256)}`.slice(-STDERR_KEEP_BYTES);
  }

  /**
   * Stop trusting the helper: fail everything waiting on it and kill it.
   *
   * Used when the pipe itself is broken or out of step, where waiting for the
   * helper to finish on its own could wait forever. `close()` still reaps it.
   */
  #abandon(reason: string): void {
    this.#fail(reason);
    if (!this.#hasExited) {
      this.#child.kill("SIGKILL");
    }
  }

  #fail(reason: string): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#exitReason = reason;
    for (const [, pending] of this.#pending) {
      pending.detach?.();
      pending.fail(new Error(reason));
    }
    this.#pending.clear();
  }
}

/**
 * A queue of one request's events with at most one reader.
 *
 * Events arrive on the stdout handler and are consumed by whoever is iterating
 * the request. Buffering them here is what keeps a burst of progress events
 * from being dropped while the consumer is busy.
 */
class EventStream {
  readonly #queue: HelperEvent[] = [];
  #waiting: { resolve: (result: IteratorResult<HelperEvent>) => void; reject: (error: Error) => void } | undefined;
  #ended = false;
  #failure: Error | undefined;
  cancelRequested = false;
  detach?: () => void;

  push(event: HelperEvent): void {
    const waiting = this.#waiting;
    if (waiting !== undefined) {
      this.#waiting = undefined;
      waiting.resolve({ value: event, done: false });
      return;
    }
    this.#queue.push(event);
  }

  end(): void {
    this.#ended = true;
    const waiting = this.#waiting;
    if (waiting !== undefined) {
      this.#waiting = undefined;
      waiting.resolve({ value: undefined, done: true });
    }
  }

  fail(error: Error): void {
    this.#failure = error;
    const waiting = this.#waiting;
    if (waiting !== undefined) {
      this.#waiting = undefined;
      waiting.reject(error);
    }
  }

  async *events(): AsyncGenerator<HelperEvent> {
    for (;;) {
      const next = this.#queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#failure !== undefined) {
        throw this.#failure;
      }
      if (this.#ended) {
        return;
      }
      const event = await new Promise<IteratorResult<HelperEvent>>((resolve, reject) => {
        this.#waiting = { resolve, reject };
      });
      if (event.done === true) {
        return;
      }
      yield event.value;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
