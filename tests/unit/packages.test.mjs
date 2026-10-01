import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseDpkg,
  parseFlatpak,
  parseNpmGlobal,
  parsePacman,
  parsePip,
  parseRpm,
  parseSnap,
} from "../../dist/platform/linux/packages/parsers.js";

/** Real output shapes, including the ones that go wrong. */
const DPKG = [
  "bash\t1800\tinstall ok installed",
  "linux-image-6.8.0-45-generic\t392144\tinstall ok installed",
  "removed-but-configured\t120\tdeinstall ok config-files",
  "weird\tnot-a-number\tinstall ok installed",
  "",
].join("\n");

const RPM = ["bash\t1680000", "kernel\t401408000", "broken\t", ""].join("\n");

const PACMAN = [
  "Name            : bash",
  "Version         : 5.2.037-1",
  "Installed Size  : 8.52 MiB",
  "",
  "Name            : linux",
  "Installed Size  : 142.04 MiB",
  "",
  "Name            : nosize",
  "Version         : 1.0",
  "",
].join("\n");

const SNAP = [
  "Name               Version      Rev    Tracking       Publisher   Notes",
  "core22             20240823     1612   latest/stable  canonical✓  base",
  "firefox            130.0-2      4793   latest/stable  mozilla✓    -",
  "",
].join("\n");

const FLATPAK = ["org.gnome.Boxes\t1.2 GB\tflathub", "org.freedesktop.Platform\t612.4 MB\tflathub", "broken-line", ""].join("\n");

const NPM = JSON.stringify({ dependencies: { typescript: { version: "6.0.3" }, eslint: { version: "10.11.0" } } });

const PIP = JSON.stringify([
  { name: "requests", version: "2.32.3" },
  { name: "numpy", version: "2.1.1" },
]);

test("dpkg reports installed packages in kibibytes and skips what is only configured", () => {
  const packages = parseDpkg(DPKG);

  assert.deepEqual(
    packages.map((entry) => entry.name),
    ["bash", "linux-image-6.8.0-45-generic", "weird"],
  );
  assert.equal(packages[0].reportedBytes, 1800n * 1024n, "dpkg's Installed-Size is kibibytes");
  assert.equal(packages[2].reportedBytes, undefined, "a size that is not a number is absent, not zero");
});

test("rpm reports bytes and leaves an empty size absent", () => {
  const packages = parseRpm(RPM);

  assert.deepEqual(
    packages.map((entry) => [entry.name, entry.reportedBytes]),
    [
      ["bash", 1_680_000n],
      ["kernel", 401_408_000n],
      ["broken", undefined],
    ],
  );
});

test("pacman's human-readable sizes are converted, and a missing one stays missing", () => {
  const packages = parsePacman(PACMAN);

  assert.deepEqual(
    packages.map((entry) => entry.name),
    ["bash", "linux", "nosize"],
  );
  assert.equal(packages[0].reportedBytes, 8_933_868n, "8.52 MiB rounded to whole bytes");
  assert.equal(packages[2].reportedBytes, undefined);
});

test("snap lists its packages and claims no size for them", () => {
  const packages = parseSnap(SNAP);

  assert.deepEqual(
    packages.map((entry) => entry.name),
    ["core22", "firefox"],
  );
  assert.equal(packages[0].reportedBytes, undefined, "snap list prints no size column");
});

test("flatpak's human-readable sizes are converted and a short line is skipped", () => {
  const packages = parseFlatpak(FLATPAK);

  assert.deepEqual(
    packages.map((entry) => entry.name),
    ["org.gnome.Boxes", "org.freedesktop.Platform"],
  );
  assert.equal(packages[0].reportedBytes, 1_200_000_000n, "1.2 GB is decimal, as flatpak prints it");
});

test("global npm and pip packages are counted without a size either tool does not give", () => {
  assert.deepEqual(
    parseNpmGlobal(NPM).map((entry) => entry.name),
    ["typescript", "eslint"],
  );
  assert.deepEqual(
    parsePip(PIP).map((entry) => entry.name),
    ["requests", "numpy"],
  );
  assert.equal(parseNpmGlobal(NPM)[0].reportedBytes, undefined);
});

test("every parser is total on empty, truncated, and hostile input", () => {
  const parsers = [parseDpkg, parseRpm, parsePacman, parseSnap, parseFlatpak, parseNpmGlobal, parsePip];
  const inputs = [
    "",
    "\n\n\n",
    "{",
    "[",
    "null",
    '{"dependencies":null}',
    "Name            :",
    "a\tb",
    "\t\t\t",
    "x".repeat(10_000),
    "name\t1\textra\tcolumn\tinstall ok installed",
  ];

  for (const parse of parsers) {
    for (const input of inputs) {
      const result = parse(input);
      assert.ok(Array.isArray(result), `${parse.name} returned a non-array for ${JSON.stringify(input.slice(0, 20))}`);
      for (const entry of result) {
        assert.equal(typeof entry.name, "string");
        assert.ok(entry.reportedBytes === undefined || typeof entry.reportedBytes === "bigint");
      }
    }
  }
});

test("a field holding a tab cannot invent a package", () => {
  const packages = parseDpkg("na\tme\t1800\tinstall ok installed\n");

  for (const entry of packages) {
    assert.ok(!entry.name.includes("\t"));
  }
});

test("a size too large to be a number is absent rather than a thrown parser", () => {
  const packages = parseFlatpak(`org.example.Huge\t${"9".repeat(320)} GB\tflathub\n`);

  assert.equal(packages.length, 1);
  assert.equal(packages[0].reportedBytes, undefined);
});
