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
  readonly #pending = new Map<string, PendingRequest>();
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
    if (this.#closed) {
      throw new Error(this.#exitReason ?? "The helper is no longer running.");
    }

    this.#nextRequest += 1;
    const requestId = `${operation}-${this.#nextRequest}`;

    return new Promise<HelperEvent>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject, cancelRequested: false };
      this.#pending.set(requestId, pending);

      const onAbort = (): void => {
        if (pending.cancelRequested || this.#closed) {
          return;
        }
        pending.cancelRequested = true;
        this.#write({ protocolVersion: PROTOCOL_VERSION, requestId: `cancel-${requestId}`, operation: "cancel", arguments: { cancelRequestId: requestId } });
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
    });
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
    // `progress` and `accepted` are not terminal; only a final event settles a request.
    if (event.event === "progress" || event.event === "accepted") {
      return;
    }
    this.#pending.delete(requestId);
    pending.detach?.();
    pending.resolve(event);
  }

  #fail(reason: string): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#exitReason = reason;
    for (const [, pending] of this.#pending) {
      pending.detach?.();
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
  }
}

interface PendingRequest {
  resolve(event: HelperEvent): void;
  reject(error: Error): void;
  cancelRequested: boolean;
  detach?: () => void;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
