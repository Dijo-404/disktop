import assert from "node:assert/strict";
import { test } from "node:test";
import { handshakeRequest, parseHandshakeResponse, PROTOCOL_VERSION } from "../../dist/native/protocol.js";

test("handshake request is versioned and rejects unsafe IDs", () => {
  assert.deepEqual(handshakeRequest("hello-1"), {
    protocolVersion: PROTOCOL_VERSION,
    requestId: "hello-1",
    operation: "hello",
    arguments: {},
  });
  for (const invalid of ["", "with space", "../../other", "a".repeat(129)]) {
    assert.throws(() => handshakeRequest(invalid), RangeError);
  }
});

test("handshake decoder rejects a mismatched response", () => {
  const valid = {
    protocolVersion: 1,
    requestId: "hello-1",
    eventId: "1",
    event: "complete",
    result: {
      helperVersion: "0.0.0",
      buildChecksum: null,
      platform: "linux",
      architecture: "x86_64",
      kernelCapabilities: { openat2: { available: true, reason: null } },
      supportedOperations: ["hello", "probe"],
    },
  };
  assert.deepEqual(parseHandshakeResponse(JSON.stringify(valid), "hello-1"), valid.result);
  assert.throws(() => parseHandshakeResponse(JSON.stringify(valid), "different"));
  assert.throws(() => parseHandshakeResponse(JSON.stringify({ ...valid, protocolVersion: 2 }), "hello-1"));
  assert.throws(() => parseHandshakeResponse(JSON.stringify({ ...valid, result: { ...valid.result, supportedOperations: ["hello", 7] } }), "hello-1"));
});
