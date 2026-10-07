import type { Filesystem, StorageDevice, StorageVolume } from "../../domain/models.js";
import { formatBytes, usedPercentOfInodes, usedPercentOfSpace } from "../../domain/sizes.js";
import { LineBuilder, type ScreenLine } from "../frame.js";
import { diskRows } from "../state.js";
import { cellWidth, groupDigits, padEnd, padStart, truncate, truncateMiddle } from "../text.js";
import { barSpans, stackedBarSpans, usageStyle } from "../widgets/bars.js";
import { ruleLine } from "../widgets/chrome.js";
import { emptyState, listWindow, type ViewContext, type ViewOutput } from "./common.js";

interface Columns {
  readonly mount: number;
  readonly type: number;
  readonly size: number;
  readonly bar: number;
  readonly free: number;
  readonly inodes: number;
}

/**
 * Narrow terminals lose decoration before data: the inode column goes first,
 * then the bar shrinks and goes, then the type. Mount, used share, and free
 * space survive at any width the TUI will run at.
 */
function columnsFor(width: number): Columns {
  const inodes = width >= 78 ? 7 : 0;
  const type = width >= 58 ? 8 : 0;
  const bar = width >= 72 ? 16 : width >= 60 ? 10 : 0;
  const size = width >= 50 ? 11 : 0;
  const free = 11;
  const fixed = 2 + type + size + (bar > 0 ? bar + 1 : 0) + 5 + free + inodes + 1;
  return { mount: Math.max(6, width - fixed), type, size, bar, free, inodes };
}

export function renderDisks(context: ViewContext): ViewOutput {
  const { state, theme, width, height, top, threshold } = context;
  const view = state.disks.view;
  const lines: ScreenLine[] = [];
  const hits: ViewOutput["hits"][number][] = [];
  const columns = columnsFor(width);

  const rows = diskRows(view);
  if (rows.length === 0) {
    return {
      lines: emptyState(
        [
          "No filesystem could be inspected.",
          view.capability.status === "available" ? "Nothing is mounted that Disktop can read." : view.capability.explanation,
          ...view.warnings.slice(0, 3).map((warning) => warning.message),
        ],
        width,
        height,
        theme,
      ),
      hits: [],
      hints: [["r", "refresh"], ["q", "quit"]],
    };
  }

  const detailHeight = height >= 16 ? 6 : height >= 11 ? 3 : 0;
  const overview = new LineBuilder(width).add(" Storage ", "title").add(`${view.devices.length} drive${view.devices.length === 1 ? "" : "s"}`, "strong");
  const kinds = ["ssd", "hdd", "unknown"] as const;
  for (const kind of kinds) {
    const count = view.devices.filter((device) => device.kind === kind).length;
    if (count > 0) overview.add(`${theme.glyphs.separator}${count} ${kind === "unknown" ? "other" : kind.toUpperCase()}`, "dim");
  }
  overview.addRight(`${rows.length} storage entries `, "muted");
  lines.push(overview.build());
  const header = new LineBuilder(width).add("  ").add(padEnd("MOUNT / VOLUME", columns.mount, theme.glyphs.ellipsis), "heading");
  if (columns.type > 0) header.add(padEnd("TYPE", columns.type), "heading");
  if (columns.size > 0) header.add(padStart("SIZE", columns.size - 1), "heading").add(" ");
  if (columns.bar > 0) header.add(" ").add(padEnd("USED", columns.bar), "heading");
  header.add(padStart("USE%", 5), "heading");
  header.add(padStart("FREE", columns.free), "heading");
  if (columns.inodes > 0) header.add(padStart("INODE", columns.inodes), "heading");
  lines.push(header.build());

  const listRows = Math.max(1, height - 2 - detailHeight);
  const rowCount = rows.length;
  const window = listWindow(state.disks.selected, rowCount, listRows);
  for (let index = window.start; index < window.end; index += 1) {
    const selected = index === state.disks.selected;
    hits.push({ row: top + lines.length, from: 0, to: width, action: { kind: "row", index } });
    const row = rows[index];
    lines.push(
      row?.kind === "volume"
        ? unmountedRow(row.volume, selected, columns, context)
        : filesystemRow((row as { kind: "filesystem"; filesystem: Filesystem }).filesystem, selected, columns, context),
    );
  }
  while (lines.length < 2 + listRows) {
    lines.push({ spans: [] });
  }

  if (detailHeight > 0) {
    const row = rows[state.disks.selected];
    const selected = row?.kind === "filesystem" ? row.filesystem : undefined;
    const volume = row?.kind === "volume" ? row.volume : undefined;
    const detail =
      selected !== undefined
        ? detailLines(selected, view.devices, detailHeight, context)
        : volume !== undefined
          ? unmountedDetailLines(volume, view.devices, detailHeight, context)
          : [];
    for (const line of detail) {
      lines.push(line);
    }
  }

  const devices = view.devices.length;
  const status = new LineBuilder(width)
    .add(" ")
    .add(view.complete ? theme.glyphs.ok : theme.glyphs.warn, view.complete ? "ok" : "warn")
    .add(` ${view.filesystems.length} filesystem${view.filesystems.length === 1 ? "" : "s"} on ${devices} device${devices === 1 ? "" : "s"}`, "dim")
    .add(rows.filter((row) => row.kind === "volume" && (row.volume.state === "unmounted" || row.volume.state === "locked")).length === 0 ? "" : `${theme.glyphs.separator}${rows.filter((row) => row.kind === "volume" && (row.volume.state === "unmounted" || row.volume.state === "locked")).length} not mounted`, "dim")
    .add(`${theme.glyphs.separator}alert at ${threshold}% used`, "dim")
    .add(view.complete ? "" : `${theme.glyphs.separator}${view.warnings.length} reading(s) missing`, "warn")
    .build();
  return {
    lines,
    hits,
    status,
    hints: [
      ["j/k", "move"],
      [theme.glyphs.enter, "explore"],
      ["S", "scan"],
      ["r", "refresh"],
      ["U", "units"],
      ["1-6", "tabs"],
      ["q", "quit"],
    ],
  };
}

function filesystemRow(filesystem: Filesystem, selected: boolean, columns: Columns, context: ViewContext): ScreenLine {
  const { state, theme, width, threshold } = context;
  const alerting = state.disks.view.alerts.some((alert) => alert.filesystemId === filesystem.id);
  const percent = usedPercentOfSpace(filesystem.totalBytes, filesystem.freeBytes, filesystem.availableBytes);
  const line = new LineBuilder(width);
  line.add(selected ? `${theme.glyphs.pointer} ` : "  ", "accent");

  // A filesystem mounted in several places is one row; the first mount names
  // it and the count says there are more. The detail panel lists them all.
  const mount = filesystem.mounts[0]?.display ?? filesystem.source;
  const more = filesystem.mounts.length > 1 ? ` +${filesystem.mounts.length - 1}` : "";
  const flags = [filesystem.removable ? "removable" : "", filesystem.network ? "network" : "", filesystem.readOnly === true ? "ro" : ""]
    .filter((flag) => flag !== "")
    .join(",");
  // The mount is the identity of the row, so flags give way to it, never the reverse.
  const flagText = flags === "" ? "" : ` [${flags}]`;
  const mountText = truncateMiddle(mount, columns.mount - 1 - cellWidth(more), theme.glyphs.ellipsis);
  line.add(mountText, alerting ? "danger" : "strong").add(more, "muted");
  if (flagText !== "" && columns.mount - 1 - cellWidth(mountText) - cellWidth(more) >= cellWidth(flagText)) {
    line.add(flagText, "muted");
  }
  line.padTo(2 + columns.mount);
  if (columns.type > 0) line.add(padEnd(filesystem.type, columns.type - 1, theme.glyphs.ellipsis), "dim").add(" ");
  if (columns.size > 0) line.add(padStart(formatBytes(filesystem.totalBytes, state.units), columns.size - 1)).add(" ");
  if (columns.bar > 0) {
    line.add(" ");
    for (const span of barSpans(percent, columns.bar, theme, usageStyle(percent, threshold))) {
      line.add(span.text, span.style);
    }
  }
  line.add(padStart(`${percent}%`, 5), percent >= threshold ? "danger" : percent >= threshold - 10 ? "warn" : "normal");
  line.add(padStart(formatBytes(filesystem.availableBytes, state.units), columns.free), "strong");
  if (columns.inodes > 0) {
    const inodes =
      filesystem.totalInodes === undefined || filesystem.freeInodes === undefined || filesystem.totalInodes === 0n
        ? "-"
        : `${usedPercentOfInodes(filesystem.totalInodes, filesystem.freeInodes)}%`;
    line.add(padStart(inodes, columns.inodes), "dim");
  }
  return line.build({ selected });
}

/**
 * A partition with data on it that nothing has mounted. Its bytes are real,
 * but no filesystem reports them, so the row says it cannot be measured
 * rather than showing a size beside an empty bar.
 */
function unmountedRow(volume: StorageVolume, selected: boolean, columns: Columns, context: ViewContext): ScreenLine {
  const { state, theme, width } = context;
  const line = new LineBuilder(width);
  line.add(selected ? `${theme.glyphs.pointer} ` : "  ", "accent");
  const labelled = volume.label === undefined ? undefined : `${volume.label} (${volume.id})`;
  const name = labelled !== undefined && cellWidth(labelled) < columns.mount ? labelled : volume.label ?? volume.id;
  line.add(truncateMiddle(name, columns.mount - 1, theme.glyphs.ellipsis), "muted");
  line.padTo(2 + columns.mount);
  if (columns.type > 0) line.add(padEnd(volumeType(volume), columns.type - 1, theme.glyphs.ellipsis), "dim").add(" ");
  if (columns.size > 0) line.add(padStart(formatBytes(volume.sizeBytes, state.units), columns.size - 1), "dim").add(" ");
  const status = volume.state === "locked" ? "locked" : volume.state === "swap" ? "swap" : volume.state === "in-use" ? "in use" : volume.state === "unknown" ? "usage unknown" : volume.state === "mounted" ? "usage unreadable" : "not mounted";
  const room = (columns.bar > 0 ? columns.bar + 1 : 0) + 5 + columns.free;
  line.add(padStart(status, room), volume.state === "locked" ? "warn" : "muted");
  return line.build({ selected });
}

function volumeType(volume: StorageVolume): string {
  return volume.filesystemType === "crypto_LUKS" ? "LUKS" : volume.filesystemType ?? volume.type;
}

function unmountedDetailLines(volume: StorageVolume, devices: readonly StorageDevice[], height: number, context: ViewContext): ScreenLine[] {
  const { state, theme, width } = context;
  const lines: ScreenLine[] = [ruleLine(truncateMiddle(volume.label ?? volume.devicePath, Math.max(8, width - 12), theme.glyphs.ellipsis), width, theme)];
  const label = (text: string): LineBuilder => new LineBuilder(width).add("  ").add(padEnd(text, 9), "muted");
  const device = devices.find((candidate) => candidate.id === volume.deviceId);
  const parts = [
    volume.devicePath,
    volumeType(volume),
    formatBytes(volume.sizeBytes, state.units),
    device === undefined ? undefined : `on ${device.model ?? device.name}`,
  ].filter((part): part is string => part !== undefined);
  lines.push(label("Device").add(truncate(parts.join(theme.glyphs.separator), width - 13, theme.glyphs.ellipsis)).build());
  const messages: Readonly<Record<StorageVolume["state"], readonly [string, string]>> = {
    locked: ["Encrypted and locked: its contents and usage are unknown.", "Unlock and mount it in your file manager, then press r."],
    unmounted: ["Not mounted: how full it is is unknown.", "Mount it in your file manager, then press r to measure it."],
    mounted: ["Mounted, but its capacity could not be read.", "Check mount permissions and device availability, then press r."],
    swap: ["Swap storage: this is used for virtual memory, not files.", "Disktop lists it for inventory and never offers to clean it."],
    "in-use": ["Used by another storage layer, such as RAID or LVM.", "Its mounted child volumes appear separately; do not format it."],
    unknown: ["No readable filesystem signature: its contents are unknown.", "Inspect it with your system's disk utility; do not assume it is empty."],
  };
  const [description, next] = messages[volume.state];
  lines.push(label("State").add(description, volume.state === "locked" || volume.state === "unknown" ? "warn" : "dim").build());
  if (volume.mounts.length > 0) lines.push(label("Mounts").add(volume.mounts.map((mount) => mount.display).join(", "), "dim").build());
  lines.push(label("Next").add(next, "dim").build());
  return lines.slice(0, height);
}

function deviceFor(filesystem: Filesystem, devices: readonly StorageDevice[]): StorageDevice | undefined {
  if (filesystem.deviceId === undefined) {
    return undefined;
  }
  return devices.find((device) => device.id === filesystem.deviceId || device.name === filesystem.deviceId);
}

/**
 * The selected filesystem in detail. The space bar is stacked: used, the
 * blocks reserved for root, and what this user can still write. The reserved
 * share is why `df` and a naive used/total disagree, so it is shown rather
 * than folded into either side.
 */
function detailLines(filesystem: Filesystem, devices: readonly StorageDevice[], height: number, context: ViewContext): ScreenLine[] {
  const { state, theme, width, threshold } = context;
  const units = state.units;
  const lines: ScreenLine[] = [];
  const mount = filesystem.mounts[0]?.display ?? filesystem.source;
  lines.push(ruleLine(truncateMiddle(mount, Math.max(8, width - 12), theme.glyphs.ellipsis), width, theme));

  const label = (text: string): LineBuilder => new LineBuilder(width).add("  ").add(padEnd(text, 9), "muted");
  const used = filesystem.totalBytes > filesystem.freeBytes ? filesystem.totalBytes - filesystem.freeBytes : 0n;
  const reserved = filesystem.freeBytes > filesystem.availableBytes ? filesystem.freeBytes - filesystem.availableBytes : 0n;
  const percent = usedPercentOfSpace(filesystem.totalBytes, filesystem.freeBytes, filesystem.availableBytes);
  const barWidth = Math.max(10, Math.min(30, width - 66));

  const space = label("Space");
  for (const span of stackedBarSpans(
    [
      { value: used, style: usageStyle(percent, threshold) },
      { value: reserved, style: "barReserved", glyph: theme.glyphs.barShade },
    ],
    filesystem.totalBytes,
    barWidth,
    theme,
  )) {
    space.add(span.text, span.style);
  }
  space
    .add("  used ", "muted")
    .add(formatBytes(used, units), "strong")
    .add(reserved > 0n ? "  reserved " : "", "muted")
    .add(reserved > 0n ? formatBytes(reserved, units) : "", "dim")
    .add("  free ", "muted")
    .add(formatBytes(filesystem.availableBytes, units), "strong");
  lines.push(space.build());

  if (height >= 6) {
    const device = deviceFor(filesystem, devices);
    const line = label("Device");
    const parts = [
      filesystem.source,
      device?.model,
      device === undefined || device.kind === "unknown" ? undefined : device.kind.toUpperCase(),
      device?.transport,
      device === undefined ? undefined : formatBytes(device.sizeBytes, units),
    ].filter((part): part is string => part !== undefined && part !== "");
    line.add(truncate(parts.join(theme.glyphs.separator), width - 13, theme.glyphs.ellipsis));
    lines.push(line.build());

    const inodes = label("Inodes");
    if (filesystem.totalInodes === undefined || filesystem.freeInodes === undefined || filesystem.totalInodes === 0n) {
      inodes.add("not reported by this filesystem", "dim");
    } else {
      const inodePercent = usedPercentOfInodes(filesystem.totalInodes, filesystem.freeInodes);
      for (const span of barSpans(inodePercent, barWidth, theme, usageStyle(inodePercent, threshold))) {
        inodes.add(span.text, span.style);
      }
      inodes
        .add(`  ${inodePercent}% of ${groupDigits(filesystem.totalInodes)}`, "dim")
        .add(`  ${groupDigits(filesystem.freeInodes)} free`, "muted");
    }
    lines.push(inodes.build());

    const mounts = label("Mounts");
    mounts.add(truncateMiddle(filesystem.mounts.map((point) => point.display).join(", "), width - 13, theme.glyphs.ellipsis));
    const flags = [filesystem.type, filesystem.removable ? "removable" : "", filesystem.network ? "network" : "", filesystem.readOnly === true ? "read-only" : ""]
      .filter((flag) => flag !== "")
      .join(theme.glyphs.separator);
    mounts.addRight(flags, "muted", 1);
    lines.push(mounts.build());
  }

  const alert = state.disks.view.alerts.find((entry) => entry.filesystemId === filesystem.id);
  if (alert !== undefined) {
    lines.push(new LineBuilder(width).add(`  ${theme.glyphs.warn} `, "danger").add(alert.message, "danger").build());
  } else if (!state.disks.view.complete) {
    const warning = state.disks.view.warnings[0];
    lines.push(
      new LineBuilder(width)
        .add(`  ${theme.glyphs.warn} `, "warn")
        .add(`Incomplete: ${state.disks.view.warnings.length} reading(s) could not be taken${warning === undefined ? "" : ` (${warning.message})`}. Nothing is reported as zero.`, "warn")
        .build(),
    );
  }
  return lines.slice(0, height);
}

export { columnsFor as diskColumnsFor };
