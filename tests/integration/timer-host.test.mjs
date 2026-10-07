/** Opt-in host validation: only throwaway units and runtime links are written. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readlink, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { renderUnits, SERVICE_UNIT, TIMER_UNIT } from "../../dist/domain/timer.js";
import { createSystemdUserTimer } from "../../dist/platform/linux/notifications/systemd-timer.js";

const execute = promisify(execFile);
async function systemctl(args) {
  try {
    const result = await execute("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 15_000, shell: false });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { exitCode: typeof error.code === "number" ? error.code : null, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
  }
}

test("a real user timer installs, runs only the alert command, and uninstalls through runtime links", async (t) => {
  if (process.env.DISKTOP_TEST_SYSTEMD !== "1") {
    t.skip("set DISKTOP_TEST_SYSTEMD=1 on a host with a systemd user instance; this test uses isolated runtime links");
    return;
  }
  const probe = await systemctl(["show-environment"]);
  assert.equal(probe.exitCode, 0, probe.stderr);
  const runtime = process.env.XDG_RUNTIME_DIR;
  assert.ok(runtime?.startsWith("/"), "XDG_RUNTIME_DIR must name this user's runtime directory");
  for (const name of [SERVICE_UNIT, TIMER_UNIT]) {
    const existing = await systemctl(["show", name, "--property=LoadState", "--value"]);
    if (existing.stdout.trim() !== "not-found") {
      t.skip(`${name} already exists; the host's configured timer is left alone`);
      return;
    }
  }
  const work = await mkdtemp(join(tmpdir(), "disktop-timer-host-"));
  const script = join(work, "alerts.mjs");
  const evidence = join(work, "arguments.json");
  await writeFile(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(evidence)}, JSON.stringify(process.argv.slice(2)));\n`);
  const units = renderUnits({ node: process.execPath, script });
  let linked = false;
  t.after(async () => {
    if (linked) {
      await systemctl(["disable", "--runtime", "--now", TIMER_UNIT]);
      await systemctl(["stop", SERVICE_UNIT]);
      for (const name of [SERVICE_UNIT, TIMER_UNIT]) {
        const path = join(runtime, "systemd", "user", name);
        const target = await readlink(path).catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        });
        if (target === join(work, name)) await unlink(path);
      }
      const reloaded = await systemctl(["daemon-reload"]);
      assert.equal(reloaded.exitCode, 0, reloaded.stderr);
    }
    await rm(work, { recursive: true, force: true });
  });
  const port = createSystemdUserTimer({
    unitDirectory: work,
    systemctl: async ([, command, ...args]) => {
      if (command === "daemon-reload" && !linked) {
        linked = true;
        const result = await systemctl(["link", "--runtime", join(work, SERVICE_UNIT), join(work, TIMER_UNIT)]);
        if (result.exitCode !== 0) return result;
      }
      return systemctl([command, ...(["enable", "disable"].includes(command) ? ["--runtime"] : []), ...args]);
    },
  });
  const installed = await port.install(units);
  assert.equal(installed.failure, undefined, JSON.stringify(installed.failure));
  assert.equal(installed.enabled, true);
  assert.equal((await systemctl(["is-active", TIMER_UNIT])).stdout.trim(), "active");
  const run = await systemctl(["start", SERVICE_UNIT]);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.deepEqual(JSON.parse(await readFile(evidence, "utf8")), ["alerts", "check", "--notify"]);
  const removed = await port.uninstall();
  assert.equal(removed.failure, undefined, JSON.stringify(removed.failure));
  assert.deepEqual(removed.units.map((unit) => unit.state), ["removed", "removed"]);
  assert.notEqual((await systemctl(["is-active", TIMER_UNIT])).stdout.trim(), "active");
});
