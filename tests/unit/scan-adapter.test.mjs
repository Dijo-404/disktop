/**
 * The scan and index adapter against a scripted helper client: what it sends
 * for each query shape, and what a helper refusal becomes on the Node side.
 */
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { StaleScanIndex } from "../../dist/domain/errors.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";
import { createNativeScanner } from "../../dist/platform/linux/scan/index.js";

/** A helper client that answers every request with `answer(operation, arguments)`. */
function scripted(answer) {
  const sent = [];
  const client = {
    async request(operation, operationArguments) {
      sent.push({ operation, arguments: operationArguments });
      return answer(operation, operationArguments);
    },
    async *stream(operation, operationArguments) {
      sent.push({ operation, arguments: operationArguments });
      yield answer(operation, operationArguments);
    },
    diagnostics() {
      return "";
    },
    async close() {},
  };
  const scanner = createNativeScanner({
    indexDirectory: "/home/example/.cache/disktop",
    start: async () => ({ started: true, client }),
  });
  return { scanner, sent };
}

const PRUNED = {
  protocolVersion: 1,
  requestId: "query-index-1",
  eventId: "1",
  event: "error",
  error: {
    code: "unknown-request",
    message: "That scan is not in the index. It may have been pruned; run a new scan.",
  },
};

function query(filter = {}) {
  return { scanId: "scan-1790000000-0123456789abcdef", filter, sort: "allocated", order: "descending", limit: 50 };
}

test("cancelling an index page closes its dedicated read-only helper once and removes its listeners", async () => {
  const controller = new AbortController();
  let closes = 0;
  let rejectRequest;
  let submitted;
  const ready = new Promise((resolve) => { submitted = resolve; });
  const scanner = createNativeScanner({
    indexDirectory: "/home/example/.cache/disktop",
    start: async () => ({ started: true, client: {
      request(_operation, _arguments, signal) {
        assert.equal(signal, controller.signal);
        submitted();
        return new Promise((_, reject) => { rejectRequest = reject; });
      },
      async close() { closes += 1; rejectRequest?.(new Error("query helper closed")); },
      diagnostics() { return ""; },
    } }),
  });
  const request = scanner.query(query(), controller.signal);
  const rejected = assert.rejects(request, { name: "AbortError" });
  await ready;
  controller.abort();
  await rejected;
  assert.equal(closes, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await assert.rejects(scanner.query(query(), controller.signal), { name: "AbortError" });
  assert.equal(closes, 1);
});

test("a page of a scan the index has pruned is a stale index, not a failure", async () => {
  const { scanner } = scripted(() => PRUNED);

  await assert.rejects(scanner.query(query()), (error) => {
    assert.ok(error instanceof StaleScanIndex, `a ${error.constructor.name} reached the caller`);
    assert.equal(error.scanId, "scan-1790000000-0123456789abcdef");
    return true;
  });
});

test("a duplicate search of a pruned scan is a stale index too", async () => {
  const { scanner } = scripted(() => PRUNED);

  await assert.rejects(
    scanner.groups(
      { scanId: "scan-1790000000-0123456789abcdef", underPath: rawPathFromUtf8("/home/example"), minimumBytes: 1n },
      new AbortController().signal,
    ),
    StaleScanIndex,
  );
});

test("the row at a path is asked for by its bytes, never by display text", async () => {
  const at = rawPathFromUtf8("/home/example/projects");
  const { scanner, sent } = scripted(() => ({
    protocolVersion: 1,
    requestId: "query-index-1",
    eventId: "1",
    event: "complete",
    result: { scanId: "scan-1790000000-0123456789abcdef", entries: [] },
  }));

  await scanner.query(query({ atPath: at }));

  assert.equal(sent[0].operation, "query-index");
  assert.deepEqual(sent[0].arguments.filter, { atPath: at.bytesBase64 });
});
