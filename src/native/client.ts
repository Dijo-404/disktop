import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Capability } from "../domain/models.js";
import { PROTOCOL_VERSION, parseHandshakeResponse, type NativeHelloResult } from "./protocol.js";
import { helperTarget, locateHelper, type HelperLocation } from "./locator.js";

const STDERR_KEEP_BYTES = 8 * 1024;
const SHUTDOWN_GRACE_MILLISECONDS = 2_000;

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
 */
export class NativeHelperClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, EventStream>();
  #stdoutBuffer = "";
  #stderrTail = "";
  #nextRequest = 0;
  #closed = false;
  #exitReason: string | undefined;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => this.#absorbStdout(chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      this.#stderrTail = (this.#stderrTail + chunk).slice(-STDERR_KEEP_BYTES);
    });
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

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(lookup.location.executablePath, [], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    } catch (error) {
      return {
        started: false,
        capability: { status: "permission-denied", explanation: `The helper could not be started: ${describe(error)}` },
      };
    }

    const client = new NativeHelperClient(child);
    try {
      const response = await client.request("hello", {});
      const hello = parseHandshakeResponse(JSON.stringify(response), response.requestId ?? "");
      return { started: true, client, hello, location: lookup.location };
    } catch (error) {
      await client.close();
      return {
        started: false,
        capability: { status: "unsupported-kernel", explanation: `The helper did not complete the protocol handshake: ${describe(error)}` },
      };
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

    try {
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

  /** End the protocol stream, then wait for the process to exit before giving up on it. */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#child.stdin.end();

    await new Promise<void>((resolve) => {
      if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.#child.kill("SIGKILL");
        resolve();
      }, SHUTDOWN_GRACE_MILLISECONDS);
      timer.unref();
      this.#child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.#fail("The helper was closed.");
  }

  #write(request: Readonly<Record<string, unknown>>): void {
    this.#child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  #absorbStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    let newline = this.#stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#stdoutBuffer.slice(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (line.trim() !== "") {
        this.#deliver(line);
      }
      newline = this.#stdoutBuffer.indexOf("\n");
    }
  }

  #deliver(line: string): void {
    let event: HelperEvent;
    try {
      event = JSON.parse(line) as HelperEvent;
    } catch {
      this.#stderrTail = (`${this.#stderrTail}\nunparsable helper output: ${line}`).slice(-STDERR_KEEP_BYTES);
      return;
    }

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
