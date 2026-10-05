//! The mount table, read to tell another filesystem from another part of the
//! one being scanned.
//!
//! A Btrfs subvolume mounted at `/home` is a different mount from `/`, so
//! `RESOLVE_NO_XDEV` refuses it, and it has a device number of its own, so a
//! comparison of `st_dev` refuses it too. Both answers are wrong for a scan
//! that means to stay on one filesystem: `/home` is that filesystem, and its
//! bytes are part of what `df` reports as used. A scan of `/` that stopped
//! there would account for a fraction of the used space and show `/home` as
//! empty.
//!
//! The superblock's device number in `/proc/self/mountinfo` is the identity
//! every mount of one filesystem shares, and a mount's root within that
//! filesystem says which part of it the mount shows. Together they tell a
//! second subvolume, whose bytes nothing else in the scan reaches, from a
//! bind mount repeating a tree the scan already counts, which is refused as
//! before so nothing is counted twice.

use crate::walk::is_within;
use std::collections::{HashMap, HashSet};

/// One line of `/proc/self/mountinfo`, with its paths unescaped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MountRow {
    pub id: u64,
    pub parent_id: u64,
    /// `major:minor` of the superblock, shared by every mount of one filesystem.
    pub superblock: Vec<u8>,
    /// The directory of the filesystem this mount shows.
    pub root: Vec<u8>,
    pub mount_point: Vec<u8>,
    pub filesystem_type: Vec<u8>,
}

/// The mount table as the kernel reports it now, or nothing when it cannot be
/// read, in which case no mount is entered and the walk behaves as it always
/// did.
pub fn read() -> Vec<MountRow> {
    std::fs::read("/proc/self/mountinfo")
        .map(|table| parse(&table))
        .unwrap_or_default()
}

/// Lines that do not have the documented shape are skipped rather than
/// guessed at; a skipped line is a mount that is never entered.
pub fn parse(table: &[u8]) -> Vec<MountRow> {
    table
        .split(|byte| *byte == b'\n')
        .filter_map(parse_line)
        .collect()
}

fn parse_line(line: &[u8]) -> Option<MountRow> {
    let fields: Vec<&[u8]> = line.split(|byte| *byte == b' ').collect();
    // id, parent, major:minor, root, mount point, options, optional fields…,
    // "-", type, source, superblock options.
    let separator = fields.iter().skip(6).position(|field| *field == b"-")? + 6;
    let filesystem_type = fields.get(separator + 1)?;
    Some(MountRow {
        id: number(fields.first()?)?,
        parent_id: number(fields.get(1)?)?,
        superblock: fields.get(2)?.to_vec(),
        root: unescape_octal(fields.get(3)?),
        mount_point: unescape_octal(fields.get(4)?),
        filesystem_type: unescape_octal(filesystem_type),
    })
}

fn number(field: &[u8]) -> Option<u64> {
    std::str::from_utf8(field).ok()?.parse().ok()
}

/// mountinfo escapes space, tab, newline and backslash as three octal digits.
pub fn unescape_octal(field: &[u8]) -> Vec<u8> {
    let mut decoded = Vec::with_capacity(field.len());
    let mut index = 0;
    while index < field.len() {
        if field[index] == b'\\' && index + 3 < field.len() {
            let digits = &field[index + 1..index + 4];
            if digits.iter().all(|byte| (b'0'..=b'7').contains(byte)) {
                let value = digits
                    .iter()
                    .fold(0u16, |total, byte| total * 8 + u16::from(byte - b'0'));
                decoded.push(value as u8);
                index += 4;
                continue;
            }
        }
        decoded.push(field[index]);
        index += 1;
    }
    decoded
}

/// What the walk does at one mount below its root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Another part of the scanned filesystem that nothing else in the scan
    /// reaches, such as a Btrfs subvolume: entered and counted.
    Enter,
    /// A different filesystem, named by its type.
    OtherFilesystem(Vec<u8>),
    /// The same filesystem showing a tree the scan already reaches some other
    /// way, such as a bind mount; entering it would count those bytes twice.
    Repeats,
}

/// Which mounts below one scan root belong to the filesystem the root is on.
#[derive(Default)]
pub struct SameFilesystem {
    decisions: HashMap<u64, Decision>,
}

impl SameFilesystem {
    /// `root_path` is where the scan root really is, with every symlink
    /// resolved, and `root_mount` the id of the mount it is on.
    ///
    /// Mounts are considered in the kernel's own order, which is the order
    /// they were made in, so of two mounts showing the same tree the first is
    /// the one counted. A mount whose parent was not entered is never reached
    /// by the walk and decides nothing.
    pub fn plan(rows: &[MountRow], root_path: &[u8], root_mount: u64) -> SameFilesystem {
        let mut decisions = HashMap::new();
        let Some(root_row) = rows.iter().find(|row| row.id == root_mount) else {
            return SameFilesystem { decisions };
        };
        let Some(shown) = rebase(root_path, &root_row.mount_point, &root_row.root) else {
            return SameFilesystem { decisions };
        };

        let mut covered: Vec<Vec<u8>> = vec![shown];
        let mut entered: HashSet<u64> = HashSet::from([root_mount]);
        for row in rows {
            if row.id == root_mount
                || row.mount_point == root_path
                || !is_within(root_path, &row.mount_point)
            {
                continue;
            }
            if row.superblock != root_row.superblock
                || row.filesystem_type != root_row.filesystem_type
            {
                decisions.insert(
                    row.id,
                    Decision::OtherFilesystem(row.filesystem_type.clone()),
                );
                continue;
            }
            if !entered.contains(&row.parent_id) {
                decisions.insert(row.id, Decision::Repeats);
                continue;
            }
            let overlaps = covered
                .iter()
                .any(|tree| is_within(tree, &row.root) || is_within(&row.root, tree));
            if overlaps {
                decisions.insert(row.id, Decision::Repeats);
                continue;
            }
            covered.push(row.root.clone());
            entered.insert(row.id);
            decisions.insert(row.id, Decision::Enter);
        }
        SameFilesystem { decisions }
    }

    pub fn decision(&self, mount_id: u64) -> Option<&Decision> {
        self.decisions.get(&mount_id)
    }
}

/// `path`, which lies under `from`, expressed under `to` instead.
fn rebase(path: &[u8], from: &[u8], to: &[u8]) -> Option<Vec<u8>> {
    if !is_within(from, path) {
        return None;
    }
    let suffix: &[u8] = if from == b"/" {
        path
    } else {
        &path[from.len()..]
    };
    if to == b"/" {
        return Some(if suffix.is_empty() {
            b"/".to_vec()
        } else {
            suffix.to_vec()
        });
    }
    if suffix == b"/" {
        return Some(to.to_vec());
    }
    let mut rebased = to.to_vec();
    rebased.extend_from_slice(suffix);
    Some(rebased)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This layout is a real one: an encrypted Btrfs volume with its
    /// subvolumes mounted at `/`, `/home`, `/.snapshots`, `/tmp`, `/var/log`
    /// and the package cache, a FAT `/boot`, and the usual pseudo filesystems.
    const DESKTOP: &[u8] = b"\
24 30 0:23 / /proc rw,nosuid,nodev,noexec,relatime shared:5 - proc proc rw
25 30 0:24 / /sys rw,nosuid,nodev,noexec,relatime shared:6 - sysfs sys rw
26 30 0:6 / /dev rw,nosuid,relatime shared:2 - devtmpfs dev rw,size=16037728k
27 30 0:25 / /run rw,nosuid,nodev,relatime shared:12 - tmpfs run rw,mode=755
30 1 0:28 /@ / rw,relatime shared:1 - btrfs /dev/mapper/root rw,ssd,subvolid=256,subvol=/@
49 30 0:28 /@snapshots /.snapshots rw,relatime shared:109 - btrfs /dev/mapper/root rw,subvolid=260,subvol=/@snapshots
48 30 0:28 /@home /home rw,relatime shared:113 - btrfs /dev/mapper/root rw,subvolid=257,subvol=/@home
50 30 0:28 /@tmp /tmp rw,relatime shared:117 - btrfs /dev/mapper/root rw,subvolid=261,subvol=/@tmp
60 30 0:28 /@log /var/log rw,relatime shared:121 - btrfs /dev/mapper/root rw,subvolid=258,subvol=/@log
61 30 0:28 /@pkg /var/cache/pacman/pkg rw,relatime shared:125 - btrfs /dev/mapper/root rw,subvolid=259,subvol=/@pkg
156 30 259:7 / /boot rw,relatime shared:129 - vfat /dev/nvme0n1p4 rw,fmask=0022
267 27 0:66 / /run/user/1000 rw,nosuid,nodev,relatime shared:458 - tmpfs tmpfs rw,size=3226616k
";

    #[test]
    fn a_line_is_read_field_by_field_and_its_paths_unescaped() {
        let rows = parse(
            b"36 35 98:0 /mnt\\0401 /mnt/with\\040space rw,noatime master:1 shared:2 - ext3 /dev/root rw\n",
        );
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.id, 36);
        assert_eq!(row.parent_id, 35);
        assert_eq!(row.superblock, b"98:0");
        assert_eq!(row.root, b"/mnt 1");
        assert_eq!(row.mount_point, b"/mnt/with space");
        assert_eq!(row.filesystem_type, b"ext3");
    }

    #[test]
    fn a_line_without_the_separator_is_skipped_rather_than_guessed_at() {
        assert!(parse(b"36 35 98:0 / /mnt rw ext3 /dev/root rw\n").is_empty());
        assert!(parse(b"\n\n").is_empty());
    }

    #[test]
    fn every_subvolume_of_the_scanned_btrfs_is_entered_and_nothing_else() {
        let rows = parse(DESKTOP);
        let plan = SameFilesystem::plan(&rows, b"/", 30);
        for subvolume in [49, 48, 50, 60, 61] {
            assert_eq!(
                plan.decision(subvolume),
                Some(&Decision::Enter),
                "mount {subvolume}"
            );
        }
        assert_eq!(
            plan.decision(156),
            Some(&Decision::OtherFilesystem(b"vfat".to_vec()))
        );
        assert_eq!(
            plan.decision(24),
            Some(&Decision::OtherFilesystem(b"proc".to_vec()))
        );
        assert_eq!(
            plan.decision(27),
            Some(&Decision::OtherFilesystem(b"tmpfs".to_vec()))
        );
        // Below /run, which is not entered.
        assert_eq!(
            plan.decision(267),
            Some(&Decision::OtherFilesystem(b"tmpfs".to_vec()))
        );
        // The root's own mount is not a decision at all.
        assert_eq!(plan.decision(30), None);
    }

    #[test]
    fn a_scan_below_a_subvolume_mount_enters_only_what_is_below_it() {
        let rows = parse(DESKTOP);
        let plan = SameFilesystem::plan(&rows, b"/var", 30);
        assert_eq!(plan.decision(60), Some(&Decision::Enter));
        assert_eq!(plan.decision(61), Some(&Decision::Enter));
        assert_eq!(plan.decision(48), None, "/home is not below /var");
    }

    #[test]
    fn a_bind_mount_repeating_a_tree_the_scan_reaches_is_not_entered() {
        let mut table = DESKTOP.to_vec();
        // /home/dj/data shown again at /srv/data, and the whole volume's top
        // level at /mnt/top, which contains every subvolume.
        table.extend_from_slice(
            b"70 30 0:28 /@home/dj/data /srv/data rw - btrfs /dev/mapper/root rw\n\
              71 30 0:28 / /mnt/top rw - btrfs /dev/mapper/root rw,subvolid=5\n",
        );
        let rows = parse(&table);
        let plan = SameFilesystem::plan(&rows, b"/", 30);
        assert_eq!(plan.decision(48), Some(&Decision::Enter));
        assert_eq!(plan.decision(70), Some(&Decision::Repeats));
        assert_eq!(plan.decision(71), Some(&Decision::Repeats));
    }

    #[test]
    fn of_two_mounts_of_one_subvolume_the_first_is_counted() {
        let mut table = DESKTOP.to_vec();
        table.extend_from_slice(
            b"72 30 0:28 /@home /srv/home-again rw - btrfs /dev/mapper/root rw\n",
        );
        let rows = parse(&table);
        let plan = SameFilesystem::plan(&rows, b"/", 30);
        assert_eq!(plan.decision(48), Some(&Decision::Enter));
        assert_eq!(plan.decision(72), Some(&Decision::Repeats));
    }

    #[test]
    fn a_tree_from_outside_the_scan_root_is_entered_and_one_from_inside_is_not() {
        // A tmpfs at /t, scanned at /t/root: /t/other bound inside the root
        // brings in bytes the scan does not otherwise reach, and /t/root/a
        // bound at /t/root/b repeats bytes it does.
        let table = b"\
1 0 0:5 / / rw - ext4 /dev/sda1 rw
10 1 0:90 / /t rw - tmpfs tmpfs rw
11 10 0:90 /other /t/root/inner rw - tmpfs tmpfs rw
12 10 0:90 /root/a /t/root/b rw - tmpfs tmpfs rw
";
        let rows = parse(table);
        let plan = SameFilesystem::plan(&rows, b"/t/root", 10);
        assert_eq!(plan.decision(11), Some(&Decision::Enter));
        assert_eq!(plan.decision(12), Some(&Decision::Repeats));
    }

    #[test]
    fn an_unknown_root_mount_enters_nothing() {
        let rows = parse(DESKTOP);
        let plan = SameFilesystem::plan(&rows, b"/", 999);
        assert_eq!(plan.decision(48), None);
    }

    #[test]
    fn rebasing_keeps_whole_segments() {
        assert_eq!(rebase(b"/", b"/", b"/@").unwrap(), b"/@");
        assert_eq!(
            rebase(b"/home/dj", b"/home", b"/@home").unwrap(),
            b"/@home/dj"
        );
        assert_eq!(rebase(b"/home", b"/home", b"/@home").unwrap(), b"/@home");
        assert_eq!(rebase(b"/t/root", b"/t", b"/").unwrap(), b"/root");
        assert_eq!(rebase(b"/t", b"/t", b"/").unwrap(), b"/");
        assert!(rebase(b"/homer", b"/home", b"/@home").is_none());
    }
}
