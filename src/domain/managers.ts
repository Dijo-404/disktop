import { sanitizeText } from "./paths.js";

export type ManagerAdapterId =
  | "apt"
  | "dnf"
  | "pacman"
  | "journald"
  | "snap"
  | "flatpak"
  | "docker"
  | "podman"
  | "kernels"
  | "tmpfiles";

export type ManagerActionId =
  | "apt.clean"
  | "dnf.clean-packages"
  | "pacman.clean-uninstalled"
  | "journald.vacuum"
  | "snap.remove-disabled"
  | "flatpak.remove-unused-user"
  | "flatpak.remove-unused-system"
  | "docker.remove-dangling-images"
  | "docker.remove-stopped-containers"
  | "docker.remove-anonymous-volumes"
  | "docker.prune-build-cache"
  | "podman.remove-dangling-images"
  | "podman.remove-stopped-containers"
  | "podman.remove-anonymous-volumes"
  | "kernels.dpkg-purge"
  | "kernels.rpm-erase"
  | "tmpfiles.clean-system"
  | "tmpfiles.clean-user"
  | "tmpfiles.clean-crash";

export type ManagerPrivilege = "user" | "root";

export interface ManagerCommand {
  readonly tool: string;
  readonly arguments: readonly string[];
}

export interface ManagerItem {
  readonly id: string;
  readonly bytes?: bigint;
}

export type ManagerCount =
  | { readonly kind: "exact" | "estimated"; readonly value: bigint }
  | { readonly kind: "unknown" };

/** How the selection was established: listed by Disktop, simulated by the manager, or neither. */
export type ManagerPreview = "listed" | "simulated" | "none";

export interface ManagerScope {
  readonly action: ManagerActionId;
  readonly adapter: ManagerAdapterId;
  readonly privilege: ManagerPrivilege;
  readonly parameters: Readonly<Record<string, string>>;
  readonly items: readonly ManagerItem[];
  readonly commands: readonly ManagerCommand[];
  readonly perItem: boolean;
  readonly count: ManagerCount;
  readonly estimatedBytes?: bigint;
  readonly preview: ManagerPreview;
}

export interface ManagerActionSpec {
  readonly action: ManagerActionId;
  readonly adapter: ManagerAdapterId;
  readonly privilege: ManagerPrivilege;
  /** One command per item, in item order, rather than one for the selection. */
  readonly perItem: boolean;
  /** The command names the items, so there has to be at least one. */
  readonly needsItems: boolean;
  /** Absent when the manager decides the selection itself and takes no items. */
  readonly itemPattern?: RegExp;
  readonly maxItems: number;
  readonly parameterPatterns: Readonly<Record<string, RegExp>>;
  readonly summary: string;
  readonly warnings: readonly string[];
  readonly regenerationCost?: string;
  commands(items: readonly string[], parameters: Readonly<Record<string, string>>): readonly ManagerCommand[];
}

export const MANAGER_TOOLS: readonly string[] = [
  "apt-get",
  "dpkg",
  "dnf",
  "rpm",
  "pacman",
  "journalctl",
  "snap",
  "flatpak",
  "docker",
  "podman",
  "systemd-tmpfiles",
];

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const HEX_ID = /^[0-9a-f]{64}$/;
const NOTHING: Readonly<Record<string, RegExp>> = {};

const fixed =
  (tool: string, ...commandArguments: string[]) =>
  (): readonly ManagerCommand[] => [{ tool, arguments: commandArguments }];

const eachItem =
  (tool: string, ...prefix: string[]) =>
  (items: readonly string[]): readonly ManagerCommand[] =>
    items.map((id) => ({ tool, arguments: [...prefix, id] }));

const CONTAINER_WARNING =
  "Docker and Podman refuse to remove anything still in use; Disktop does not force them.";

function containerActions(engine: "docker" | "podman"): readonly ManagerActionSpec[] {
  const name = engine === "docker" ? "Docker" : "Podman";
  return [
    {
      action: `${engine}.remove-dangling-images`,
      adapter: engine,
      privilege: "user",
      perItem: true,
      needsItems: true,
      itemPattern: IMAGE_ID,
      maxItems: 500,
      parameterPatterns: NOTHING,
      summary: `Remove ${name} images no tag or container refers to`,
      warnings: [CONTAINER_WARNING],
      regenerationCost: "Rebuilt or pulled again when something needs them.",
      commands: eachItem(engine, "image", "rm", "--"),
    },
    {
      action: `${engine}.remove-stopped-containers`,
      adapter: engine,
      privilege: "user",
      perItem: true,
      needsItems: true,
      itemPattern: HEX_ID,
      maxItems: 500,
      parameterPatterns: NOTHING,
      summary: `Remove stopped ${name} containers`,
      warnings: [
        CONTAINER_WARNING,
        "Anything a stopped container wrote outside a volume goes with it.",
      ],
      commands: eachItem(engine, "container", "rm", "--"),
    },
    {
      action: `${engine}.remove-anonymous-volumes`,
      adapter: engine,
      privilege: "user",
      perItem: true,
      needsItems: true,
      itemPattern: HEX_ID,
      maxItems: 500,
      parameterPatterns: NOTHING,
      summary: `Remove anonymous ${name} volumes no container uses`,
      warnings: [
        CONTAINER_WARNING,
        "Only volumes the engine created without a name are selected. A named volume is never part of this.",
      ],
      commands: eachItem(engine, "volume", "rm", "--"),
    },
  ] as ManagerActionSpec[];
}

const SPECS: readonly ManagerActionSpec[] = [
  {
    action: "apt.clean",
    adapter: "apt",
    privilege: "root",
    perItem: false,
    needsItems: false,
    itemPattern: /^[A-Za-z0-9][A-Za-z0-9+._~%:-]{0,254}\.deb$/,
    maxItems: 10_000,
    parameterPatterns: NOTHING,
    summary: "Remove the package files apt downloaded into /var/cache/apt/archives",
    warnings: [],
    regenerationCost: "apt downloads a package again the next time it installs or upgrades it.",
    commands: fixed("apt-get", "clean"),
  },
  {
    action: "dnf.clean-packages",
    adapter: "dnf",
    privilege: "root",
    perItem: false,
    needsItems: false,
    itemPattern: /^[A-Za-z0-9][A-Za-z0-9+._~:-]{0,254}\.rpm$/,
    maxItems: 10_000,
    parameterPatterns: NOTHING,
    summary: "Remove the package files dnf keeps in its cache",
    warnings: [],
    regenerationCost: "dnf downloads a package again the next time it installs or upgrades it.",
    commands: fixed("dnf", "clean", "packages"),
  },
  {
    action: "pacman.clean-uninstalled",
    adapter: "pacman",
    privilege: "root",
    perItem: false,
    needsItems: false,
    itemPattern: /^[A-Za-z0-9@_+][A-Za-z0-9@._+-]{0,254}\.pkg\.tar(\.[a-z0-9]+)?$/,
    maxItems: 10_000,
    parameterPatterns: NOTHING,
    summary: "Remove cached pacman packages that are not installed",
    warnings: ["pacman also drops the sync databases of repositories that are no longer configured."],
    regenerationCost: "A package removed from the cache can no longer be downgraded to without downloading it.",
    commands: fixed("pacman", "-Sc", "--noconfirm"),
  },
  {
    action: "journald.vacuum",
    adapter: "journald",
    privilege: "root",
    perItem: false,
    needsItems: false,
    maxItems: 0,
    parameterPatterns: { keepBytes: /^[1-9][0-9]{6,15}$/ },
    summary: "Remove archived journal files until the journal is below the size configured to keep",
    warnings: ["The active journal file is never removed; only sealed, archived ones are."],
    regenerationCost: "Log entries in the removed files are gone.",
    commands: (_items, parameters) => [
      { tool: "journalctl", arguments: [`--vacuum-size=${parameters.keepBytes ?? ""}`] },
    ],
  },
  {
    action: "snap.remove-disabled",
    adapter: "snap",
    privilege: "root",
    perItem: true,
    needsItems: true,
    itemPattern: /^[a-z0-9][a-z0-9-]{0,39}=[0-9]{1,10}$/,
    maxItems: 500,
    parameterPatterns: NOTHING,
    summary: "Remove snap revisions that are installed but disabled",
    warnings: ["A removed revision can no longer be reverted to."],
    commands: (items) =>
      items.map((id) => {
        const [name, revision] = id.split("=");
        return { tool: "snap", arguments: ["remove", name as string, `--revision=${revision as string}`] };
      }),
  },
  {
    action: "flatpak.remove-unused-user",
    adapter: "flatpak",
    privilege: "user",
    perItem: false,
    needsItems: false,
    maxItems: 0,
    parameterPatterns: NOTHING,
    summary: "Remove Flatpak runtimes and extensions no installed application uses, in your own installation",
    warnings: ["Flatpak decides what is unused; Disktop reports what it removed afterwards."],
    regenerationCost: "Installed again when an application that needs one is installed.",
    commands: fixed("flatpak", "uninstall", "--user", "--unused", "--noninteractive", "-y"),
  },
  {
    action: "flatpak.remove-unused-system",
    adapter: "flatpak",
    privilege: "root",
    perItem: false,
    needsItems: false,
    maxItems: 0,
    parameterPatterns: NOTHING,
    summary: "Remove Flatpak runtimes and extensions no installed application uses, in the system installation",
    warnings: ["Flatpak decides what is unused; Disktop reports what it removed afterwards."],
    regenerationCost: "Installed again when an application that needs one is installed.",
    commands: fixed("flatpak", "uninstall", "--system", "--unused", "--noninteractive", "-y"),
  },
  ...containerActions("docker"),
  {
    action: "docker.prune-build-cache",
    adapter: "docker",
    privilege: "user",
    perItem: false,
    needsItems: false,
    maxItems: 0,
    parameterPatterns: NOTHING,
    summary: "Remove Docker build cache no image refers to",
    warnings: ["Only dangling build cache is removed; cache an image still refers to stays."],
    regenerationCost: "The next build that needs those layers builds them again.",
    commands: fixed("docker", "builder", "prune", "--force"),
  },
  ...containerActions("podman"),
  {
    action: "kernels.dpkg-purge",
    adapter: "kernels",
    privilege: "root",
    perItem: false,
    needsItems: true,
    itemPattern: /^linux-[a-z0-9][a-z0-9.+-]{0,127}$/,
    maxItems: 64,
    parameterPatterns: NOTHING,
    summary: "Purge kernel packages that are neither running nor the newest installed",
    warnings: [
      "dpkg removes exactly these packages and refuses if anything else depends on them; it never removes anything else.",
    ],
    regenerationCost: "Reinstalled from the distribution's repositories, if they still carry that version.",
    commands: (items) => [{ tool: "dpkg", arguments: ["--purge", ...items] }],
  },
  {
    action: "kernels.rpm-erase",
    adapter: "kernels",
    privilege: "root",
    perItem: false,
    needsItems: true,
    itemPattern: /^kernel[a-z0-9-]*-[0-9][A-Za-z0-9._+-]{0,127}$/,
    maxItems: 64,
    parameterPatterns: NOTHING,
    summary: "Erase kernel packages that are neither running nor the newest installed",
    warnings: [
      "rpm removes exactly these packages and refuses if anything else depends on them; it never removes anything else.",
    ],
    regenerationCost: "Reinstalled from the distribution's repositories, if they still carry that version.",
    commands: (items) => [{ tool: "rpm", arguments: ["-e", "--", ...items] }],
  },
  {
    action: "tmpfiles.clean-system",
    adapter: "tmpfiles",
    privilege: "root",
    perItem: false,
    needsItems: false,
    maxItems: 0,
    parameterPatterns: NOTHING,
    summary: "Remove temporary files the system's tmpfiles.d age rules have retired",
    warnings: ["Only what this system's own tmpfiles.d rules allow is removed; Disktop picks no files."],
    commands: fixed("systemd-tmpfiles", "--clean"),
  },
  {
    action: "tmpfiles.clean-user",
    adapter: "tmpfiles",
    privilege: "user",
    perItem: false,
    needsItems: false,
    maxItems: 0,
    parameterPatterns: NOTHING,
    summary: "Remove your temporary files your user tmpfiles.d age rules have retired",
    warnings: ["Only what your own tmpfiles.d rules allow is removed; Disktop picks no files."],
    commands: fixed("systemd-tmpfiles", "--user", "--clean"),
  },
  {
    action: "tmpfiles.clean-crash",
    adapter: "tmpfiles",
    privilege: "root",
    perItem: false,
    needsItems: false,
    maxItems: 0,
    parameterPatterns: NOTHING,
    summary: "Remove crash reports and core dumps the system's tmpfiles.d age rules have retired",
    warnings: [
      "Only what this system's own tmpfiles.d age rules allow is removed under /var/crash and /var/lib/systemd/coredump; Disktop picks no files.",
    ],
    regenerationCost: "A core dump is only useful to whoever is debugging the crash that produced it.",
    commands: fixed("systemd-tmpfiles", "--clean", "--prefix=/var/crash", "--prefix=/var/lib/systemd/coredump"),
  },
];

export const MANAGER_ACTIONS: Readonly<Record<ManagerActionId, ManagerActionSpec>> = Object.freeze(
  Object.fromEntries(SPECS.map((spec) => [spec.action, spec])) as Record<ManagerActionId, ManagerActionSpec>,
);

export function isManagerAction(value: string): value is ManagerActionId {
  return Object.hasOwn(MANAGER_ACTIONS, value);
}

export interface ManagerScopeInput {
  readonly action: ManagerActionId;
  readonly items: readonly ManagerItem[];
  readonly parameters: Readonly<Record<string, string>>;
  readonly count: ManagerCount;
  readonly estimatedBytes?: bigint;
  readonly preview: ManagerPreview;
}

/** Validate a selection and derive the commands it runs. Throws on anything else. */
export function managerScope(input: ManagerScopeInput): ManagerScope {
  if (!isManagerAction(input.action)) {
    throw new RangeError(`'${String(input.action)}' is not a manager action Disktop knows`);
  }
  const spec = MANAGER_ACTIONS[input.action];

  if (input.items.length > spec.maxItems) {
    throw new RangeError(`${spec.action} takes at most ${spec.maxItems} items`);
  }
  const ids = input.items.map((item) => item.id);
  for (const item of input.items) {
    if (spec.itemPattern === undefined || !spec.itemPattern.test(item.id)) {
      throw new RangeError(`'${sanitizeText(item.id)}' is not an item ${spec.action} can name`);
    }
    if (item.bytes !== undefined && item.bytes < 0n) {
      throw new RangeError("An item cannot occupy negative bytes");
    }
  }
  if (new Set(ids).size !== ids.length) {
    throw new RangeError(`${spec.action} names the same item twice`);
  }
  if (spec.needsItems && ids.length === 0) {
    throw new RangeError(`${spec.action} has nothing to act on`);
  }

  const expected = Object.keys(spec.parameterPatterns).sort();
  const given = Object.keys(input.parameters).sort();
  if (expected.join("\u0000") !== given.join("\u0000")) {
    throw new RangeError(`${spec.action} takes the parameters ${expected.join(", ") || "none"}`);
  }
  for (const key of expected) {
    if (!(spec.parameterPatterns[key] as RegExp).test(input.parameters[key] as string)) {
      throw new RangeError(`'${key}' is not a value ${spec.action} accepts`);
    }
  }

  if (input.count.kind === "exact" && (ids.length === 0 || input.count.value !== BigInt(ids.length))) {
    throw new RangeError("An exact count is the number of reviewed items");
  }
  if (spec.perItem && input.count.kind !== "exact") {
    throw new RangeError(`${spec.action} acts on each reviewed item, so its count is exact`);
  }
  if (input.count.kind !== "unknown" && input.count.value < 0n) {
    throw new RangeError("A count cannot be negative");
  }
  if (input.estimatedBytes !== undefined && input.estimatedBytes < 0n) {
    throw new RangeError("An estimate cannot be negative");
  }

  const commands = spec.commands(ids, input.parameters);
  if (commands.length === 0 || commands.some((command) => !MANAGER_TOOLS.includes(command.tool))) {
    throw new RangeError(`${spec.action} derived a command outside the manager tools`);
  }

  return {
    action: spec.action,
    adapter: spec.adapter,
    privilege: spec.privilege,
    parameters: { ...input.parameters },
    items: input.items.map((item) => ({ ...item })),
    commands,
    perItem: spec.perItem,
    count: input.count,
    ...(input.estimatedBytes === undefined ? {} : { estimatedBytes: input.estimatedBytes }),
    preview: input.preview,
  };
}

export function describeCommand(command: ManagerCommand, privilege: ManagerPrivilege): string {
  return sanitizeText(`${privilege === "root" ? "sudo " : ""}${[command.tool, ...command.arguments].join(" ")}`);
}
