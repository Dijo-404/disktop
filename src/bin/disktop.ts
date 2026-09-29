#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { runCli } from "../cli/parser.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

process.exitCode = runCli(process.argv.slice(2), packageJson.version, {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
});
