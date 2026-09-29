#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { bootstrapCli } from "../cli/bootstrap.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

process.exitCode = bootstrapCli(process.argv.slice(2), packageJson.version, process.versions.node, {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
});
