import assert from "node:assert/strict";
import { test } from "node:test";
import { notifyAlerts } from "../../dist/application/alert-notifier.js";
import { createNotifySend } from "../../dist/platform/linux/notifications/notify-send.js";

const alert = (kind, message) => ({ filesystemId: "fs-1", kind, usedPercent: 95, thresholdPercent: 90, message });

function port() {
  const sent = [];
  return { sent, port: { id: "fake", async send(title, body) { sent.push({ title, body }); return { sent: true, explanation: "sent" }; } } };
}

test("no alert sends nothing", async () => {
  const { sent, port: notifications } = port();
  assert.equal(await notifyAlerts(notifications, []), undefined);
  assert.deepEqual(sent, []);
});

test("one notification summarises up to three alerts", async () => {
  const { sent, port: notifications } = port();
  const outcome = await notifyAlerts(notifications, [
    alert("low-space", "/ ext4 filesystem is 95% used."),
    alert("low-inodes", "/home has 12 inodes left."),
    alert("low-space", "/data is 96% used."),
    alert("low-space", "/backup is 97% used."),
  ]);
  assert.equal(outcome.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, "Disktop: low disk space");
  assert.equal(sent[0].body.split("\n").length, 4);
  assert.match(sent[0].body, /and 1 more/);
});

test("only inode pressure is titled as such", async () => {
  const { sent, port: notifications } = port();
  await notifyAlerts(notifications, [alert("low-inodes", "/home has 12 inodes left.")]);
  assert.equal(sent[0].title, "Disktop: low inodes");
});

test("notify-send gets a fixed argv, with -- ahead of text that could read as an option", async () => {
  const calls = [];
  const notifier = createNotifySend({
    resolve: async () => "/usr/bin/notify-send",
    environment: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
    execute: async (program, argv) => {
      calls.push([program, argv]);
      return { exitCode: 0, stderr: "" };
    },
  });
  const outcome = await notifier.send("Disktop: low disk space", "-x is 95% used");
  assert.equal(outcome.sent, true);
  assert.deepEqual(calls, [["/usr/bin/notify-send", ["--app-name=Disktop", "--urgency=critical", "--", "Disktop: low disk space", "-x is 95% used"]]]);
});

test("without a session bus or notify-send, nothing is sent and the reason is given", async () => {
  const noBus = createNotifySend({ resolve: async () => "/usr/bin/notify-send", environment: {}, execute: async () => ({ exitCode: 0, stderr: "" }) });
  const outcome = await noBus.send("t", "b");
  assert.equal(outcome.sent, false);
  assert.match(outcome.explanation, /session bus/);
  const noTool = createNotifySend({ resolve: async () => undefined, environment: { DBUS_SESSION_BUS_ADDRESS: "x" }, execute: async () => ({ exitCode: 0, stderr: "" }) });
  assert.match((await noTool.send("t", "b")).explanation, /notify-send/);
});
