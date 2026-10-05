/**
 * A report whose every name is somebody else's attempt to do something:
 * run a spreadsheet formula, inject a script, break out of a quoted cell or
 * attribute, command a terminal, reorder text, or simply not be UTF-8.
 */
import { rawPathFromBytes } from "../../dist/domain/paths.js";
import { FIXTURE_ENTRY, FIXTURE_SNAPSHOT, FIXTURE_VIEW, rawPath } from "./cli-context.mjs";

const BASE = "/home/example/projects/";

/** Names as raw bytes, so a name that is not UTF-8 stays exactly what it was. */
export const HOSTILE_NAMES = new Map([
  ["formula", Buffer.from("=cmd|' /C calc'!A0")],
  ["script", Buffer.from("<script>alert(1)</script>")],
  ["quoted", Buffer.from('"quoted", with a comma')],
  ["newline", Buffer.from("first\nsecond\r\nthird")],
  ["escape", Buffer.from("\u001b[31mred\u001b[0m and \u009b2J")],
  ["invalid-utf8", Buffer.from([0x62, 0x61, 0x64, 0x2d, 0xff, 0xfe, 0x2e, 0x62, 0x69, 0x6e])],
  ["emoji", Buffer.from("report \u{1F4C4}\u200D\u{1F525}.txt")],
  ["long", Buffer.from("l".repeat(255))],
  ["bidi", Buffer.from("invoice\u202Etxt.exe")],
  ["ampersand", Buffer.from("a&b<c>d'e&amp;")],
  ["at", Buffer.from("@SUM(1+1)")],
  ["tab", Buffer.from("\t=1+1")],
]);

export const HOSTILE_PATHS = new Map(
  [...HOSTILE_NAMES].map(([name, bytes]) => [name, rawPathFromBytes(Buffer.concat([Buffer.from(BASE), bytes]))]),
);

/** Extensions are what a spreadsheet sees at the very start of a cell. */
export const HOSTILE_EXTENSIONS = ["=1+1", "+1", "-2+3", "@sum(a1)", "'quoted", "log"];

const BEYOND_DOUBLE = 9_007_199_254_740_993n;

function entry(id, path, overrides = {}) {
  return {
    ...FIXTURE_ENTRY,
    id,
    parentId: "41",
    path,
    kind: "file",
    linkCount: 1n,
    apparentBytes: 4096n,
    allocatedBytes: 4096n,
    ...overrides,
  };
}

export const FINDING_UNKNOWN = {
  id: "rules:formula",
  providerId: "rules",
  providerVersion: 1,
  category: "temporary",
  title: "=HYPERLINK(\"http://example.invalid\",\"click\")",
  evidence: ["A rule somebody wrote."],
  paths: [HOSTILE_PATHS.get("formula"), HOSTILE_PATHS.get("script")],
  size: { basis: "unknown", explanation: "No stored scan covers this path." },
  confidence: "observed",
  capability: { status: "available", explanation: "The directory was read." },
  availableActionIds: ["trash"],
  active: false,
};

export const FINDING_MEASURED = {
  id: "cache.language:cargo-registry",
  providerId: "cache.language",
  providerVersion: 1,
  category: "language-cache",
  title: "Cargo registry cache",
  evidence: ["Downloaded crate sources and their index."],
  paths: [rawPath("/home/example/.cargo/registry")],
  size: { bytes: BEYOND_DOUBLE, basis: "measured-allocated", explanation: "Blocks on disk, from the scan index." },
  confidence: "observed",
  capability: { status: "available", explanation: "The directory was read." },
  availableActionIds: ["trash"],
  active: false,
};

export function footprintSummary(overrides = {}) {
  return {
    findings: [FINDING_MEASURED, FINDING_UNKNOWN],
    providers: [
      { providerId: "cache.language", version: 1, capability: { status: "available", explanation: "8 cache roots exist." }, findings: 1, complete: true, ran: true },
      { providerId: "rules", version: 1, capability: { status: "available", explanation: "<b>one</b> rule" }, findings: 1, complete: true, ran: true },
    ],
    warnings: [],
    complete: true,
    categoryTotals: [
      { category: "language-cache", findings: 1, bytes: BEYOND_DOUBLE, unmeasured: 0, nested: 0 },
      { category: "temporary", findings: 1, bytes: 0n, unmeasured: 1, nested: 0 },
    ],
    measured: true,
    capability: { status: "available", explanation: "2 of 2 detectors ran." },
    ...overrides,
  };
}

/** A report with every section included, every name hostile, and one byte count past 2^53. */
export function hostileReport(overrides = {}) {
  const entries = [
    { ...FIXTURE_ENTRY, path: rawPath("/home/example/projects"), allocatedBytes: BEYOND_DOUBLE, apparentBytes: BEYOND_DOUBLE, childEntries: 14n },
    ...[...HOSTILE_PATHS.values()].map((path, index) => entry(String(9300 + index), path)),
    entry("9400", rawPath("/home/example/projects/second-name"), { shared: true }),
  ];
  return {
    generatedAt: new Date("2026-09-29T08:15:04.117Z"),
    version: "1.2.3",
    complete: true,
    capacity: {
      ...FIXTURE_VIEW,
      filesystems: [
        ...FIXTURE_VIEW.filesystems,
        {
          ...FIXTURE_VIEW.filesystems[0],
          id: "fs-0-99",
          type: "fuse.sshfs",
          source: "=cmd|' /C calc'!A0<script>",
          mounts: [HOSTILE_PATHS.get("script")],
          totalInodes: undefined,
          freeInodes: undefined,
        },
      ],
      alerts: [{ filesystemId: "fs-259-2", kind: "low-space", usedPercent: 95, thresholdPercent: 90, message: "/ is 95% full <b>now</b>." }],
    },
    scan: {
      included: true,
      complete: true,
      warnings: [],
      subject: rawPath("/home/example/projects"),
      snapshot: FIXTURE_SNAPSHOT,
      largest: { limit: 50, entries, more: true },
      // Every hostile name reaches each table the HTML draws from the index.
      children: { limit: 50, entries, more: true },
      largestFiles: { limit: 50, entries, more: true },
      typeTotals: HOSTILE_EXTENSIONS.map((extension, index) => ({
        extension,
        entries: BigInt(index + 1),
        allocatedBytes: 4096n * BigInt(index + 1),
        apparentBytes: 4000n * BigInt(index + 1),
      })).concat([{ extension: "", entries: 2n, allocatedBytes: 8192n, apparentBytes: 100n }]),
    },
    findings: { included: true, complete: true, warnings: [], summary: footprintSummary() },
    ...overrides,
  };
}
