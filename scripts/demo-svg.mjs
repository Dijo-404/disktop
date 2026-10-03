#!/usr/bin/env node
/**
 * Draw the README demo: real TUI frames, rendered by the same views and the
 * same 256-colour palette the terminal gets, cycled as an animated SVG.
 *
 * The data is a fixed, made-up machine so the image never shows anybody's
 * real filesystem. Run after `npm run build`:
 *
 *   node scripts/demo-svg.mjs docs/demo.svg
 */
import { writeFileSync } from "node:fs";
import { serializeLine } from "../dist/tui/render.js";
import { renderScreen } from "../dist/tui/screen.js";
import { initialState } from "../dist/tui/state.js";
import { buildTheme } from "../dist/tui/themes.js";

const COLUMNS = 80;
const ROWS = 24;
const CELL_WIDTH = 8.4;
const CELL_HEIGHT = 17;
const FONT_SIZE = 14;
const PADDING = 14;
const BACKGROUND = "#0d1117";
const FOREGROUND = "#c9d1d9";
const SECONDS_PER_FRAME = 4;

const NOW = Date.parse("2026-10-03T10:00:00Z");
const HOME = "/home/ada";
const GiB = 1024n ** 3n;
const MiB = 1024n ** 2n;

const path = (display) => ({ bytesBase64: Buffer.from(display).toString("base64"), display, utf8: display });

const filesystems = [
  {
    id: "fs-259-2", type: "ext4", source: "/dev/nvme0n1p2", mounts: [path("/"), path("/home")],
    totalBytes: 953n * GiB, freeBytes: 140n * GiB, availableBytes: 92n * GiB,
    totalInodes: 61_054_976n, freeInodes: 36_120_993n, network: false, removable: false, readOnly: false, deviceId: "nvme0n1",
  },
  {
    id: "fs-259-1", type: "vfat", source: "/dev/nvme0n1p1", mounts: [path("/boot")],
    totalBytes: 1022n * MiB, freeBytes: 904n * MiB, availableBytes: 904n * MiB, network: false, removable: false, deviceId: "nvme0n1",
  },
  {
    id: "fs-8-17", type: "exfat", source: "/dev/sda1", mounts: [path("/media/ada/backup")],
    totalBytes: 1863n * GiB, freeBytes: 412n * GiB, availableBytes: 412n * GiB, network: false, removable: true, deviceId: "sda",
  },
  {
    id: "fs-0-48", type: "nfs4", source: "nas:/archive", mounts: [path("/mnt/archive")],
    totalBytes: 7450n * GiB, freeBytes: 3100n * GiB, availableBytes: 3100n * GiB, network: true, removable: false,
  },
];

const view = {
  capability: { status: "available", explanation: "" },
  devices: [
    { id: "nvme0n1", name: "nvme0n1", kind: "ssd", removable: false, sizeBytes: 954n * GiB, model: "Samsung SSD 980 1TB", transport: "nvme", partitions: ["nvme0n1p1", "nvme0n1p2"] },
    { id: "sda", name: "sda", kind: "hdd", removable: true, sizeBytes: 1863n * GiB, model: "WD Elements", transport: "usb", partitions: ["sda1"] },
  ],
  filesystems,
  alerts: [{ filesystemId: "fs-259-2", kind: "low-space", usedPercent: 90, thresholdPercent: 90, message: "/ is 90% used: 92.0 GiB left of 953.0 GiB." }],
  warnings: [],
  complete: true,
};

let id = 1000;
const entry = (display, kind, allocated, days, extra = {}) => ({
  id: String((id += 1)), parentId: "41", path: path(display), kind, device: 2049n, inode: BigInt(id), mountId: "29", linkCount: 1n,
  apparentBytes: allocated, allocatedBytes: allocated, ownerId: 1000n,
  modifiedNanoseconds: BigInt(NOW - days * 86_400_000) * 1_000_000n, shared: false,
  ...(kind === "directory" ? { childEntries: 40n } : {}), ...extra,
});

const projects = entry(`${HOME}/projects`, "directory", 96n * GiB, 0, { id: "41", childEntries: 7n });
const snapshot = {
  version: 1, id: "snap-demo", scanId: "scan-demo", scannedAt: new Date(NOW - 2 * 3_600_000).toISOString(),
  scope: { roots: [projects.path], excludes: [], accounting: "allocated", crossFilesystems: false, filesystems: ["fs-259-2"] },
  totals: { allocatedBytes: 96n * GiB, apparentBytes: 94n * GiB, sharedBytes: 0n },
  completeness: { complete: true, scannedEntries: 1_284_311n, inaccessibleDirectories: 0n, excludedMounts: [], warnings: [] },
  directories: [],
};
const children = [
  entry(`${HOME}/projects/ml-experiments`, "directory", 38n * GiB, 2),
  entry(`${HOME}/projects/android-sdk`, "directory", 21n * GiB, 41),
  entry(`${HOME}/projects/webapp`, "directory", 14n * GiB, 1),
  entry(`${HOME}/projects/vm-images`, "directory", 11n * GiB, 120),
  entry(`${HOME}/projects/datasets.tar.zst`, "file", 6n * GiB, 300),
  entry(`${HOME}/projects/rust-tools`, "directory", 4n * GiB, 9),
  entry(`${HOME}/projects/notes`, "directory", 12n * MiB, 0),
];

const finding = (findingId, category, title, bytes, extra = {}) => ({
  id: findingId, providerId: findingId.split(":")[0], providerVersion: 1, category, title,
  evidence: [`${title}.`], paths: [path(`${HOME}/${findingId.split(":")[1]}`)],
  size: { bytes, basis: "measured-allocated", explanation: "Blocks on disk, measured by the scan that covered this path." },
  confidence: "observed", capability: { status: "available", explanation: "" }, availableActionIds: ["trash", "permanent"],
  regenerationCost: "Rebuilt by the next install or build.", active: false, ...extra,
});

const summary = {
  findings: [
    finding("dev.artifacts:projects/webapp/node_modules", "project-artifact", "node_modules in 9 projects", 12n * GiB),
    finding("dev.artifacts:projects/rust-tools/target", "project-artifact", "Rust target/ in 4 projects", 9n * GiB),
    finding("caches.ai:.cache/huggingface", "ai-cache", "Hugging Face model cache", 7n * GiB),
    finding("managers.containers:docker-build", "container-data", "Docker build cache nothing refers to", 5n * GiB, {
      paths: [], managerScope: "docker builder prune --force", availableActionIds: ["manager"],
      size: { bytes: 5n * GiB, basis: "manager-reported", explanation: "Docker's own estimate." },
    }),
    finding("caches.language:.cache/pip", "language-cache", "pip download cache", 2n * GiB),
    finding("caches.browser:.cache/mozilla", "browser-cache", "Firefox cache", 900n * MiB, { active: true }),
    finding("managers.package-cache:pacman", "package-cache", "Cached pacman packages", 2n * GiB, {
      paths: [], managerScope: "pacman -Sc", availableActionIds: ["manager"],
      size: { bytes: 2n * GiB, basis: "manager-reported", explanation: "pacman's cache size." },
    }),
    finding("storage.swap:/swapfile", "swap", "Swap file /swapfile", 8n * GiB, { availableActionIds: [], active: true }),
  ],
  providers: Array.from({ length: 38 }, (_, index) => ({ providerId: `p${index}`, version: 1, capability: { status: "available", explanation: "" }, findings: 1, complete: true, ran: true })),
  warnings: [], complete: true, categoryTotals: [], measured: true, capability: { status: "available", explanation: "" },
};

const plan = {
  id: "plan-demo", operation: "trash", createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 3_600_000).toISOString(),
  providerId: "dev.artifacts", scopeSummary: "9 node_modules directories under ~/projects", reversibility: "undo-from-trash", permission: "user",
  exactItemCount: 9n, selectedBytes: 12n * GiB,
  entries: ["webapp", "webapp/admin", "api", "site", "docs", "cli", "design-system", "mobile", "infra"].map((name) => ({
    path: path(`${HOME}/projects/${name}/node_modules`), expected: { device: 1n, inode: 1n, mountId: "1", kind: "directory", apparentBytes: 1n, modifiedNanoseconds: 1n }, reviewedBytes: (12n * GiB) / 9n,
  })),
  warnings: ["A Trash move on the same filesystem usually frees nothing until Trash is emptied."],
};

const base = initialState(view, "iec");
const frames = [
  base,
  {
    ...base, tab: "Explore",
    explore: {
      ...base.explore, root: projects.path, snapshot, directory: { path: projects.path, id: "41", entry: projects },
      rows: children.map((child) => ({ kind: "entry", entry: child })),
      typeTotals: [
        { extension: "safetensors", entries: 40n, allocatedBytes: 31n * GiB, apparentBytes: 31n * GiB },
        { extension: "img", entries: 6n, allocatedBytes: 19n * GiB, apparentBytes: 19n * GiB },
        { extension: "js", entries: 90_000n, allocatedBytes: 9n * GiB, apparentBytes: 9n * GiB },
        { extension: "zst", entries: 3n, allocatedBytes: 6n * GiB, apparentBytes: 6n * GiB },
        { extension: "so", entries: 900n, allocatedBytes: 4n * GiB, apparentBytes: 4n * GiB },
        { extension: "", entries: 9_000n, allocatedBytes: 27n * GiB, apparentBytes: 27n * GiB },
      ],
      trend: { values: [71n, 74n, 80n, 83n, 90n, 96n].map((value) => value * GiB), since: "Aug 4", delta: 25n * GiB },
      growth: new Map([[children[0].path.bytesBase64, 6n * GiB], [children[2].path.bytesBase64, 2n * GiB]]),
    },
  },
  { ...base, tab: "Clean", findings: { ...base.findings, summary, loadedAt: NOW - 60_000 } },
  { ...base, tab: "Clean", findings: { ...base.findings, summary, loadedAt: NOW - 60_000 }, dialog: { kind: "review", plan, alternatives: ["trash", "permanent"], typed: "", origin: "finding", findingId: "x" } },
];

const theme = buildTheme("256", true);

function xterm256(index) {
  const basic = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];
  if (index < 16) {
    return basic[index];
  }
  if (index < 232) {
    const value = index - 16;
    const level = (component) => (component === 0 ? 0 : 55 + component * 40);
    const [r, g, b] = [Math.floor(value / 36), Math.floor((value % 36) / 6), value % 6].map(level);
    return `#${[r, g, b].map((component) => component.toString(16).padStart(2, "0")).join("")}`;
  }
  const grey = 8 + (index - 232) * 10;
  return `#${grey.toString(16).padStart(2, "0").repeat(3)}`;
}

/** Turn the renderer's own output back into styled cells, so the image is exactly what a terminal gets. */
function parseRow(serialized) {
  const runs = [];
  let style = { fg: FOREGROUND, bg: undefined, bold: false, underline: false };
  for (const part of serialized.split(/(\u001b\[[0-9;]*m)/)) {
    const sgr = /^\u001b\[([0-9;]*)m$/.exec(part);
    if (sgr === null) {
      if (part !== "") runs.push({ text: part, ...style });
      continue;
    }
    const codes = sgr[1].split(";").filter((code) => code !== "").map(Number);
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index];
      if (code === 0) style = { fg: FOREGROUND, bg: undefined, bold: false, underline: false };
      else if (code === 1) style = { ...style, bold: true };
      else if (code === 4) style = { ...style, underline: true };
      else if (code === 38 && codes[index + 1] === 5) { style = { ...style, fg: xterm256(codes[index + 2]) }; index += 2; }
      else if (code === 48 && codes[index + 1] === 5) { style = { ...style, bg: xterm256(codes[index + 2]) }; index += 2; }
    }
  }
  return runs;
}

const escapeXml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function frameSvg(state, index) {
  const frame = renderScreen(state, { columns: COLUMNS, rows: ROWS }, { theme, now: NOW, threshold: 90, home: HOME });
  const parts = [];
  for (const [row, line] of frame.lines.entries()) {
    let column = 0;
    const y = PADDING + row * CELL_HEIGHT;
    for (const run of parseRow(serializeLine(line, COLUMNS, theme))) {
      const width = [...run.text].length;
      const x = PADDING + column * CELL_WIDTH;
      if (run.bg !== undefined) {
        parts.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${(width * CELL_WIDTH).toFixed(1)}" height="${CELL_HEIGHT}" fill="${run.bg}"/>`);
      }
      if (run.text.trim() !== "") {
        const weight = run.bold ? ' font-weight="bold"' : "";
        const decoration = run.underline ? ' text-decoration="underline"' : "";
        parts.push(`<text x="${x.toFixed(1)}" y="${y + CELL_HEIGHT - 4}" fill="${run.fg}"${weight}${decoration} textLength="${(width * CELL_WIDTH).toFixed(1)}" lengthAdjust="spacingAndGlyphs">${escapeXml(run.text)}</text>`);
      }
      column += width;
    }
  }
  return `<g class="frame f${index}">${parts.join("")}</g>`;
}

const width = PADDING * 2 + COLUMNS * CELL_WIDTH;
const height = PADDING * 2 + ROWS * CELL_HEIGHT;
const total = frames.length * SECONDS_PER_FRAME;
const share = 100 / frames.length;
const keyframes = frames
  .map((_, index) => {
    const start = (index * share).toFixed(2);
    const end = ((index + 1) * share - 0.5).toFixed(2);
    return `.f${index}{animation:f${index} ${total}s infinite}@keyframes f${index}{0%{opacity:0}${start}%{opacity:${index === 0 ? 1 : 0}}${(index * share + 0.01).toFixed(2)}%{opacity:1}${end}%{opacity:1}${((index + 1) * share).toFixed(2)}%{opacity:0}100%{opacity:0}}`;
  })
  .join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(0)}" height="${height}" viewBox="0 0 ${width.toFixed(0)} ${height}" role="img" aria-label="Disktop terminal UI: disks, explore, clean, and a reviewed plan">
<style>text{font-family:"JetBrains Mono","DejaVu Sans Mono",Menlo,Consolas,monospace;font-size:${FONT_SIZE}px;white-space:pre}.frame{opacity:0}${keyframes}</style>
<rect width="100%" height="100%" rx="8" fill="${BACKGROUND}"/>
${frames.map(frameSvg).join("\n")}
</svg>
`;

const output = process.argv[2] ?? "docs/demo.svg";
writeFileSync(output, svg);
process.stdout.write(`${output}: ${frames.length} frames, ${svg.length} bytes\n`);
