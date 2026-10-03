#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bootstrapCli, reportUnexpected } from "../cli/bootstrap.js";
import type { CliContext } from "../cli/context.js";
import { createInterruptSource, guardStreams } from "../cli/process-io.js";
import { createServices } from "../composition/root.js";
import { runTui } from "../tui/app.js";
import { createTerminalRenderer } from "../tui/render.js";
import { selectTheme } from "../tui/themes.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

const args = process.argv.slice(2);
const output = guardStreams(process.stdout, process.stderr);

/**
 * Anything that escapes a command is still one sanitized line and exit 2.
 *
 * The process state after an uncaught error is not something to keep running
 * on, so this reports and exits. A command that already wrote its envelope
 * gets the reason on stderr instead of a second one on stdout.
 */
function fatal(error: unknown): void {
  const channel = output.wroteStdout() ? args.filter((argument) => argument !== "--json") : args;
  process.exit(reportUnexpected(channel, output, error));
}
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

/**
 * Assemble the surfaces. Adapters come from the composition root; this file
 * only decides which surface runs and hands each one what it needs.
 */
async function buildContext(): Promise<CliContext> {
  const services = await createServices();
  const interactive = process.stdout.isTTY === true && process.stdin.isTTY === true;

  return {
    version: packageJson.version,
    output,
    settings: services.settings,
    dashboard: services.dashboard,
    storage: {
      scan: services.scan,
      explore: services.explore,
      snapshots: services.snapshots,
      defaults: services.scanDefaults,
      find: services.findDefaults,
    },
    footprint: services.footprint,
    actions: {
      plan: (request, signal) => services.plan.plan(request, signal),
      apply: (request, signal) => services.apply.apply(request, signal),
      history: (cursor, limit) => services.undo.history(cursor, limit),
      restore: (journalId, signal) => services.undo.restore(journalId, signal),
      find: (request, signal) => services.find.find(request, signal),
    },
    // Ctrl+C asks a running command to stop at a safe boundary; it does not
    // tear the process down and leave the work unreported.
    startupWarnings: services.startupWarnings,
    notifications: services.alertNotifications,
    timer: services.timer,
    signals: createInterruptSource(process, output.stderr),
    resolvePath: (path) => resolve(process.cwd(), path),
    now: () => new Date(),
    interactive,
    progress: process.stderr.isTTY === true,
    launchTui: (settings) =>
      runTui({
        dashboard: services.dashboard,
        units: settings.units,
        theme: selectTheme(process.env, interactive),
        createRenderer: (theme) => createTerminalRenderer({ theme, mouse: true }),
      }),
  };
}

const status = await bootstrapCli(args, process.versions.node, output, buildContext, packageJson.version);
const lost = output.failure();
if (lost !== undefined) {
  output.stderr(`Disktop could not write its output: ${lost}\n`);
}
process.exitCode = lost === undefined ? status : 2;

// Every command closes what it opened before it returns, so the process
// normally exits as soon as this module finishes. A filesystem call the kernel
// never answers — statfs on a dead NFS server — holds a worker thread Node
// cannot cancel, and that must not keep a finished command from exiting.
setTimeout(() => process.exit(), 1_000).unref();
