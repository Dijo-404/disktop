import type { Capability } from "../../../domain/models.js";
import type { ManagerInventory, PackageInventoryPort } from "../../../ports/packages.js";
import type { ToolPort } from "../../../ports/providers.js";
import {
  parseDpkg,
  parseFlatpak,
  parseNpmGlobal,
  parsePacman,
  parsePip,
  parseRpm,
  parseSnap,
  type InstalledPackage,
} from "./parsers.js";

/**
 * One manager: a fixed argument vector, a parser, and a sentence saying what
 * the number it reports actually means.
 */
interface ManagerSpec {
  readonly manager: string;
  readonly tool: string;
  readonly commandArguments: readonly string[];
  readonly parse: (text: string) => readonly InstalledPackage[];
  readonly sizeMeaning: string;
}

const MANAGERS: readonly ManagerSpec[] = [
  {
    manager: "dpkg",
    tool: "dpkg-query",
    commandArguments: ["-W", "-f=${Package}\t${Installed-Size}\t${Status}\n"],
    parse: parseDpkg,
    sizeMeaning:
      "dpkg's Installed-Size: the unpacked size the package declares, which is not what it occupies on this filesystem.",
  },
  {
    manager: "rpm",
    tool: "rpm",
    commandArguments: ["-qa", "--qf", "%{NAME}\t%{SIZE}\n"],
    parse: parseRpm,
    sizeMeaning: "rpm's SIZE: the sum of the package's file sizes, not their blocks on disk.",
  },
  {
    manager: "pacman",
    tool: "pacman",
    commandArguments: ["-Qi"],
    parse: parsePacman,
    sizeMeaning: "pacman's Installed Size: the sum of the package's file sizes, not their blocks on disk.",
  },
  {
    manager: "snap",
    tool: "snap",
    commandArguments: ["list"],
    parse: parseSnap,
    sizeMeaning: "snap list reports no size, so these packages are counted and not measured.",
  },
  {
    manager: "flatpak",
    tool: "flatpak",
    commandArguments: ["list", "--columns=application,size,origin"],
    parse: parseFlatpak,
    sizeMeaning:
      "Flatpak's own figure, which is deduplicated across runtimes: removing one application frees less than its size.",
  },
  {
    manager: "npm",
    tool: "npm",
    commandArguments: ["ls", "-g", "--depth=0", "--json"],
    parse: parseNpmGlobal,
    sizeMeaning: "npm reports no size for a global package, so these are counted and not measured.",
  },
  {
    manager: "pip",
    tool: "pip",
    commandArguments: ["list", "--format=json"],
    parse: parsePip,
    sizeMeaning: "pip reports no size, so these packages are counted and not measured.",
  },
];

/**
 * Every package manager on this machine, asked once each.
 *
 * A manager that is absent, or that fails, keeps its row with the reason. A
 * count is only ever taken from a command that actually answered: inferring
 * "zero packages" from a failed command would be reporting an empty machine.
 */
export function createPackageInventory(tools: ToolPort): PackageInventoryPort {
  // One reading per process. A detector probes and then discovers, and asking
  // seven package managers twice doubles the slowest part of `disktop clean`
  // for an answer that cannot have changed in between.
  let reading: Promise<readonly ManagerInventory[]> | undefined;

  return {
    async list() {
      reading ??= (async () => {
        const inventories: ManagerInventory[] = [];
        for (const spec of MANAGERS) {
          inventories.push(await ask(tools, spec));
        }
        return inventories;
      })();
      return reading;
    },
  };
}

async function ask(tools: ToolPort, spec: ManagerSpec): Promise<ManagerInventory> {
  const outcome = await tools.run(spec.tool, spec.commandArguments);
  if (outcome.capability.status !== "available") {
    return { manager: spec.manager, capability: outcome.capability, packages: [], sizeMeaning: spec.sizeMeaning };
  }

  const packages = spec.parse(outcome.stdout);
  if (packages.length === 0 && outcome.stdout.trim() !== "") {
    // The command answered and the parser understood none of it, which is a
    // changed output format rather than a machine with no packages.
    const capability: Capability = {
      status: "missing-tool",
      explanation: `${spec.tool} answered in a format Disktop does not recognise, so its packages were not counted.`,
    };
    return { manager: spec.manager, capability, packages: [], sizeMeaning: spec.sizeMeaning };
  }

  return { manager: spec.manager, capability: outcome.capability, packages, sizeMeaning: spec.sizeMeaning };
}
