export interface CliOutput {
  stdout(message: string): void;
  stderr(message: string): void;
}

const plannedCommands = [
  "devices",
  "scan",
  "explore",
  "find",
  "clean",
  "undo",
  "history",
  "snapshots",
  "report",
  "alerts",
  "completion",
] as const;

const help = `Disktop: Linux terminal storage manager and analyzer

Status: development scaffold. Storage inspection and cleanup are not implemented.

Usage:
  disktop --help             Show this help
  disktop --version          Show the package version

Planned commands for the complete 1.0.0 release:
  devices    List devices, filesystems, free space, and health
  scan       Scan selected paths and save a snapshot
  explore    Sort and filter space usage
  find       Find duplicates, stale files, empty folders, and broken links
  clean      Review and apply cleanup plans
  undo       Restore an eligible Trash action
  history    Inspect the action journal
  snapshots  Compare or prune scan snapshots
  report     Export JSON, CSV, or HTML
  alerts     Check capacity and inode thresholds
  completion Generate shell completion scripts

No files are changed by this scaffold.
`;

/** Return an exit status; CLI output is injected so it can be tested without a terminal. */
export function runCli(args: readonly string[], version: string, output: CliOutput): number {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    output.stdout(help);
    return 0;
  }

  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    output.stdout(`${version}\n`);
    return 0;
  }

  const command = args[0];
  if (command === undefined) {
    output.stderr("Disktop TUI is not implemented yet. Run disktop --help.\n");
    return 2;
  }

  if (plannedCommands.includes(command as (typeof plannedCommands)[number]) || command === "--json") {
    output.stderr(`Disktop feature '${command}' is not implemented yet. Run disktop --help.\n`);
    return 2;
  }

  output.stderr(`Unknown Disktop command or option '${command}'. Run disktop --help.\n`);
  return 2;
}
