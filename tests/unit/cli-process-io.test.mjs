import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { INTERRUPT_SIGNALS, createInterruptSource, guardStreams } from "../../dist/cli/process-io.js";

/** A stream whose write fails the way a closed pipe or a full disk does. */
function failingStream(code) {
  const stream = new EventEmitter();
  stream.destroyed = false;
  stream.written = [];
  stream.write = (chunk) => {
    if (stream.destroyed) {
      throw new Error("a destroyed stream was written to");
    }
    stream.written.push(chunk);
    if (code !== undefined) {
      stream.destroyed = true;
      const error = Object.assign(new Error(`write ${code}`), { code });
      queueMicrotask(() => stream.emit("error", error));
    }
    return true;
  };
  return stream;
}

test("a reader that went away is not an error, and nothing more is written to it", async () => {
  const stdout = failingStream("EPIPE");
  const stderr = failingStream();
  const output = guardStreams(stdout, stderr);

  output.stdout("first line\n");
  await Promise.resolve();
  output.stdout("second line\n");
  assert.deepEqual(stdout.written, ["first line\n"]);
  assert.equal(output.failure(), undefined, "a closed pipe is not reported as lost output");
  assert.equal(output.wroteStdout(), true);
});

test("any other stdout failure is remembered, so the exit status can report it", async () => {
  const output = guardStreams(failingStream("ENOSPC"), failingStream());
  output.stdout("{}\n");
  await Promise.resolve();
  assert.match(output.failure() ?? "", /ENOSPC/);
});

test("a stderr that went away does not stop the command", async () => {
  const stderr = failingStream("EPIPE");
  const output = guardStreams(failingStream(), stderr);
  output.stderr("warning one\n");
  await Promise.resolve();
  output.stderr("warning two\n");
  assert.deepEqual(stderr.written, ["warning one\n"]);
});

test("Ctrl+C reaches a command once, a second one only says so, and stopping removes every listener", () => {
  const emitter = new EventEmitter();
  const notes = [];
  const source = createInterruptSource(emitter, (message) => notes.push(message));
  let stops = 0;
  const handler = () => {
    stops += 1;
  };

  source.listen(handler);
  for (const signal of INTERRUPT_SIGNALS) {
    assert.equal(emitter.listenerCount(signal), 1, `${signal} is listened to while the command runs`);
  }
  emitter.emit("SIGINT");
  emitter.emit("SIGINT");
  emitter.emit("SIGTERM");
  assert.equal(stops, 1, "the command is asked to stop once");
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Still stopping/);

  source.stop(handler);
  for (const signal of INTERRUPT_SIGNALS) {
    assert.equal(emitter.listenerCount(signal), 0, `${signal} has no listener left behind`);
  }
});
