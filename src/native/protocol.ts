/** Current scaffold request shape. Future operations need versioned schemas. */
export const PROTOCOL_VERSION = 1;

export interface NativeRequest {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly requestId: string;
  readonly operation: "hello" | "probe";
  readonly arguments: Readonly<Record<string, never>>;
}

export interface NativeCapabilityProbe {
  readonly available: boolean;
  readonly reason: string | null;
}

export interface NativeHelloResult {
  readonly helperVersion: string;
  readonly buildChecksum: string | null;
  readonly platform: string;
  readonly architecture: string;
  readonly kernelCapabilities: { readonly openat2: NativeCapabilityProbe };
  readonly supportedOperations: readonly string[];
}

export type NativeResponse =
  | {
      readonly protocolVersion: number;
      readonly requestId: string;
      readonly eventId: string;
      readonly event: "complete";
      readonly result: NativeHelloResult;
    }
  | {
      readonly protocolVersion: number;
      readonly requestId: string | null;
      readonly eventId: string;
      readonly event: "error";
      readonly error: { readonly code: string; readonly message: string };
    };

export function handshakeRequest(requestId: string): NativeRequest {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(requestId)) {
    throw new RangeError("Invalid native request ID");
  }
  return { protocolVersion: PROTOCOL_VERSION, requestId, operation: "hello", arguments: {} };
}

/** A narrow decoder for the implemented handshake, not the eventual scan protocol. */
export function parseHandshakeResponse(line: string, expectedRequestId: string): NativeHelloResult {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION || value.requestId !== expectedRequestId || typeof value.eventId !== "string" || value.event !== "complete" || !isRecord(value.result)) {
    throw new Error("Invalid native handshake response");
  }
  const result = value.result;
  if (
    typeof result.helperVersion !== "string" ||
    !(result.buildChecksum === null || typeof result.buildChecksum === "string") ||
    typeof result.platform !== "string" ||
    typeof result.architecture !== "string" ||
    !isRecord(result.kernelCapabilities) ||
    !isRecord(result.kernelCapabilities.openat2) ||
    typeof result.kernelCapabilities.openat2.available !== "boolean" ||
    !(result.kernelCapabilities.openat2.reason === null || typeof result.kernelCapabilities.openat2.reason === "string") ||
    !Array.isArray(result.supportedOperations) ||
    !result.supportedOperations.every((operation: unknown) => typeof operation === "string")
  ) {
    throw new Error("Invalid native helper capabilities");
  }
  return result as unknown as NativeHelloResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
