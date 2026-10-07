import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const ENTRY = resolve("dist/bin/disktop.js");
const ESCAPES = /\u001b\[[0-9;?<>]*[A-Za-z]|\u001b[()][0-9A-Za-z]/g;
const visible = (output) => output.replace(ESCAPES, "");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const configValue = (value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** Keep subprocess output bounded, and register completion before it can exit. */
function launch(program, args, options = {}) {
  const child = spawn(program, args, options);
  const result = { child, stdout: "", stderr: "", ended: false, error: undefined };
  for (const channel of ["stdout", "stderr"]) {
    child[channel].setEncoding("utf8").on("data", (chunk) => {
      if (result[channel].length + chunk.length > 4 * 1024 * 1024) {
        result.error = new Error(`${program} exceeded the test's output bound`);
        child.kill("SIGKILL");
        return;
      }
      result[channel] += chunk;
    });
  }
  child.on("error", (error) => { result.error = error; });
  child.stdin.on("error", (error) => { result.error = error; });
  result.closed = new Promise((complete) => child.on("close", (code, signal) => {
    result.ended = true;
    result.code = code;
    result.signal = signal;
    complete();
  }));
  return result;
}

async function stop(process_) {
  if (process_ === undefined || process_.ended) return;
  process_.child.kill("SIGTERM");
  const force = setTimeout(() => process_.child.kill("SIGKILL"), 1_000);
  try {
    await process_.closed;
  } finally {
    clearTimeout(force);
  }
}

async function until(process_, predicate, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.equal(process_.error, undefined, `${message}: ${process_.error?.message}`);
    assert.equal(process_.ended, false, `${message}: exited ${process_.code}; ${process_.stderr}; ${visible(process_.stdout)}`);
    assert.ok(Date.now() < deadline, `${message}: timed out; ${process_.stderr}; ${visible(process_.stdout)}`);
    await delay(25);
  }
}

async function unusedPort() {
  const server = createServer();
  await new Promise((complete, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", complete);
  });
  const port = server.address().port;
  await new Promise((complete, reject) => server.close((error) => error === undefined ? complete() : reject(error)));
  assert.ok(port >= 1024, "the loopback SSH server must use an unprivileged ephemeral port");
  return port;
}

function key(path) {
  const generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path], {
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(generated.error, undefined, generated.error?.message);
  assert.equal(generated.status, 0, generated.stderr);
}

function checkTerminal(result, expectedStatus) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.code, expectedStatus, `${result.stderr}\n${visible(result.stdout)}`);
  assert.match(result.stdout, /__DISKTOP_SSH_SIZE=24 80__/, "the remote PTY really is 80 by 24");
  assert.match(result.stdout, /\u001b\[\?1049h/, "the remote CLI entered the alternate screen");
  assert.match(result.stdout, /\u001b\[\?1049l/, "the remote CLI restored the main screen");
  assert.match(result.stdout, /\u001b\[\?(25h|0c)/, "the remote CLI restored the cursor");
  assert.match(visible(result.stdout), /Disktop/);
  assert.match(visible(result.stdout), /MOUNT/);
  assert.match(result.stdout, new RegExp(`__DISKTOP_SSH_STATUS=${expectedStatus}__`));
  assert.match(result.stdout, /__DISKTOP_SSH_STTY_RESTORED__/, "all remote terminal attributes were restored");
  assert.doesNotMatch(visible(result.stdout), /[\u2500-\u259f◆◇●◉⠋⠙⠹⠸]/u, "a C locale uses ASCII layout and chart glyphs");
  for (const [, parameters] of result.stdout.matchAll(/\u001b\[([0-9;]*)m/g)) {
    for (const parameter of parameters.split(";").filter(Boolean)) {
      const code = Number(parameter);
      assert.ok(!((code >= 30 && code <= 49) || (code >= 90 && code <= 107)), `NO_COLOR emitted colour code ${code}`);
    }
  }
  const drawing = result.stdout.split("\u001b[?1049h")[1].split("\u001b[?1049l")[0];
  let rows = 0;
  for (const [, row, column, text] of drawing.matchAll(/\u001b\[(\d+);(\d+)H([^]*?)(?=\u001b\[\d+;\d+H|$)/g)) {
    assert.ok(Number(row) >= 1 && Number(row) <= 24, `draw outside remote PTY row ${row}`);
    assert.ok(Number(column) >= 1 && Number(column) <= 80, `draw outside remote PTY column ${column}`);
    assert.ok([...visible(text)].length <= 81 - Number(column), `remote row ${row} overflowed: ${JSON.stringify(visible(text))}`);
    rows += 1;
  }
  assert.ok(rows >= 24, "the remote TUI drew a complete 24-row frame");
}

test("the real TUI restores an 80 by 24 SSH terminal on quit and SIGINT", {
  skip: process.env.DISKTOP_TEST_SSH !== "1" && "set DISKTOP_TEST_SSH=1 to run the isolated loopback SSH gate",
  timeout: 60_000,
}, async (context) => {
  assert.notEqual(process.getuid?.(), 0, "the loopback SSH gate must run as an unprivileged user");
  const user = userInfo();
  assert.match(user.username, /^[A-Za-z0-9_-]+$/, "the test requires a literal SSH account name");
  // OpenSSH's StrictModes rejects /tmp as an authorized-key ancestor, even
  // with sticky permissions. Keep a private temporary directory under home.
  const directory = await mkdtemp(join(user.homedir, ".disktop-ssh-test-"));
  let daemon;
  const clients = [];
  try {
    const hostKey = join(directory, "host");
    const clientKey = join(directory, "client");
    key(hostKey);
    key(clientKey);
    const port = await unusedPort();
    const authorized = join(directory, "authorized_keys");
    const knownHosts = join(directory, "known_hosts");
    const config = join(directory, "sshd_config");
    const pidFile = join(directory, "sshd.pid");
    await writeFile(authorized, await readFile(`${clientKey}.pub`), { mode: 0o600 });
    await writeFile(knownHosts, `[127.0.0.1]:${port} ${(await readFile(`${hostKey}.pub`, "utf8")).trim()}\n`, { mode: 0o600 });
    await writeFile(config, [
      `Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${configValue(hostKey)}`,
      `PidFile ${configValue(pidFile)}`, `AuthorizedKeysFile ${configValue(authorized)}`,
      `AllowUsers ${user.username}`, "StrictModes yes", "UsePAM no", "PasswordAuthentication no",
      "KbdInteractiveAuthentication no", "PubkeyAuthentication yes", "AuthenticationMethods publickey",
      "PermitRootLogin no", "AllowAgentForwarding no", "AllowTcpForwarding no", "X11Forwarding no",
      "PermitTunnel no", "PermitUserEnvironment no", "PermitUserRC no", "PrintMotd no", "UseDNS no", "LogLevel ERROR", "",
    ].join("\n"), { mode: 0o600 });
    daemon = launch("/usr/sbin/sshd", ["-D", "-e", "-f", config], { detached: true });
    const ssh = (command, terminal = false) => {
      const process_ = launch("ssh", [
        "-F", "/dev/null", ...(terminal ? ["-tt"] : []), "-p", String(port), "-i", clientKey,
        "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
        "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`,
        "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ControlMaster=no", "-o", "ControlPath=none",
        "-o", "ConnectTimeout=3", "-o", "ConnectionAttempts=1", "-o", "LogLevel=ERROR",
        "-l", user.username, "127.0.0.1", command,
      ]);
      clients.push(process_);
      return process_;
    };
    // A successful public-key command proves readiness, account access, and
    // rootless operation; an enabled gate never skips an unavailable server.
    await until(daemon, () => existsSync(pidFile), "the private SSH server did not listen", 5_000);
    const probe = ssh("printf DISKTOP_SSH_READY");
    await until(probe, () => probe.ended, `loopback SSH did not answer: ${daemon.stderr}`, 5_000);
    assert.equal(probe.code, 0, `${probe.stderr}\n${daemon.stderr}`);
    assert.equal(probe.stdout, "DISKTOP_SSH_READY");

    for (const mode of ["quit", "SIGINT"]) {
      await context.test(mode, async () => {
        const home = join(directory, mode);
        await mkdir(home, { mode: 0o700 });
        const environment = [
          `HOME=${home}`, `XDG_CONFIG_HOME=${join(home, "config")}`, `XDG_DATA_HOME=${join(home, "data")}`,
          `XDG_STATE_HOME=${join(home, "state")}`, `XDG_CACHE_HOME=${join(home, "cache")}`,
          "LANG=C", "LC_ALL=C", "TERM=xterm-256color", "NO_COLOR=1",
        ].map(quote).join(" ");
        const run = `printf '__DISKTOP_SSH_PID=%s__\\n' "$$"; exec env ${environment} ${quote(process.execPath)} ${quote(ENTRY)}`;
        const command = [
          "stty rows 24 cols 80", "before=$(stty -g)", "printf '__DISKTOP_SSH_SIZE=%s__\\n' \"$(stty size)\"",
          `sh -c ${quote(run)}`, "disktop_ssh_exit=$?", "after=$(stty -g)",
          "printf '__DISKTOP_SSH_STATUS=%s__\\n' \"$disktop_ssh_exit\"",
          'if [ "$before" = "$after" ]; then printf "__DISKTOP_SSH_STTY_RESTORED__\\n"; else printf "__DISKTOP_SSH_STTY_CHANGED__\\n"; exit 125; fi',
          'exit "$disktop_ssh_exit"',
        ].join("; ");
        const session = ssh(command, true);
        await until(session, () => /MOUNT/.test(visible(session.stdout)), "the SSH dashboard did not draw");
        if (mode === "quit") {
          session.child.stdin.write("q");
        } else {
          const match = session.stdout.match(/__DISKTOP_SSH_PID=(\d+)__/);
          assert.ok(match, "the remote process identified itself before drawing");
          const signal = ssh(`kill -INT ${Number(match[1])}`);
          await until(signal, () => signal.ended, "the remote SIGINT command did not finish", 5_000);
          assert.equal(signal.code, 0, signal.stderr);
        }
        await until(session, () => session.ended, "the SSH TUI did not exit after its shutdown request");
        checkTerminal(session, mode === "SIGINT" ? 130 : session.code);
        if (mode === "quit") assert.ok([0, 3].includes(session.code), `unexpected quit exit ${session.code}`);
      });
    }
  } finally {
    await Promise.all(clients.map(stop));
    await stop(daemon);
    await rm(directory, { recursive: true, force: true });
  }
});
