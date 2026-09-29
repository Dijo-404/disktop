#!/usr/bin/env node
/**
 * Build a fixture tree outside the test runner for manual inspection or a
 * benchmark run. The tree is always a temporary sandbox; delete it yourself
 * with the command this prints -- the standard tree contains a 0o000 directory
 * that plain `rm -rf` cannot remove.
 *
 *   node scripts/generate-fixtures.mjs standard
 *   node scripts/generate-fixtures.mjs large 1000000
 */
import { createLargeFixture, createStandardFixture } from "../tests/fixtures/generate.mjs";

const [kind = "standard", count = "1000000"] = process.argv.slice(2);

if (kind === "standard") {
  const fixture = await createStandardFixture();
  process.stderr.write(`remove with: chmod -R u+rwX ${fixture.root} && rm -rf ${fixture.root}\n`);
  process.stdout.write(`${fixture.root}\n`);
} else if (kind === "large") {
  const entries = Number.parseInt(count, 10);
  const started = process.hrtime.bigint();
  const fixture = await createLargeFixture({ entries });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  process.stderr.write(`${fixture.entryCount} entries in ${seconds.toFixed(1)}s\n`);
  process.stdout.write(`${fixture.root}\n`);
} else {
  process.stderr.write("Usage: generate-fixtures.mjs standard | large [ENTRIES]\n");
  process.exitCode = 2;
}
