#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { bootstrapCli } from "../cli/bootstrap.js";
import type { CliContext } from "../cli/context.js";
import { createServices } from "../composition/root.js";
import { runTui } from "../tui/app.js";
import { createTerminalRenderer } from "../tui/render.js";
import { selectTheme, supportsFullScreen } from "../tui/themes.js";
import { rawPathFromUtf8 } from "../domain/paths.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

const output = {
  stdout: (message: string) => process.stdout.write(message),
  stderr: (message: string) => process.stderr.write(message),
};

/**
 * Assemble the surfaces. Adapters come from the composition root; this file
 * only decides which surface runs and hands each one what it needs.
 */
async function buildContext(): Promise<CliContext> {
  const services = await createServices();
  // A terminal that cannot address its cursor (TERM=dumb or unset) gets the
  // text dashboard and no progress line, exactly like a pipe.
  const interactive = process.stdout.isTTY === true && process.stdin.isTTY === true && supportsFullScreen(process.env);

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
    report: services.report,
    // Ctrl+C asks a running command to stop at a safe boundary; it does not
    // tear the process down and leave the work unreported.
    startupWarnings: services.startupWarnings,
    notifications: services.alertNotifications,
    timer: services.timer,
    signals: {
      listen: (handler) => {
        process.on("SIGINT", handler);
        process.on("SIGTERM", handler);
      },
      stop: (handler) => {
        process.off("SIGINT", handler);
        process.off("SIGTERM", handler);
      },
    },
    resolvePath: (path) => resolve(process.cwd(), path),
    now: () => new Date(),
    interactive,
    launchTui: (settings) =>
      runTui({
        services: {
          dashboard: services.dashboard,
          scan: services.scan,
          explore: services.explore,
          snapshots: services.snapshots,
          find: services.find,
          footprint: services.footprint,
          plan: (request, signal) => services.plan.plan(request, signal),
          apply: (request, signal) => services.apply.apply(request, signal),
          history: (cursor, limit) => services.undo.history(cursor, limit),
          restore: (journalId, signal) => services.undo.restore(journalId, signal),
          defaults: {
            excludes: services.scanDefaults.excludes,
            retention: services.scanDefaults.retention,
            staleAfterDays: services.findDefaults.staleAfterDays,
          },
          home: rawPathFromUtf8(homedir()),
          now: () => new Date(),
        },
        units: settings.units,
        threshold: settings.thresholds.spacePercent,
        theme: selectTheme(process.env, interactive),
        createRenderer: (theme) => createTerminalRenderer({ theme, mouse: process.env.DISKTOP_NO_MOUSE === undefined }),
      }),
  };
}

process.exitCode = await bootstrapCli(process.argv.slice(2), process.versions.node, output, buildContext);
