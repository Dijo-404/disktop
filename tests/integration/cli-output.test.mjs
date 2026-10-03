import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
  const result = disktop(["report", "--json"]);
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

test("disktop clean lists detectors on this host and applies nothing", () => {
  const result = disktop(["clean", "--no-sizes", "--json"]);
  const envelope = envelopeFrom(result);
  validate("clean", envelope);

  assert.equal(envelope.command, "clean");
  assert.ok([0, 3].includes(result.status), `unexpected exit ${result.status}`);
  assert.equal(result.status, envelope.exitCode);
  assert.equal(envelope.data.measured, false, "--no-sizes measures nothing");
  // Every finding carries a labelled size, and an unmeasured one carries no number.
  for (const finding of envelope.data.findings) {
    assert.ok(typeof finding.size.basis === "string");
    assert.equal(finding.size.basis === "unknown", finding.size.bytes === undefined);
  }
});

test("disktop clean plan refuses a protected path without touching it", () => {
  const result = disktop(["clean", "plan", "--path", "/etc/passwd", "--json"]);
  const envelope = envelopeFrom(result);

  assert.equal(result.status, 2);
  assert.equal(envelope.error.code, "protected-path");
  assert.ok(existsSync("/etc/passwd"), "nothing was changed");
});

test("disktop clean apply refuses a plan nobody reviewed", () => {
  const result = disktop(["clean", "apply", "plan-does-not-exist", "--yes", "--json"]);
  const envelope = envelopeFrom(result);

  assert.equal(result.status, 2);
  assert.equal(envelope.error.code, "invalid-plan");
});

/**
 * Run the CLI with a stdout whose reader has already gone, as `| head -1`
 * leaves it after one line. The first write is a broken pipe.
 */
function withClosedStdout(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/bin/disktop.js", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    child.stdout.destroy();
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stderr }));
  });
}

test("a reader that leaves early gets no stack trace and no alert-reached status", async () => {
  for (const [args, statuses] of [
    [["--help"], [0]],
    [["devices"], [0, 3]],
    [["history", "--json"], [0]],
  ]) {
    const result = await withClosedStdout(args);
    assert.equal(result.signal, null, `${args.join(" ")} was killed by ${result.signal}`);
    assert.ok(statuses.includes(result.status), `${args.join(" ")} exited ${result.status}: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /EPIPE|\n\s+at |node:internal/, `${args.join(" ")} printed a trace`);
  }
});

test("a real `| head -1` pipeline ends quietly", () => {
  const result = spawnSync("sh", ["-c", "node dist/bin/disktop.js devices | head -1 >/dev/null; node dist/bin/disktop.js --help | head -1 >/dev/null"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.equal(result.stderr, "", "nothing reaches stderr when a reader stops early");
});

test("help and version answer without building any service", () => {
  // Building services places Disktop's files under the home directory and
  // refuses a relative one; help and version never get that far, so they
  // still answer where every real command would refuse to start.
  const env = { ...process.env, HOME: "relative-home", NO_COLOR: "1" };
  for (const args of [["--help"], ["--version"], ["scan", "--help"]]) {
    const result = spawnSync(process.execPath, ["dist/bin/disktop.js", ...args], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  }
  const refused = spawnSync(process.execPath, ["dist/bin/disktop.js", "devices"], { encoding: "utf8", env });
  assert.equal(refused.status, 2, "a real command still refuses, which is what makes the check above meaningful");
  assert.doesNotMatch(refused.stderr, /\n\s+at /);
});

test("an invalid argument exits 2 with the reason on stderr and nothing on stdout", () => {
  for (const args of [["devices", "--bogus"], ["wipe-everything"], ["history", "--limit"], ["devices", "--units", "furlongs"]]) {
    const result = disktop(args);
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
    assert.notEqual(result.stderr.trim(), "", args.join(" "));
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  }
  const json = disktop(["devices", "--bogus", "--json"]);
  assert.equal(json.status, 2);
  validate("error", JSON.parse(json.stdout));
});

test("disktop history reads the journal and validates against its schema", () => {
  const result = disktop(["history", "--json"]);
  const envelope = envelopeFrom(result);

  assert.equal(result.status, 0);
  validate("history", envelope);
  assert.ok(Array.isArray(envelope.data.records));
});
