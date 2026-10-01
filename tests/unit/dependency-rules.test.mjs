import assert from "node:assert/strict";
import { test } from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint();

async function violations(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map((message) => `${message.ruleId}: ${message.message}`);
}

async function assertRefused(filePath, code, expected) {
  const messages = await violations(filePath, code);
  assert.ok(
    messages.some((message) => message.includes(expected)),
    `${filePath} should be refused (${expected}); got ${JSON.stringify(messages)}`,
  );
}

async function assertAccepted(filePath, code) {
  assert.deepEqual(await violations(filePath, code), [], filePath);
}

test("domain stays pure: no I/O, no ports, no adapters", async () => {
  await assertRefused("src/domain/sizes.ts", 'import { readFile } from "node:fs/promises";\nexport const x = readFile;\n', "domain");
  await assertRefused("src/domain/sizes.ts", 'import type { ScanPort } from "../ports/scan.js";\nexport type X = ScanPort;\n', "domain");
  await assertRefused("src/domain/sizes.ts", 'import { DEFAULT_CONFIG } from "../storage/config.js";\nexport const x = DEFAULT_CONFIG;\n', "domain");
  await assertAccepted("src/domain/sizes.ts", 'import type { RawPath } from "./models.js";\nexport type X = RawPath;\n');
});

test("application depends on domain and ports, never on an adapter", async () => {
  await assertRefused(
    "src/application/dashboard.ts",
    'import { linuxInventory } from "../platform/linux/inventory/index.js";\nexport const x = linuxInventory;\n',
    "application",
  );
  await assertAccepted(
    "src/application/dashboard.ts",
    'import type { InventoryPort } from "../ports/inventory.js";\nexport type X = InventoryPort;\n',
  );
});

test("presentation calls application, never the helper or a Linux command", async () => {
  for (const file of ["src/cli/commands/devices.ts", "src/tui/views/disks.ts", "src/reports/json.ts"]) {
    await assertRefused(file, 'import { NativeClient } from "../../native/client.js";\nexport const x = NativeClient;\n', "call application");
    await assertRefused(file, 'import { spawn } from "node:child_process";\nexport const x = spawn;\n', "call application");
  }
});

test("providers cannot run a command or delete anything", async () => {
  await assertRefused("src/providers/caches/npm.ts", 'import { execFile } from "node:child_process";\nexport const x = execFile;\n', "provider");
  await assertRefused("src/providers/caches/npm.ts", 'import { rm } from "node:fs/promises";\nexport const x = rm;\n', "provider");
  await assertAccepted("src/providers/caches/npm.ts", 'import { readdir } from "node:fs/promises";\nexport const x = readdir;\n');
});

test("destructive filesystem calls are refused outside Disktop's own storage", async () => {
  await assertRefused("src/application/undo.ts", 'import { rmSync } from "node:fs";\nexport const x = rmSync;\n', "Rust helper");
  await assertRefused(
    "src/cli/commands/clean.ts",
    'import { promises as fs } from "node:fs";\nexport const remove = () => fs.rm("/tmp/x", { recursive: true });\n',
    "Rust helper",
  );
  await assertAccepted("src/storage/snapshots.ts", 'import { rm } from "node:fs/promises";\nexport const x = rm;\n');
});

test("only the composition root builds an adapter, and it imports no surface", async () => {
  await assertAccepted(
    "src/composition/root.ts",
    'import { createLinuxInventory } from "../platform/linux/inventory/index.js";\nimport { createDashboardService } from "../application/dashboard.js";\nexport const x = [createLinuxInventory, createDashboardService];\n',
  );
  await assertRefused(
    "src/composition/root.ts",
    'import { runTui } from "../tui/app.js";\nexport const x = runTui;\n',
    "never imports one",
  );
  await assertRefused(
    "src/composition/root.ts",
    'import { runCli } from "../cli/run.js";\nexport const x = runCli;\n',
    "never imports one",
  );
});

test("the executable entry point and the ports are layered too", async () => {
  await assertRefused("src/bin/disktop.ts", 'import { spawn } from "node:child_process";\nexport const x = spawn;\n', "entry point");
  await assertRefused(
    "src/bin/disktop.ts",
    'import { linuxInventory } from "../platform/linux/inventory/index.js";\nexport const x = linuxInventory;\n',
    "entry point",
  );
  await assertRefused(
    "src/ports/scan.ts",
    'import { linuxInventory } from "../platform/linux/inventory/index.js";\nexport const x = linuxInventory;\n',
    "port",
  );
  await assertAccepted("src/ports/scan.ts", 'import type { RawPath } from "../domain/models.js";\nexport type X = RawPath;\n');
});

test("a data field named like a destructive call is not a destructive call", async () => {
  // lsblk's removable column is `rm`. Refusing to read it would push adapters
  // into workarounds without preventing a single deletion.
  await assertAccepted(
    "src/platform/linux/inventory/lsblk.ts",
    'export const removable = (row) => Boolean(row["rm"]);\n',
  );
  await assertAccepted(
    "src/platform/linux/inventory/lsblk.ts",
    'export const removable = (row) => Boolean(row.rm);\n',
  );
  await assertRefused(
    "src/cli/commands/clean.ts",
    'import fs from "node:fs";\nexport const go = () => fs.rm("/tmp/x");\n',
    "Rust helper",
  );
});

test("a destructive call cannot be reached through a computed or destructured name", async () => {
  await assertRefused(
    "src/cli/commands/clean.ts",
    'import fs from "node:fs";\nexport const go = () => fs["rm"]("/tmp/x");\n',
    "Rust helper",
  );
  await assertRefused(
    "src/cli/commands/clean.ts",
    'import fs from "node:fs";\nconst { rm } = fs;\nexport const go = () => rm("/tmp/x");\n',
    "Rust helper",
  );
});

test("providers cannot reach a Linux adapter, only a port", async () => {
  await assertRefused(
    "src/providers/diagnostics/smart.ts",
    'import { parseSmartScan } from "../../platform/linux/diagnostics/parsers.js";\nexport const x = parseSmartScan;\n',
    "provider",
  );
  await assertAccepted(
    "src/providers/diagnostics/smart.ts",
    'import type { ToolPort } from "../../ports/providers.js";\nexport type X = ToolPort;\n',
  );
});
