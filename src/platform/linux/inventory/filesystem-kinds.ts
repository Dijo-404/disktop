/**
 * Which mounted filesystems represent storage a user can fill, and which are
 * kernel interfaces that only look like one.
 */

/**
 * Kernel and runtime interfaces. They report capacity through `statfs` but
 * that capacity is not disk space, so counting them would misstate every total.
 */
const PSEUDO_TYPES = new Set([
  "autofs",
  "bpf",
  "binfmt_misc",
  "cgroup",
  "cgroup2",
  "configfs",
  "debugfs",
  "devpts",
  "devtmpfs",
  "efivarfs",
  "fuse.gvfsd-fuse",
  "fuse.portal",
  "fusectl",
  "hugetlbfs",
  "mqueue",
  "nsfs",
  "proc",
  "pstore",
  "ramfs",
  "rpc_pipefs",
  "securityfs",
  "selinuxfs",
  "sysfs",
  "tracefs",
]);

/** Storage reached over a network. Listed, but never scanned without an explicit choice. */
const NETWORK_TYPES = new Set([
  "9p",
  "afs",
  "afpfs",
  "beegfs",
  "ceph",
  "cifs",
  "coda",
  "fuse.cephfs",
  "fuse.glusterfs",
  "fuse.rclone",
  "fuse.s3fs",
  "fuse.sshfs",
  "gfs2",
  "glusterfs",
  "lustre",
  "ncpfs",
  "nfs",
  "nfs4",
  "ocfs2",
  "orangefs",
  "smb3",
  "smbfs",
]);

/** Filesystems backing a Windows drive under WSL. */
const WINDOWS_TYPES = new Set(["9p", "drvfs", "drv_fs", "virtiofs"]);

export function isPseudoFilesystem(type: string): boolean {
  return PSEUDO_TYPES.has(type) || type.startsWith("cgroup");
}

export function isNetworkFilesystem(type: string): boolean {
  return NETWORK_TYPES.has(type);
}

/**
 * A squashfs image mounted from a loop device, as Snap uses for every revision.
 * It is real storage but read-only and already counted inside its backing file,
 * so counting it again would double-count the same bytes.
 */
export function isLoopImage(source: string): boolean {
  // Compressed read-only filesystems can also live directly on a real disk
  // (a live USB or an appliance root). Their type does not make them a loop image.
  return source.startsWith("/dev/loop");
}

/** Windows drives surfaced inside WSL, which are excluded from scans by default. */
export function isWindowsMount(type: string, mountPointDisplay: string): boolean {
  return WINDOWS_TYPES.has(type) && (mountPointDisplay === "/mnt" || mountPointDisplay.startsWith("/mnt/"));
}
