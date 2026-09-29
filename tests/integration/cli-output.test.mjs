import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { compileBundle } from "../support/schemas.mjs";

const validators = compileBundle("schemas/cli/v1");

/** Run the built executable exactly as a script would, with no terminal attached. */
function disktop(args) {
  const result = spawnSync(process.execPath, ["dist/bin/disktop.js", ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.equal(result.error, undefined);
  return result;
}

function envelopeFrom(result) {
  assert.notEqual(result.stdout.trim(), "", `no stdout; stderr was: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function validate(schema, document) {
  const check = validators.get(schema);
  assert.ok(check, `${schema} has no schema`);
  assert.ok(check(document), `${schema}: ${JSON.stringify(check.errors)}`);
}

test("disktop --json describes this machine and validates against the dashboard schema", () => {
  const result = disktop(["--json"]);
  const envelope = envelopeFrom(result);
  validate("dashboard", envelope);

  assert.equal(envelope.command, "dashboard");
  assert.ok([0, 3].includes(result.status), `unexpected exit ${result.status}`);
  assert.equal(result.status, envelope.exitCode);
  assert.ok(Array.isArray(envelope.data.filesystems));
  // The host this runs on has at least a root filesystem.
  assert.ok(envelope.data.filesystems.length > 0, "no filesystem was reported on a running Linux host");
});

test("disktop devices --json validates and counts each physical disk once", () => {
  const result = disktop(["devices", "--json"]);
  const envelope = envelopeFrom(result);
  validate("devices", envelope);

  const ids = envelope.data.devices.map((device) => device.id);
  assert.equal(new Set(ids).size, ids.length, "a device was reported more than once");
  for (const device of envelope.data.devices) {
    assert.match(device.sizeBytes, /^(0|[1-9][0-9]*)$/, "a byte count must be an exact decimal string");
    assert.ok(["ssd", "hdd", "unknown"].includes(device.kind));
  }
});

test("every filesystem reports a mount point as bytes as well as display text", () => {
  const envelope = envelopeFrom(disktop(["devices", "--json"]));
  for (const filesystem of envelope.data.filesystems) {
    assert.ok(filesystem.mounts.length > 0);
    for (const mount of filesystem.mounts) {
      const decoded = Buffer.from(mount.bytesBase64, "base64").toString("binary");
      assert.ok(decoded.startsWith("/"), `mount point is not absolute: ${mount.display}`);
      assert.doesNotMatch(mount.display, /[\u0000-\u001F\u007F-\u009F]/);
    }
  }
});

test("a filesystem is never listed twice under one identity", () => {
  const envelope = envelopeFrom(disktop(["devices", "--json"]));
  const ids = envelope.data.filesystems.map((filesystem) => filesystem.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("alerts check validates and reports 0, 1, or 3 and nothing else", () => {
  const result = disktop(["alerts", "check", "--threshold", "90", "--json"]);
  const envelope = envelopeFrom(result);
  validate("alerts", envelope);
  assert.ok([0, 1, 3].includes(result.status), `unexpected exit ${result.status}`);
  assert.equal(result.status, envelope.exitCode);

  // A threshold of 0 is reached by any filesystem that holds anything at all.
  const certain = disktop(["alerts", "check", "--threshold", "0", "--json"]);
  const certainEnvelope = envelopeFrom(certain);
  validate("alerts", certainEnvelope);
  if (certainEnvelope.status === "complete") {
    assert.equal(certain.status, 1);
    assert.ok(certainEnvelope.data.alerts.length > 0);
  }
});

test("an unbuilt command still emits a schema-valid error envelope on stdout", () => {
  const result = disktop(["scan", "--json"]);
  const envelope = envelopeFrom(result);
  validate("error", envelope);
  assert.equal(result.status, 2);
  assert.equal(envelope.error.code, "not-implemented");
});

test("structured output goes to stdout and diagnostics stay on stderr", () => {
  const result = disktop(["--json"]);
  assert.doesNotThrow(() => JSON.parse(result.stdout), "stdout must hold only the envelope");
  if (JSON.parse(result.stdout).status === "incomplete") {
    assert.ok(JSON.parse(result.stdout).warnings.length > 0);
  }
});

test("text output stays usable when stdout is a pipe rather than a terminal", () => {
  const result = disktop([]);
  assert.ok([0, 3].includes(result.status));
  assert.match(result.stdout, /Mount\s+Type/);
});
