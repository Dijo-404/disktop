import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

/**
 * Inside tmux, as a person would use it: what the pane actually shows after
 * keys, after the window is resized, and after quitting. tmux is the terminal
 * here, so this checks what was drawn, not what was written.
 */

const ENTRY = resolve("dist/bin/disktop.js");

function tmux(...args) {
  return spawnSync("tmux", ["-L", "disktop-test", ...args], { encoding: "utf8" });
}

function haveTmux(context) {
  if (spawnSync("tmux", ["-V"], { encoding: "utf8" }).error?.code === "ENOENT") {
    context.skip("tmux is not installed");
    return false;
  }
  return true;
}

async function pane() {
  await delay(700);
  return tmux("capture-pane", "-p", "-t", "disktop").stdout;
}

test("the TUI draws, redraws on resize, and hands the pane back inside tmux", async (context) => {
  if (!haveTmux(context)) {
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "disktop-tmux-"));
  const environment = [
    `HOME=${home}`,
    `XDG_CONFIG_HOME=${home}/config`,
    `XDG_DATA_HOME=${home}/data`,
    `XDG_STATE_HOME=${home}/state`,
    `XDG_CACHE_HOME=${home}/cache`,
    "LANG=C.UTF-8",
    "TERM=tmux-256color",
  ].join(" ");
  try {
    const started = tmux(
      "new-session", "-d", "-s", "disktop", "-x", "80", "-y", "24",
      `env ${environment} ${process.execPath} ${ENTRY}; echo "exited with $?"; sleep 30`,
    );
    assert.equal(started.status, 0, started.stderr);

    const first = await pane();
    assert.match(first, /Disktop/);
    assert.match(first, /MOUNT/);
    for (const line of first.split("\n")) {
      assert.ok([...line].length <= 80, `a row is wider than the pane: ${JSON.stringify(line)}`);
    }

    tmux("send-keys", "-t", "disktop", "2");
    assert.match(await pane(), /Nothing has been scanned here yet/);

    tmux("resize-window", "-t", "disktop", "-x", "60", "-y", "18");
    const narrow = await pane();
    assert.match(narrow, /Explore/, "the tab bar survives a narrower window");
    assert.match(narrow, /Nothing has been scanned/, "and so does the view");

    tmux("resize-window", "-t", "disktop", "-x", "30", "-y", "8");
    assert.match(await pane(), /needs at least/, "below the minimum it says so");

    tmux("resize-window", "-t", "disktop", "-x", "100", "-y", "30");
    tmux("send-keys", "-t", "disktop", "q");
    const after = await pane();
    assert.match(after, /exited with [03]/, "q leaves with a documented status");
    assert.doesNotMatch(after, /MOUNT/, "the alternate screen is gone and the shell's screen is back");
  } finally {
    tmux("kill-server");
    rmSync(home, { recursive: true, force: true });
  }
});
