import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rawPathFromBytes, rawPathFromUtf8 } from "../../dist/domain/paths.js";
import { createElevatedDu, duArguments, elevationFor, parseDuOutput } from "../../dist/platform/linux/elevated.js";

const signal = () => new AbortController().signal;

test("at a desktop pkexec asks through the session's dialog; at a terminal sudo asks; with nobody there only cached sudo is tried", () => {
  const tools = { sudo: "/usr/bin/sudo", pkexec: "/usr/bin/pkexec" };
  assert.deepEqual(elevationFor({ euid: 1000, interactive: true, graphical: true, ...tools }), { kind: "pkexec", argv: ["/usr/bin/pkexec"] });
  assert.deepEqual(elevationFor({ euid: 1000, interactive: true, graphical: false, ...tools }), { kind: "sudo", argv: ["/usr/bin/sudo", "--"] });
  assert.deepEqual(elevationFor({ euid: 1000, interactive: false, graphical: true, ...tools }), { kind: "sudo", argv: ["/usr/bin/sudo", "-n", "--"] });
  assert.deepEqual(elevationFor({ euid: 0, interactive: true, graphical: true, ...tools }), { kind: "none", argv: [] });
  assert.ok("refusal" in elevationFor({ euid: 1000, interactive: false, graphical: true, pkexec: "/usr/bin/pkexec" }));
  assert.ok("refusal" in elevationFor({ euid: 1000, interactive: true, graphical: true }));
});

test("du is given fixed flags and the paths after --, never anything it could read as an option", () => {
  assert.deepEqual(duArguments("allocated", ["/var/lib/docker"]), ["-x", "-a", "-0", "-d", "1", "-B1", "--", "/var/lib/docker"]);
  assert.deepEqual(duArguments("apparent", ["/root"]), ["-x", "-a", "-0", "-d", "1", "-b", "--", "/root"]);
});

test("du's records are read as bytes, and a record a cut left without its terminator is dropped", () => {
  const output = Buffer.concat([
    Buffer.from("4096\t/root/a\x00"),
    Buffer.from("8192\t/root\x00"),
    Buffer.from([0x31, 0x32, 0x09, 0x2f, 0x78, 0xff, 0x00]),
    Buffer.from("999\t/root/cut"),
  ]);
  const records = parseDuOutput(output);
  assert.deepEqual(records.map((record) => record.bytes), [4096n, 8192n, 12n]);
  assert.deepEqual([...records[2].path], [0x2f, 0x78, 0xff], "a name that is not UTF-8 keeps its bytes");
});

function fakeSpawn(result, seen) {
  return async (program, argv, options) => {
    seen.push({ program, argv, options });
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "", truncated: false, ...result };
  };
}

const resolveAll = async (name) => `/usr/bin/${name}`;

test("each directory comes back with its own total and what is directly inside it, largest first", async () => {
  const seen = [];
  const port = createElevatedDu({
    euid: 1000,
    environment: { WAYLAND_DISPLAY: "wayland-0" },
    resolve: resolveAll,
    spawn: fakeSpawn({ stdout: Buffer.from("100\t/root/small\x00900\t/root/big\x00" + "1004\t/root\x00" + "5\t/etc/ssl/private\x00") }, seen),
  });
  const reading = await port.measure([rawPathFromUtf8("/root"), rawPathFromUtf8("/etc/ssl/private")], "allocated", { interactive: true, signal: signal() });

  assert.equal(seen[0].program, "/usr/bin/pkexec");
  assert.deepEqual(seen[0].argv, ["/usr/bin/du", "-x", "-a", "-0", "-d", "1", "-B1", "--", "/root", "/etc/ssl/private"]);
  assert.equal(seen[0].options.env.WAYLAND_DISPLAY, "wayland-0", "pkexec can find the session's dialog");
  assert.equal(reading.kind, "measured");
  assert.deepEqual(reading.measurements.map((entry) => [entry.path.display, entry.bytes]), [["/root", 1004n], ["/etc/ssl/private", 5n]]);
  assert.deepEqual(reading.measurements[0].children.map((child) => [child.path.display, child.bytes]), [["/root/big", 900n], ["/root/small", 100n]]);
  assert.deepEqual(reading.skipped, []);
});

test("a refused or cancelled password prompt measures nothing and says so", async () => {
  for (const [kind, result] of [
    ["pkexec", { exitCode: 126, stderr: "Error executing command as another user: Request dismissed" }],
    ["sudo", { exitCode: 1, stderr: "sudo: 3 incorrect password attempts\n" }],
  ]) {
    const port = createElevatedDu({
      euid: 1000,
      environment: kind === "pkexec" ? { DISPLAY: ":0" } : {},
      resolve: resolveAll,
      spawn: fakeSpawn(result, []),
    });
    const reading = await port.measure([rawPathFromUtf8("/root")], "allocated", { interactive: true, signal: signal() });
    assert.equal(reading.kind, "denied", kind);
  }
});

test("a name that cannot be handed to a program is skipped, never mangled", async () => {
  const seen = [];
  const port = createElevatedDu({ euid: 0, resolve: resolveAll, spawn: fakeSpawn({ stdout: Buffer.from("1\t/ok\x00") }, seen) });
  const notText = rawPathFromBytes(new Uint8Array([0x2f, 0x61, 0xff]));
  const relative = rawPathFromUtf8("relative/path");
  const reading = await port.measure([rawPathFromUtf8("/ok"), notText, relative], "allocated", { interactive: true, signal: signal() });

  assert.deepEqual(seen[0].argv.slice(-2), ["--", "/ok"]);
  assert.deepEqual(reading.skipped.map((path) => path.bytesBase64), [notText.bytesBase64, relative.bytesBase64]);
});

test("the real du's output is understood, run here without raising it", async () => {
  const root = await mkdtemp(join(tmpdir(), "disktop-elevated-"));
  try {
    await mkdir(join(root, "locked", "inner"), { recursive: true });
    await writeFile(join(root, "locked", "inner", "data"), Buffer.alloc(1 << 20, 1));
    await writeFile(join(root, "locked", "top"), Buffer.alloc(4096, 1));
    // euid 0 tells the adapter it needs no elevation, so the system du runs as is.
    const port = createElevatedDu({ euid: 0 });
    const locked = rawPathFromUtf8(join(root, "locked"));
    const reading = await port.measure([locked], "apparent", { interactive: false, signal: signal() });

    assert.equal(reading.kind, "measured", reading.explanation ?? reading.capability?.explanation);
    const [measurement] = reading.measurements;
    assert.ok(measurement.bytes >= (1n << 20n) + 4096n, String(measurement.bytes));
    assert.deepEqual(measurement.children.map((child) => child.path.display.slice(root.length)), ["/locked/inner", "/locked/top"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
