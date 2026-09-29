import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateAlerts } from "../../dist/application/alerts.js";
import { usedPercentOfInodes, usedPercentOfSpace } from "../../dist/domain/sizes.js";

function filesystem(overrides) {
  return {
    id: "fs-8-1",
    type: "ext4",
    source: "/dev/sda1",
    mounts: [{ bytesBase64: "Lw==", display: "/", utf8: "/" }],
    totalBytes: 1000n,
    freeBytes: 500n,
    availableBytes: 500n,
    network: false,
    removable: false,
    ...overrides,
  };
}

const THRESHOLDS = { spacePercent: 90, inodePercent: 90 };

test("the used share leaves reserved blocks out of the denominator, as df does", () => {
  // 900 used of 1000, but only 50 of those bytes are the user's to reclaim.
  assert.equal(usedPercentOfSpace(1000n, 100n, 50n), 94);
  assert.equal(usedPercentOfSpace(1000n, 1000n, 1000n), 0);
  assert.equal(usedPercentOfSpace(0n, 0n, 0n), 0);
});

test("a percentage is rounded down, so a threshold is never crossed early", () => {
  // 89.9% used must not raise a 90% alert.
  assert.equal(usedPercentOfSpace(1000n, 101n, 101n), 89);
  assert.equal(usedPercentOfInodes(61_054_976n, 1_220_993n), 98);
  assert.deepEqual(evaluateAlerts([filesystem({ totalBytes: 1000n, freeBytes: 101n, availableBytes: 101n })], THRESHOLDS), []);
});

test("reaching the threshold exactly raises the alert", () => {
  const alerts = evaluateAlerts([filesystem({ totalBytes: 1000n, freeBytes: 100n, availableBytes: 100n })], THRESHOLDS);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "low-space");
  assert.equal(alerts[0].usedPercent, 90);
  assert.equal(alerts[0].thresholdPercent, 90);
});

test("low inodes are their own alert, because free blocks do not fix them", () => {
  const alerts = evaluateAlerts(
    [filesystem({ totalBytes: 1000n, freeBytes: 900n, availableBytes: 900n, totalInodes: 100n, freeInodes: 2n })],
    THRESHOLDS,
  );
  assert.deepEqual(alerts.map((alert) => alert.kind), ["low-inodes"]);
  assert.match(alerts[0].message, /low inodes fail writes even when blocks are free/);
});

test("a filesystem with no inode accounting raises no inode alert", () => {
  const alerts = evaluateAlerts([filesystem({ totalBytes: 100n, freeBytes: 1n, availableBytes: 1n })], THRESHOLDS);
  assert.deepEqual(alerts.map((alert) => alert.kind), ["low-space"]);
});

test("a network filesystem is not alerted on; its capacity is not this machine's to reclaim", () => {
  const alerts = evaluateAlerts(
    [filesystem({ network: true, totalBytes: 1000n, freeBytes: 1n, availableBytes: 1n })],
    THRESHOLDS,
  );
  assert.deepEqual(alerts, []);
});

test("one filesystem with several mounts raises one alert naming them", () => {
  const alerts = evaluateAlerts(
    [
      filesystem({
        totalBytes: 1000n,
        freeBytes: 1n,
        availableBytes: 1n,
        mounts: [
          { bytesBase64: "Lw==", display: "/", utf8: "/" },
          { bytesBase64: "L2hvbWU=", display: "/home", utf8: "/home" },
        ],
      }),
    ],
    THRESHOLDS,
  );
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /\/ and \/home/);
});
