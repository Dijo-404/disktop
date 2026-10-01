import { findingSize, type Finding } from "../../domain/findings.js";
import type { Bytes, RawPath } from "../../domain/models.js";
import type { DiscoveryEnvironment, FindingProvider } from "../../ports/providers.js";
import {
  absolutePath,
  basename,
  buildFinding,
  childDirectories,
  exists,
  slugForPath,
  underHome,
} from "../support.js";

const ID = "storage.virtual-machines";
const VERSION = 1;

const IMAGE_SUFFIXES: readonly string[] = [".qcow2", ".vdi", ".vmdk", ".vhd", ".vhdx", ".img", ".raw", ".qed"];

/** Where the common hypervisors put their disk images. */
const IMAGE_ROOTS: readonly (readonly string[])[] = [
  ["VirtualBox VMs"],
  [".local", "share", "gnome-boxes", "images"],
  [".local", "share", "libvirt", "images"],
  [".local", "share", "containers", "podman-machine"],
  ["VMs"],
];

const SYSTEM_IMAGE_ROOTS: readonly string[] = ["/var/lib/libvirt/images"];

export interface VirtualMachineOptions {
  readonly systemImageRoots?: readonly string[];
}

/**
 * Virtual machine disk images.
 *
 * Two numbers matter and they differ: a sparse image claims a size it has not
 * allocated, so the finding reports the blocks on disk and says in its
 * explanation what the image claims. Whether a guest is running cannot be
 * established without privilege, so every image is uncertain and marked in
 * use: a disk image written while it is being deleted is a destroyed machine.
 */
export function createVirtualMachineProvider(options: VirtualMachineOptions = {}): FindingProvider {
  const systemRoots = (options.systemImageRoots ?? SYSTEM_IMAGE_ROOTS)
    .map(absolutePath)
    .filter((path): path is RawPath => path !== undefined);

  return {
    id: ID,
    version: VERSION,
    categories: ["vm-image"],

    async probe(environment) {
      const roots = await presentRoots(environment, systemRoots);
      return roots.length > 0
        ? { status: "available", explanation: `${roots.length} virtual machine image directories exist.` }
        : { status: "missing-tool", explanation: "No virtual machine image directory exists on this machine." };
    },

    async discover(environment) {
      const findings: Finding[] = [];
      const seen = new Set<string>();

      for (const root of await presentRoots(environment, systemRoots)) {
        // One level of machine directories, then the files inside them.
        for (const directory of [root, ...(await childDirectories(environment, root))]) {
          for (const entry of await environment.paths.list(directory)) {
            if (seen.has(entry.bytesBase64) || !isImage(entry)) {
              continue;
            }
            const facts = await environment.paths.facts(entry);
            if (facts === undefined || facts.kind !== "file") {
              continue;
            }
            seen.add(entry.bytesBase64);
            findings.push(imageFinding(entry, facts.allocatedBytes, facts.apparentBytes));
          }
        }
      }

      return { findings, warnings: [], complete: true };
    },
  };
}

function imageFinding(path: RawPath, allocated: Bytes, apparent: Bytes): Finding {
  const sparse = apparent > allocated;
  return buildFinding({
    providerId: ID,
    providerVersion: VERSION,
    category: "vm-image",
    slug: slugForPath(path),
    title: `Disk image ${basename(path)}`,
    evidence: [
      sparse
        ? `A sparse image: it claims ${apparent} bytes and occupies ${allocated}.`
        : `A disk image occupying ${allocated} bytes.`,
      "Disktop cannot tell whether a guest is using it without privilege, so it is treated as in use.",
    ],
    paths: [path],
    size: findingSize(
      allocated,
      "stat",
      `Blocks on disk from one stat call; the image claims ${apparent} bytes.`,
    ),
    confidence: "uncertain",
    active: true,
    actions: [],
  });
}

function isImage(path: RawPath): boolean {
  const name = basename(path).toLowerCase();
  return IMAGE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

async function presentRoots(
  environment: DiscoveryEnvironment,
  systemRoots: readonly RawPath[],
): Promise<readonly RawPath[]> {
  const candidates = [...IMAGE_ROOTS.map((segments) => underHome(environment, ...segments)), ...systemRoots];
  const found: RawPath[] = [];
  for (const candidate of candidates) {
    if (await exists(environment, candidate)) {
      found.push(candidate);
    }
  }
  return found;
}
