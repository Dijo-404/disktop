//! Bounded, contained, depth-first traversal.
//!
//! The walk holds one open directory stream per level, so its descriptor and
//! memory use follow the tree's depth rather than its entry count. Each
//! directory is aggregated on the way back up, which is what lets a listing
//! rank directories by the size of their subtree without a second pass.
//!
//! Nothing here deletes, renames, or writes. A directory it cannot open is
//! counted and reported, never silently treated as empty.

use crate::sys::{self, Directory, EntryKind, Metadata};
use std::collections::HashSet;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Enough for any real tree, low enough that one walk cannot exhaust the
/// process descriptor limit with its open directory streams.
pub const MAX_DEPTH: u32 = 512;

const PROGRESS_ENTRIES: u64 = 4096;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// The most individual warnings one scan reports.
///
/// There is one warning per unreadable directory and one per entry that moved
/// while the scan ran, each carrying a message and a full path. A scan of `/`
/// as an ordinary user, or of a tree under an active build, produces tens of
/// thousands of them, and an uncapped list would grow with the filesystem in
/// memory, on the wire, in the index, and in every stored snapshot. Past this
/// point the warnings are counted by code instead, and the counts are reported
/// as their own warning, so nothing is ever hidden — only summarised.
const MAX_WARNINGS: usize = 256;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Accounting {
    Allocated,
    Apparent,
}

impl Accounting {
    pub fn as_str(self) -> &'static str {
        match self {
            Accounting::Allocated => "allocated",
            Accounting::Apparent => "apparent",
        }
    }
}

pub struct ScanOptions {
    pub roots: Vec<Vec<u8>>,
    pub cross_filesystems: bool,
    pub excludes: Vec<Vec<u8>>,
    pub accounting: Accounting,
    pub throttle_bytes_per_second: Option<u64>,
    pub max_depth: Option<u32>,
}

pub struct EntryRecord<'a> {
    pub parent: Option<i64>,
    pub name: &'a [u8],
    pub metadata: &'a Metadata,
    pub shared: bool,
    /// True only for a symlink whose target does not resolve to anything.
    pub broken: bool,
}

/// Totals a directory's whole subtree contributed, written when the walk
/// leaves it. A directory row therefore ranks by what it holds, not by the
/// size of its own inode.
pub struct DirectoryTotals {
    pub entries: u64,
    pub allocated_bytes: u64,
    pub apparent_bytes: u64,
    /// Names `readdir` returned directly inside this directory, excluding `.`
    /// and `..` and counting the excluded and unreadable ones too. A directory
    /// the walk never entered has no count at all rather than a zero, because
    /// "nobody looked" and "nothing is there" are not the same answer.
    pub child_entries: u64,
}

pub trait ScanSink {
    fn entry(&mut self, record: &EntryRecord<'_>) -> io::Result<i64>;
    fn finish_directory(&mut self, id: i64, totals: &DirectoryTotals) -> io::Result<()>;
    fn progress(&mut self, snapshot: &Progress);
}

pub struct Progress {
    pub scanned_entries: u64,
    pub processed_bytes: u64,
    pub inaccessible_directories: u64,
    pub current_path: Vec<u8>,
}

#[derive(Clone)]
pub struct ScanWarning {
    pub code: &'static str,
    pub message: String,
    pub path: Option<Vec<u8>>,
}

pub struct ScanTotals {
    pub complete: bool,
    pub scanned_entries: u64,
    pub inaccessible_directories: u64,
    pub allocated_bytes: u64,
    pub apparent_bytes: u64,
    pub shared_bytes: u64,
    pub excluded_mounts: Vec<Vec<u8>>,
    pub warnings: Vec<ScanWarning>,
    /// Device numbers the walk actually read, which is what makes two scans
    /// comparable. Deriving them from the roots alone would miss every mount
    /// a `crossFilesystems` scan descended into.
    pub filesystems: Vec<u64>,
}

struct Frame {
    directory: Directory,
    path: Vec<u8>,
    id: i64,
    depth: u32,
    totals: DirectoryTotals,
}

struct Walk<'a> {
    options: &'a ScanOptions,
    sink: &'a mut dyn ScanSink,
    cancelled: &'a AtomicBool,
    totals: ScanTotals,
    /// Only inodes with more than one link are remembered, so the set stays a
    /// function of how many hardlinks exist rather than of the tree's size.
    counted_inodes: HashSet<(u64, u64)>,
    processed_bytes: u64,
    /// Counted per code once the warning list is full, so a summary can say
    /// how much was left out.
    suppressed: std::collections::BTreeMap<&'static str, u64>,
    filesystems: HashSet<u64>,
    last_progress: Instant,
    since_progress: u64,
    started: Instant,
    warned_depth: bool,
}

/// Walk every root. Returns what was actually observed; `complete` is false
/// whenever cancellation, a depth limit, or an unopenable root cut it short.
pub fn walk(
    options: &ScanOptions,
    sink: &mut dyn ScanSink,
    cancelled: &AtomicBool,
) -> io::Result<ScanTotals> {
    sys::openat2_available().map_err(|error| {
        io::Error::new(
            io::ErrorKind::Unsupported,
            format!("openat2 containment is unavailable: {error}"),
        )
    })?;

    let mut walk = Walk {
        options,
        sink,
        cancelled,
        totals: ScanTotals {
            complete: true,
            scanned_entries: 0,
            inaccessible_directories: 0,
            allocated_bytes: 0,
            apparent_bytes: 0,
            shared_bytes: 0,
            excluded_mounts: Vec::new(),
            warnings: Vec::new(),
            filesystems: Vec::new(),
        },
        counted_inodes: HashSet::new(),
        processed_bytes: 0,
        suppressed: std::collections::BTreeMap::new(),
        filesystems: HashSet::new(),
        last_progress: Instant::now(),
        since_progress: 0,
        started: Instant::now(),
        warned_depth: false,
    };

    for root in &options.roots {
        walk.root(root)?;
        if walk.stopped() {
            break;
        }
    }

    if walk.cancelled.load(Ordering::Relaxed) {
        walk.totals.complete = false;
        // Cancellation is the one warning that is never dropped for being late.
        walk.totals.warnings.push(ScanWarning {
            code: "cancelled",
            message: "The scan stopped at a directory boundary when cancellation was requested."
                .to_owned(),
            path: None,
        });
    }

    for (code, count) in std::mem::take(&mut walk.suppressed) {
        walk.totals.warnings.push(ScanWarning {
            code: "warnings-truncated",
            message: format!("{count} further '{code}' warnings were counted but not listed."),
            path: None,
        });
    }
    let mut filesystems: Vec<u64> = walk.filesystems.iter().copied().collect();
    filesystems.sort_unstable();
    walk.totals.filesystems = filesystems;

    Ok(walk.totals)
}

impl Walk<'_> {
    /// Record a warning, or count it once the list is full.
    fn warn(&mut self, code: &'static str, message: String, path: Option<Vec<u8>>) {
        if self.totals.warnings.len() >= MAX_WARNINGS {
            *self.suppressed.entry(code).or_insert(0) += 1;
            return;
        }
        self.totals.warnings.push(ScanWarning {
            code,
            message,
            path,
        });
    }

    fn stopped(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    fn root(&mut self, path: &[u8]) -> io::Result<()> {
        if self.excluded(path) {
            self.warn(
                "excluded-mount",
                "The scan root is itself excluded.".to_owned(),
                Some(path.to_vec()),
            );
            self.totals.complete = false;
            return Ok(());
        }

        let descriptor = match sys::open_root(path) {
            Ok(descriptor) => descriptor,
            Err(error) => {
                self.totals.complete = false;
                self.totals.inaccessible_directories += 1;
                self.warn(
                    "inaccessible-directory",
                    format!("The scan root could not be opened: {error}"),
                    Some(path.to_vec()),
                );
                return Ok(());
            }
        };

        let metadata = match sys::metadata_of(descriptor) {
            Ok(metadata) => metadata,
            Err(error) => {
                sys::close(descriptor);
                self.totals.complete = false;
                self.totals.inaccessible_directories += 1;
                self.warn(
                    "inaccessible-directory",
                    format!("The scan root could not be read: {error}"),
                    Some(path.to_vec()),
                );
                return Ok(());
            }
        };

        let id = self.sink.entry(&EntryRecord {
            parent: None,
            // A root row stores its whole absolute path; every row below it
            // stores one name and its parent's ID.
            name: path,
            metadata: &metadata,
            shared: false,
            broken: false,
        })?;
        self.account(&metadata, false);

        let directory = match Directory::from_descriptor(descriptor) {
            Ok(directory) => directory,
            Err(error) => {
                self.note_inaccessible(path, &error);
                return Ok(());
            }
        };

        let mut stack = vec![Frame {
            directory,
            path: path.to_vec(),
            id,
            depth: 0,
            totals: DirectoryTotals {
                entries: 1,
                allocated_bytes: metadata.allocated_bytes,
                apparent_bytes: metadata.apparent_bytes,
                child_entries: 0,
            },
        }];
        self.descend(&mut stack)
    }

    /// Depth-first, one open directory stream per level. On cancellation the
    /// stack is still unwound so every directory row gets the totals the walk
    /// really observed rather than none at all.
    fn descend(&mut self, stack: &mut Vec<Frame>) -> io::Result<()> {
        while let Some(frame) = stack.last_mut() {
            if self.cancelled.load(Ordering::Relaxed) {
                self.unwind(stack)?;
                return Ok(());
            }

            let name = match frame.directory.next_name() {
                Ok(Some(name)) => name,
                Ok(None) => {
                    self.close_frame(stack)?;
                    continue;
                }
                Err(error) => {
                    let path = frame.path.clone();
                    self.note_inaccessible(&path, &error);
                    self.close_frame(stack)?;
                    continue;
                }
            };

            frame.totals.child_entries += 1;

            let path = join(&frame.path, &name);
            if self.excluded(&path) {
                self.totals.excluded_mounts.push(path);
                continue;
            }

            let descriptor = frame.directory.descriptor();
            let metadata = match sys::metadata_at(descriptor, &name) {
                Ok(metadata) => metadata,
                Err(error) => {
                    // A name that vanished between readdir and statx is churn,
                    // not a scan failure, but the result stops claiming to be
                    // a complete picture of the tree.
                    self.totals.complete = false;
                    self.warn(
                        "changed-during-scan",
                        format!("The entry could not be read: {error}"),
                        Some(path),
                    );
                    continue;
                }
            };

            let shared = self.already_counted(&metadata);
            let broken =
                metadata.kind == EntryKind::Symlink && !sys::target_exists(descriptor, &name);
            let parent_id = frame.id;
            let id = self.sink.entry(&EntryRecord {
                parent: Some(parent_id),
                name: &name,
                metadata: &metadata,
                shared,
                broken,
            })?;
            self.account(&metadata, shared);
            self.report(&path);

            // A directory contributes through the rollup its own frame does on
            // the way back up; adding it here as well would count it twice.
            if metadata.kind == EntryKind::Directory {
                self.open_child(stack, id, name, path, metadata)?;
                continue;
            }

            let frame = stack.last_mut().expect("the frame is still on the stack");
            frame.totals.entries += 1;
            if !shared {
                frame.totals.allocated_bytes = frame
                    .totals
                    .allocated_bytes
                    .saturating_add(metadata.allocated_bytes);
                frame.totals.apparent_bytes = frame
                    .totals
                    .apparent_bytes
                    .saturating_add(metadata.apparent_bytes);
            }
        }
        Ok(())
    }

    fn open_child(
        &mut self,
        stack: &mut Vec<Frame>,
        id: i64,
        name: Vec<u8>,
        path: Vec<u8>,
        metadata: Metadata,
    ) -> io::Result<()> {
        let frame = stack.last().expect("the frame is still on the stack");
        let depth = frame.depth + 1;
        let ceiling = self.options.max_depth.unwrap_or(MAX_DEPTH).min(MAX_DEPTH);
        if depth > ceiling {
            self.totals.complete = false;
            if !self.warned_depth {
                self.warned_depth = true;
                self.warn(
                    "depth-limit-reached",
                    format!("The walk stopped descending at depth {ceiling}."),
                    Some(path),
                );
            }
            self.attribute_unentered(stack, &metadata);
            return Ok(());
        }

        let parent_descriptor = frame.directory.descriptor();
        let descriptor = match sys::open_child_directory(
            parent_descriptor,
            &name,
            self.options.cross_filesystems,
        ) {
            Ok(descriptor) => descriptor,
            Err(error) => {
                self.note_refusal(&path, &error);
                self.attribute_unentered(stack, &metadata);
                return Ok(());
            }
        };

        match Directory::from_descriptor(descriptor) {
            Ok(directory) => stack.push(Frame {
                directory,
                path,
                id,
                depth,
                totals: DirectoryTotals {
                    entries: 1,
                    allocated_bytes: metadata.allocated_bytes,
                    apparent_bytes: metadata.apparent_bytes,
                    child_entries: 0,
                },
            }),
            Err(error) => {
                self.note_inaccessible(&path, &error);
                self.attribute_unentered(stack, &metadata);
            }
        }
        Ok(())
    }

    /// A directory the walk recorded but could not enter still contributes its
    /// own inode to the parent's totals; what it contains stays unknown and is
    /// reported as such rather than rolled up as zero.
    fn attribute_unentered(&mut self, stack: &mut [Frame], metadata: &Metadata) {
        let Some(frame) = stack.last_mut() else {
            return;
        };
        frame.totals.entries += 1;
        frame.totals.allocated_bytes = frame
            .totals
            .allocated_bytes
            .saturating_add(metadata.allocated_bytes);
        frame.totals.apparent_bytes = frame
            .totals
            .apparent_bytes
            .saturating_add(metadata.apparent_bytes);
    }

    fn close_frame(&mut self, stack: &mut Vec<Frame>) -> io::Result<()> {
        let frame = stack
            .pop()
            .expect("close_frame is only called with a frame");
        self.sink.finish_directory(frame.id, &frame.totals)?;
        if let Some(parent) = stack.last_mut() {
            parent.totals.entries += frame.totals.entries;
            parent.totals.allocated_bytes = parent
                .totals
                .allocated_bytes
                .saturating_add(frame.totals.allocated_bytes);
            parent.totals.apparent_bytes = parent
                .totals
                .apparent_bytes
                .saturating_add(frame.totals.apparent_bytes);
        }
        Ok(())
    }

    fn unwind(&mut self, stack: &mut Vec<Frame>) -> io::Result<()> {
        while !stack.is_empty() {
            self.close_frame(stack)?;
        }
        Ok(())
    }

    /// An inode reached through a second hardlink is recorded, but its bytes
    /// are attributed once, to the first path the walk saw.
    fn already_counted(&mut self, metadata: &Metadata) -> bool {
        if metadata.link_count <= 1 || metadata.kind == EntryKind::Directory {
            return false;
        }
        !self
            .counted_inodes
            .insert((metadata.device, metadata.inode))
    }

    fn account(&mut self, metadata: &Metadata, shared: bool) {
        self.totals.scanned_entries += 1;
        self.since_progress += 1;
        self.filesystems.insert(metadata.device);
        // Shared bytes are reported in the same unit as the totals they sit
        // beside; two units in one object would make the smaller one read as
        // negligible when it is not.
        let counted = match self.options.accounting {
            Accounting::Allocated => metadata.allocated_bytes,
            Accounting::Apparent => metadata.apparent_bytes,
        };
        if shared {
            self.totals.shared_bytes = self.totals.shared_bytes.saturating_add(counted);
            return;
        }
        self.totals.allocated_bytes = self
            .totals
            .allocated_bytes
            .saturating_add(metadata.allocated_bytes);
        self.totals.apparent_bytes = self
            .totals
            .apparent_bytes
            .saturating_add(metadata.apparent_bytes);
        self.processed_bytes = self
            .processed_bytes
            .saturating_add(match self.options.accounting {
                Accounting::Allocated => metadata.allocated_bytes,
                Accounting::Apparent => metadata.apparent_bytes,
            });
    }

    fn report(&mut self, path: &[u8]) {
        self.throttle();
        if self.since_progress < PROGRESS_ENTRIES
            && self.last_progress.elapsed() < PROGRESS_INTERVAL
        {
            return;
        }
        self.since_progress = 0;
        self.last_progress = Instant::now();
        self.sink.progress(&Progress {
            scanned_entries: self.totals.scanned_entries,
            processed_bytes: self.processed_bytes,
            inaccessible_directories: self.totals.inaccessible_directories,
            current_path: path.to_vec(),
        });
    }

    /// Hold the scan to the requested byte rate, so a background scan does not
    /// take the disk away from whatever the machine is really doing.
    fn throttle(&mut self) {
        let Some(limit) = self.options.throttle_bytes_per_second else {
            return;
        };
        if limit == 0 {
            return;
        }
        let earned = self.started.elapsed().as_secs_f64() * limit as f64;
        let spent = self.processed_bytes as f64;
        if spent <= earned {
            return;
        }
        let seconds = (spent - earned) / limit as f64;
        std::thread::sleep(Duration::from_secs_f64(seconds.min(1.0)));
    }

    fn excluded(&self, path: &[u8]) -> bool {
        self.options
            .excludes
            .iter()
            .any(|exclude| is_within(exclude, path))
    }

    /// `openat2` reports a refused mount crossing and a refused symlink
    /// differently from a permission failure, and the result says which it was.
    fn note_refusal(&mut self, path: &[u8], error: &io::Error) {
        match error.raw_os_error() {
            Some(libc::EXDEV) => {
                self.totals.excluded_mounts.push(path.to_vec());
                self.warn(
                    "crossed-filesystem-skipped",
                    "A mount point was not descended into.".to_owned(),
                    Some(path.to_vec()),
                );
            }
            Some(libc::ELOOP) => self.warn(
                "symlink-not-followed",
                "A symbolic link was not followed.".to_owned(),
                Some(path.to_vec()),
            ),
            _ => self.note_inaccessible(path, error),
        }
    }

    fn note_inaccessible(&mut self, path: &[u8], error: &io::Error) {
        self.totals.complete = false;
        self.totals.inaccessible_directories += 1;
        self.warn(
            "inaccessible-directory",
            format!("The directory could not be read: {error}"),
            Some(path.to_vec()),
        );
    }
}

pub fn join(parent: &[u8], name: &[u8]) -> Vec<u8> {
    let mut path = Vec::with_capacity(parent.len() + name.len() + 1);
    path.extend_from_slice(parent);
    if path.last() != Some(&b'/') {
        path.push(b'/');
    }
    path.extend_from_slice(name);
    path
}

/// True when `child` is `parent` or sits below it, compared by whole segments
/// so `/home/user2` is not treated as living under `/home/user`.
pub fn is_within(parent: &[u8], child: &[u8]) -> bool {
    if child.len() < parent.len() || !child.starts_with(parent) {
        return false;
    }
    child.len() == parent.len() || parent.last() == Some(&b'/') || child[parent.len()] == b'/'
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Sandbox;
    use std::os::unix::ffi::OsStrExt;

    #[derive(Default)]
    struct Collector {
        rows: Vec<(Option<i64>, Vec<u8>, EntryKind, bool)>,
        finished: Vec<(i64, u64, u64)>,
        progress_calls: usize,
    }

    impl ScanSink for Collector {
        fn entry(&mut self, record: &EntryRecord<'_>) -> io::Result<i64> {
            self.rows.push((
                record.parent,
                record.name.to_vec(),
                record.metadata.kind,
                record.shared,
            ));
            Ok(self.rows.len() as i64)
        }

        fn finish_directory(&mut self, id: i64, totals: &DirectoryTotals) -> io::Result<()> {
            self.finished
                .push((id, totals.allocated_bytes, totals.entries));
            Ok(())
        }

        fn progress(&mut self, _snapshot: &Progress) {
            self.progress_calls += 1;
        }
    }

    fn options(root: &std::path::Path) -> ScanOptions {
        ScanOptions {
            roots: vec![root.as_os_str().as_bytes().to_vec()],
            cross_filesystems: false,
            excludes: Vec::new(),
            accounting: Accounting::Allocated,
            throttle_bytes_per_second: None,
            max_depth: None,
        }
    }

    #[test]
    fn counts_every_entry_once_and_never_follows_a_symlink() {
        let sandbox = Sandbox::new("walk-basic");
        sandbox.file(b"a.txt", 100);
        sandbox.directory(b"nested");
        sandbox.file(b"nested/b.txt", 200);
        sandbox.symlink(b"nested", b"link-to-nested");

        let mut sink = Collector::default();
        let totals = walk(&options(sandbox.path()), &mut sink, &AtomicBool::new(false)).unwrap();

        assert!(totals.complete);
        // root, a.txt, nested, nested/b.txt, link-to-nested
        assert_eq!(totals.scanned_entries, 5);
        assert_eq!(
            sink.rows
                .iter()
                .filter(|row| row.2 == EntryKind::Symlink)
                .count(),
            1
        );
        // The link is recorded but not descended into, so b.txt appears once.
        assert_eq!(
            sink.rows
                .iter()
                .filter(|row| row.1 == b"b.txt".to_vec())
                .count(),
            1
        );
    }

    #[test]
    fn a_second_hardlink_is_listed_but_its_bytes_are_counted_once() {
        let sandbox = Sandbox::new("walk-hardlink");
        sandbox.file(b"original.bin", 8192);
        sandbox.hardlink(b"original.bin", b"copy.bin");

        let mut sink = Collector::default();
        let totals = walk(&options(sandbox.path()), &mut sink, &AtomicBool::new(false)).unwrap();

        assert_eq!(totals.scanned_entries, 3);
        assert_eq!(sink.rows.iter().filter(|row| row.3).count(), 1);
        assert!(totals.shared_bytes > 0);
        // The file's bytes plus the root directory's own inode, and nothing
        // for the second link to the same inode.
        assert!((8192..2 * 8192).contains(&totals.apparent_bytes));
    }

    #[test]
    fn names_that_are_not_valid_utf8_survive_as_bytes() {
        let sandbox = Sandbox::new("walk-bytes");
        let name = [b'b', b'a', b'd', 0xff, 0xfe, b'.', b'b', b'i', b'n'];
        sandbox.file(&name, 10);

        let mut sink = Collector::default();
        walk(&options(sandbox.path()), &mut sink, &AtomicBool::new(false)).unwrap();

        assert!(sink.rows.iter().any(|row| row.1 == name.to_vec()));
    }

    #[test]
    fn an_unreadable_directory_is_counted_rather_than_treated_as_empty() {
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let sandbox = Sandbox::new("walk-denied");
        sandbox.directory(b"locked");
        sandbox.file(b"locked/hidden.txt", 64);
        sandbox.chmod(b"locked", 0o000);

        let mut sink = Collector::default();
        let totals = walk(&options(sandbox.path()), &mut sink, &AtomicBool::new(false)).unwrap();

        assert!(!totals.complete);
        assert_eq!(totals.inaccessible_directories, 1);
        assert!(
            totals
                .warnings
                .iter()
                .any(|warning| warning.code == "inaccessible-directory")
        );
        sandbox.chmod(b"locked", 0o700);
    }

    #[test]
    fn an_excluded_subtree_is_reported_and_not_entered() {
        let sandbox = Sandbox::new("walk-exclude");
        sandbox.directory(b"skip");
        sandbox.file(b"skip/inside.txt", 4096);
        sandbox.file(b"kept.txt", 4096);

        let mut options = options(sandbox.path());
        options.excludes = vec![join(options.roots[0].as_slice(), b"skip")];

        let mut sink = Collector::default();
        let totals = walk(&options, &mut sink, &AtomicBool::new(false)).unwrap();

        assert_eq!(totals.excluded_mounts.len(), 1);
        assert!(!sink.rows.iter().any(|row| row.1 == b"inside.txt".to_vec()));
    }

    #[test]
    fn a_cancelled_walk_reports_partial_rather_than_failing() {
        let sandbox = Sandbox::new("walk-cancel");
        sandbox.file(b"a.txt", 10);

        let mut sink = Collector::default();
        let totals = walk(&options(sandbox.path()), &mut sink, &AtomicBool::new(true)).unwrap();

        assert!(!totals.complete);
        assert!(
            totals
                .warnings
                .iter()
                .any(|warning| warning.code == "cancelled")
        );
        // The root frame was still closed, so its row has totals.
        assert_eq!(sink.finished.len(), 1);
    }

    #[test]
    fn a_directory_row_aggregates_its_whole_subtree() {
        let sandbox = Sandbox::new("walk-aggregate");
        sandbox.directory(b"outer");
        sandbox.directory(b"outer/inner");
        sandbox.file(b"outer/inner/big.bin", 65536);

        let mut sink = Collector::default();
        walk(&options(sandbox.path()), &mut sink, &AtomicBool::new(false)).unwrap();

        let root = sink
            .finished
            .iter()
            .find(|finished| finished.0 == 1)
            .expect("the root is finished last");
        assert!(root.1 >= 65536);
        assert_eq!(root.2, 4);
    }

    #[test]
    fn the_warning_list_is_capped_and_says_how_many_it_left_out() {
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let sandbox = Sandbox::new("walk-warning-cap");
        for index in 0..(MAX_WARNINGS + 40) {
            let name = format!("locked-{index}");
            sandbox.directory(name.as_bytes());
            sandbox.chmod(name.as_bytes(), 0o000);
        }

        let mut sink = Collector::default();
        let totals = walk(&options(sandbox.path()), &mut sink, &AtomicBool::new(false)).unwrap();

        for index in 0..(MAX_WARNINGS + 40) {
            sandbox.chmod(format!("locked-{index}").as_bytes(), 0o700);
        }

        // Every unreadable directory is still counted; only the per-path list
        // is bounded, and the overflow is reported rather than dropped.
        assert_eq!(totals.inaccessible_directories as usize, MAX_WARNINGS + 40);
        assert!(totals.warnings.len() <= MAX_WARNINGS + 1);
        let summary = totals
            .warnings
            .iter()
            .find(|warning| warning.code == "warnings-truncated")
            .expect("the suppressed warnings are summarised");
        assert!(summary.message.contains("40"), "{}", summary.message);
    }

    #[test]
    fn shared_bytes_are_reported_in_the_unit_the_scan_was_asked_for() {
        let sandbox = Sandbox::new("walk-shared-unit");
        sandbox.file(b"original.bin", 100_000);
        sandbox.hardlink(b"original.bin", b"copy.bin");

        let mut allocated = options(sandbox.path());
        allocated.accounting = Accounting::Allocated;
        let mut sink = Collector::default();
        let by_blocks = walk(&allocated, &mut sink, &AtomicBool::new(false)).unwrap();

        let mut apparent = options(sandbox.path());
        apparent.accounting = Accounting::Apparent;
        let mut sink = Collector::default();
        let by_size = walk(&apparent, &mut sink, &AtomicBool::new(false)).unwrap();

        // The second link's bytes must be comparable with the totals they sit
        // beside, not silently in a different unit.
        assert_eq!(by_size.shared_bytes, 100_000);
        assert!(by_blocks.shared_bytes >= 100_000);
        assert_eq!(by_blocks.shared_bytes % 512, 0);
    }

    #[test]
    fn the_result_names_the_filesystems_the_walk_actually_read() {
        let sandbox = Sandbox::new("walk-filesystems");
        sandbox.file(b"a.txt", 16);

        let mut sink = Collector::default();
        let totals = walk(&options(sandbox.path()), &mut sink, &AtomicBool::new(false)).unwrap();

        assert_eq!(totals.filesystems.len(), 1);
        assert_ne!(totals.filesystems[0], 0);
    }

    #[test]
    fn segment_boundaries_decide_containment() {
        assert!(is_within(b"/home/user", b"/home/user"));
        assert!(is_within(b"/home/user", b"/home/user/notes"));
        assert!(!is_within(b"/home/user", b"/home/user2"));
        assert!(is_within(b"/", b"/anything"));
    }
}
