#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bootstrapCli } from "../cli/bootstrap.js";
import type { CliContext } from "../cli/context.js";
import { createServices } from "../composition/root.js";
import { runTui } from "../tui/app.js";
import { createTerminalRenderer } from "../tui/render.js";
import { selectTheme } from "../tui/themes.js";

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
    },
    footprint: services.footprint,
    // Ctrl+C asks a running command to stop at a safe boundary; it does not
    // tear the process down and leave the work unreported.
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
        dashboard: services.dashboard,
        units: settings.units,
        theme: selectTheme(process.env, interactive),
        createRenderer: (theme) => createTerminalRenderer({ theme, mouse: true }),
      }),
  };
}

process.exitCode = await bootstrapCli(process.argv.slice(2), process.versions.node, output, buildContext);
