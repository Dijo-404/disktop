//! Finding files that hold the same bytes, from a scan the helper already took.
//!
//! The index already knows every file's size, so the expensive part is reading
//! content, and this reads as little of it as it can get away with. Files are
//! grouped by apparent size, which costs nothing; each group of two or more is
//! narrowed by a digest of its members' first and last chunk; each surviving
//! group is narrowed again by a digest of every byte. A file that is alone at
//! any stage is dropped there and never read again.
//!
//! What comes out is a listing, not an authority. The digests here say two
//! files are very probably identical. Nothing acts on that: an operation that
//! releases one copy because another exists re-opens both and compares them
//! byte for byte first. See `docs/adr/0006-content-identity-and-archive-dependencies.md`.
//!
//! Two paths reaching one inode are not duplicates — removing either frees
//! nothing — so the second one is dropped rather than reported.

use crate::content;
use crate::guard;
use crate::index;
use crate::sys::{self, EntryKind};
use rusqlite::{Connection, OptionalExtension, params};
use std::sync::atomic::{AtomicBool, Ordering};

/// Groups a single request may report. A listing nobody can read is not a
/// better answer than a listing that says it was truncated.
pub const MAX_GROUPS: u32 = 1000;
/// Files one group may report, for the same reason.
pub const MAX_FILES_PER_GROUP: u32 = 1000;

pub struct Request {
    /// The primary-key range of the path being searched, from `subtree_range`.
    pub under: Option<(i64, i64)>,
    /// Files below this size are not candidates. Zero-length files are all
    /// identical to each other and reporting them helps nobody.
    pub minimum_bytes: u64,
    pub maximum_groups: u32,
    pub maximum_files_per_group: u32,
}

/// One file in a group, as it was found live rather than as the index
/// remembered it. The identity here is what a plan would fingerprint.
pub struct CandidateFile {
    pub path: Vec<u8>,
    pub device: u64,
    pub inode: u64,
    pub apparent_bytes: u64,
    pub modified_nanoseconds: u64,
    pub owner_id: u32,
    pub group_id: u32,
    pub permissions: u32,
}

pub struct Group {
    pub apparent_bytes: u64,
    pub digest: [u8; 32],
    pub files: Vec<CandidateFile>,
}

pub struct Report {
    pub groups: Vec<Group>,
    /// False when a cap was reached, a file could not be read, or the request
    /// was cancelled. A caller must say so rather than presenting the groups
    /// as the whole answer.
    pub complete: bool,
    pub warnings: Vec<String>,
    pub candidates_read: u64,
    pub files_hashed: u64,
}

/// Size classes read from the index at a time. The search never holds more
/// than this many sizes and one class's members, however many files share a
/// size across the whole scan.
const SIZE_BATCH: u32 = 256;

/// Individual warnings one search reports; the rest are counted. A tree of
/// unreadable files would otherwise grow the answer with every one of them.
const MAX_WARNINGS: usize = 64;
const MAX_REPORT_BYTES: usize = 8 * 1024 * 1024;

/// Read one scan's index and report the groups of identical files in it.
pub fn find(
    connection: &Connection,
    request: &Request,
    cancelled: &AtomicBool,
) -> rusqlite::Result<Report> {
    let mut search = Search {
        report: Report {
            groups: Vec::new(),
            complete: true,
            warnings: Vec::new(),
            candidates_read: 0,
            files_hashed: 0,
        },
        suppressed: 0,
        reported_bytes: 0,
        cancelled,
    };
    search.run(connection, request)?;
    Ok(search.finish())
}

struct Search<'a> {
    report: Report,
    /// Warnings counted rather than listed once the list was full.
    suppressed: u64,
    reported_bytes: usize,
    cancelled: &'a AtomicBool,
}

/// Why a search stopped before it ran out of size classes.
enum Stop {
    Cancelled,
    Truncated(u32),
    ResultBudget,
}

impl Search<'_> {
    fn stopped(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    fn warn(&mut self, message: String) {
        self.report.complete = false;
        if self.report.warnings.len() >= MAX_WARNINGS {
            self.suppressed += 1;
            return;
        }
        self.report.warnings.push(message);
    }

    fn run(&mut self, connection: &Connection, request: &Request) -> rusqlite::Result<()> {
        let maximum_groups = request.maximum_groups.min(MAX_GROUPS);
        let maximum_files = request.maximum_files_per_group.min(MAX_FILES_PER_GROUP);
        let minimum = request.minimum_bytes.max(1);

        // Largest sizes first, a batch at a time: each batch resumes below the
        // smallest size the last one held.
        let mut below: Option<u64> = None;
        loop {
            let sizes =
                index::duplicate_sizes(connection, request.under, minimum, below, SIZE_BATCH)?;
            if sizes.is_empty() {
                return Ok(());
            }
            for apparent_bytes in sizes {
                below = Some(apparent_bytes);
                if let Some(stop) = self.stop_before_class(maximum_groups) {
                    return self.stop(stop);
                }
                if let Some(stop) = self.class(
                    connection,
                    request.under,
                    apparent_bytes,
                    maximum_groups,
                    maximum_files,
                )? {
                    return self.stop(stop);
                }
            }
        }
    }

    fn stop_before_class(&self, maximum_groups: u32) -> Option<Stop> {
        if self.stopped() {
            return Some(Stop::Cancelled);
        }
        if self.report.groups.len() as u32 >= maximum_groups {
            return Some(Stop::Truncated(maximum_groups));
        }
        None
    }

    /// Partition a class on disk: a directory of a million same-sized files
    /// must not become a million paths and candidates in memory. SQLite's
    /// anonymous database disappears on close and has a bounded page cache.
    fn class(
        &mut self,
        connection: &Connection,
        under: Option<(i64, i64)>,
        apparent_bytes: u64,
        maximum_groups: u32,
        maximum_files: u32,
    ) -> rusqlite::Result<Option<Stop>> {
        let scratch = Connection::open("")?;
        scratch.execute_batch(
            "PRAGMA cache_size = -2048; PRAGMA temp_store = FILE;
            PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;
            CREATE TABLE candidate (id INTEGER PRIMARY KEY, path BLOB NOT NULL,
                device TEXT NOT NULL, inode TEXT NOT NULL, modified TEXT NOT NULL,
                owner INTEGER NOT NULL, group_id INTEGER NOT NULL, permissions INTEGER NOT NULL,
                edge BLOB NOT NULL, full BLOB, UNIQUE(device, inode));
            CREATE INDEX candidate_edge ON candidate(edge);",
        )?;
        let mut resolver = index::PathResolver::new(connection);
        index::visit_files_of_size(connection, under, apparent_bytes, |member| {
            if self.stopped() {
                return Ok(false);
            }
            self.report.candidates_read += 1;
            let path = resolver.path(member.parent_id, &member.name)?;
            let Some((descriptor, candidate)) = self.open_candidate(&path, apparent_bytes) else {
                return Ok(true);
            };
            let file = unsafe { std::os::fd::OwnedFd::from_raw_fd(descriptor) };
            use std::os::fd::{AsRawFd, FromRawFd};
            let device = candidate.device.to_string();
            let inode = candidate.inode.to_string();
            let exists = scratch
                .query_row(
                    "SELECT 1 FROM candidate WHERE device = ?1 AND inode = ?2",
                    params![device, inode],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if exists {
                return Ok(true);
            }
            match content::edge_digest(file.as_raw_fd(), apparent_bytes) {
                Ok(digest) if candidate.unchanged(file.as_raw_fd()) => {
                    scratch.execute(
                        "INSERT INTO candidate
                        (path, device, inode, modified, owner, group_id, permissions, edge)
                        VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                        params![
                            candidate.path,
                            device,
                            inode,
                            candidate.modified_nanoseconds.to_string(),
                            candidate.owner_id,
                            candidate.group_id,
                            candidate.permissions,
                            &digest[..]
                        ],
                    )?;
                    self.report.files_hashed += 1;
                }
                Ok(_) => self.warn(format!(
                    "{} changed while it was being hashed, so it was left out.",
                    String::from_utf8_lossy(&path)
                )),
                Err(error) => self.warn(format!(
                    "{} could not be read, so it was left out: {error}",
                    String::from_utf8_lossy(&path)
                )),
            }
            Ok(true)
        })?;
        if self.stopped() {
            return Ok(Some(Stop::Cancelled));
        }

        let mut surviving = scratch.prepare("SELECT id, path, device, inode, modified, owner, group_id, permissions
            FROM candidate WHERE edge IN (SELECT edge FROM candidate GROUP BY edge HAVING count(*) > 1)
            ORDER BY id")?;
        let mut rows = surviving.query([])?;
        while let Some(row) = rows.next()? {
            if self.stopped() {
                return Ok(Some(Stop::Cancelled));
            }
            let id: i64 = row.get(0)?;
            let previous = candidate_row(row, 1, apparent_bytes)?;
            let Some((descriptor, live)) = self.open_candidate(&previous.path, apparent_bytes)
            else {
                continue;
            };
            use std::os::fd::{AsRawFd, FromRawFd};
            let file = unsafe { std::os::fd::OwnedFd::from_raw_fd(descriptor) };
            if !previous.unchanged(file.as_raw_fd()) {
                self.warn(format!(
                    "{} changed between hashing stages, so it was left out.",
                    String::from_utf8_lossy(&previous.path)
                ));
                continue;
            }
            match full_digest(file.as_raw_fd(), self.cancelled) {
                Ok(Some(digest)) if live.unchanged(file.as_raw_fd()) => {
                    scratch.execute(
                        "UPDATE candidate SET full = ?2 WHERE id = ?1",
                        params![id, &digest[..]],
                    )?;
                }
                Ok(Some(_)) => self.warn(format!(
                    "{} changed while it was being hashed, so it was left out.",
                    String::from_utf8_lossy(&previous.path)
                )),
                Ok(None) => return Ok(Some(Stop::Cancelled)),
                Err(error) => self.warn(format!(
                    "{} could not be read, so it was left out: {error}",
                    String::from_utf8_lossy(&previous.path)
                )),
            }
        }
        drop(rows);
        drop(surviving);
        scratch.execute_batch("CREATE INDEX candidate_full ON candidate(full, path)")?;
        let mut groups = scratch.prepare("SELECT full, count(*) FROM candidate WHERE full IS NOT NULL GROUP BY full HAVING count(*) > 1 ORDER BY full")?;
        let mut rows = groups.query([])?;
        while let Some(row) = rows.next()? {
            if let Some(stop) = self.stop_before_class(maximum_groups) {
                return Ok(Some(stop));
            }
            let bytes: Vec<u8> = row.get(0)?;
            let digest: [u8; 32] = bytes
                .try_into()
                .map_err(|_| rusqlite::Error::InvalidQuery)?;
            let count = row.get::<_, i64>(1)? as u64;
            if count > u64::from(maximum_files) {
                self.warn(format!(
                    "A group of {count} identical files was truncated to {maximum_files}."
                ));
            }
            let mut members = scratch.prepare("SELECT path, device, inode, modified, owner, group_id, permissions FROM candidate WHERE full = ?1 ORDER BY path LIMIT ?2")?;
            let mut selected = members.query(params![&digest[..], maximum_files])?;
            let mut files = Vec::new();
            let mut bounded = false;
            self.reported_bytes += 256;
            while let Some(row) = selected.next()? {
                let candidate = candidate_row(row, 0, apparent_bytes)?;
                // Base64 path bytes plus every decimal metadata field and
                // object punctuation; deliberately above the wire size.
                let bytes = candidate.path.len().saturating_mul(2).saturating_add(512);
                if self.reported_bytes.saturating_add(bytes) > MAX_REPORT_BYTES {
                    bounded = true;
                    break;
                }
                self.reported_bytes += bytes;
                files.push(candidate);
            }
            if files.len() < 2 && bounded {
                return Ok(Some(Stop::ResultBudget));
            }
            self.report.groups.push(Group {
                apparent_bytes,
                digest,
                files,
            });
            if bounded {
                return Ok(Some(Stop::ResultBudget));
            }
        }
        Ok(None)
    }

    /// Stop, and say that the answer is not everything there is.
    ///
    /// Returning the groups found so far while still claiming the answer is
    /// whole would be the one thing a listing of duplicates must not do: a
    /// person would read it as "these are all of them" and act on that.
    fn stop(&mut self, stop: Stop) -> rusqlite::Result<()> {
        self.report.complete = false;
        // These two are never dropped for being late, whatever the cap.
        self.report.warnings.push(match stop {
            Stop::Cancelled => {
                "The search was cancelled; these are the groups found so far.".to_owned()
            }
            Stop::ResultBudget => "The duplicate listing reached its bounded output budget. Narrow the search with a path or a larger minimum size to see more groups.".to_owned(),
            Stop::Truncated(maximum_groups) => format!(
                "Stopped after {maximum_groups} group(s); there are more identical files than \
                 this answer lists. Narrow the search with a path or a larger minimum size."
            ),
        });
        Ok(())
    }

    fn finish(mut self) -> Report {
        if self.suppressed > 0 {
            self.report.warnings.push(format!(
                "{} further files could not be read or were truncated, and were counted but not \
                 listed.",
                self.suppressed
            ));
        }
        self.report
    }
}

impl CandidateFile {
    fn unchanged(&self, descriptor: std::os::fd::RawFd) -> bool {
        sys::metadata_of(descriptor).is_ok_and(|live| {
            live.device == self.device
                && live.inode == self.inode
                && live.kind == EntryKind::File
                && live.apparent_bytes == self.apparent_bytes
                && live.modified_nanoseconds == self.modified_nanoseconds
        })
    }
}

fn candidate_row(
    row: &rusqlite::Row<'_>,
    offset: usize,
    apparent_bytes: u64,
) -> rusqlite::Result<CandidateFile> {
    let number = |column| -> rusqlite::Result<u64> {
        row.get::<_, String>(column)?
            .parse()
            .map_err(|_| rusqlite::Error::InvalidQuery)
    };
    Ok(CandidateFile {
        path: row.get(offset)?,
        device: number(offset + 1)?,
        inode: number(offset + 2)?,
        modified_nanoseconds: number(offset + 3)?,
        apparent_bytes,
        owner_id: row.get(offset + 4)?,
        group_id: row.get(offset + 5)?,
        permissions: row.get(offset + 6)?,
    })
}

/// A SHA-256 of every byte of the file, streamed, or `None` when the search
/// was cancelled partway.
///
/// The same digest `content::full_digest` takes — a test holds the two
/// equal — with one difference: it looks at the cancel flag between reads, so
/// stopping a search over a virtual machine image takes a moment rather than
/// as long as reading the image. Like that one it groups and never
/// authorises; nothing acts on it without comparing the bytes again.
fn full_digest(
    descriptor: std::os::unix::io::RawFd,
    cancelled: &AtomicBool,
) -> std::io::Result<Option<[u8; 32]>> {
    match content::full_digest_cancellable(descriptor, cancelled) {
        Ok(digest) => Ok(Some(digest)),
        Err(error) if crate::transfer::is_cancelled(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

/// Open one candidate read-only and read its live identity.
///
/// The parent is resolved from `/` a segment at a time without following a
/// symlink, the same descent a mutation makes, so a link planted since the
/// scan cannot make this read something outside the tree. A file the index
/// remembers at a different size has changed and is no longer a candidate for
/// this size class.
impl Search<'_> {
    fn open_candidate(
        &mut self,
        path: &[u8],
        apparent_bytes: u64,
    ) -> Option<(std::os::unix::io::RawFd, CandidateFile)> {
        let parent = match guard::resolve_parent(path) {
            Ok(parent) => parent,
            Err(refusal) => {
                self.warn(format!(
                    "{} could not be reached, so it was left out: {}",
                    String::from_utf8_lossy(path),
                    refusal.message,
                ));
                return None;
            }
        };

        let metadata = sys::metadata_at(parent.descriptor(), &parent.name).ok()?;
        if metadata.kind != EntryKind::File || metadata.apparent_bytes != apparent_bytes {
            return None;
        }

        let descriptor = match sys::openat_read_no_symlinks(parent.descriptor(), &parent.name) {
            Ok(descriptor) => descriptor,
            Err(error) => {
                self.warn(format!(
                    "{} could not be opened, so it was left out: {error}",
                    String::from_utf8_lossy(path),
                ));
                return None;
            }
        };

        // The open followed no symlink, but the name could have been replaced
        // between the metadata read and the open. The descriptor's own identity is
        // the one that counts, because it is what was read.
        let opened = match sys::metadata_of(descriptor) {
            Ok(opened)
                if opened.kind == EntryKind::File && opened.apparent_bytes == apparent_bytes =>
            {
                opened
            }
            _ => {
                sys::close(descriptor);
                return None;
            }
        };

        Some((
            descriptor,
            CandidateFile {
                path: path.to_vec(),
                device: opened.device,
                inode: opened.inode,
                apparent_bytes: opened.apparent_bytes,
                modified_nanoseconds: opened.modified_nanoseconds,
                owner_id: opened.owner_id,
                group_id: opened.group_id,
                permissions: opened.permissions,
            },
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::IndexWriter;
    use crate::testing::Sandbox;
    use crate::walk::{Accounting, ScanOptions, walk};
    use std::os::unix::ffi::OsStrExt;

    /// Scan a sandbox and hand back a connection to its index.
    fn scanned(sandbox: &Sandbox, label: &str) -> (Connection, String) {
        let index_directory = sandbox.directory(b".disktop-index");
        let scan_id = format!("scan-duplicates-{label}");
        let roots = vec![sandbox.path().as_os_str().as_bytes().to_vec()];
        let limits = index::IndexLimits::default();
        let mut writer =
            IndexWriter::begin(&index_directory, &scan_id, &roots, "allocated", &limits).unwrap();
        let options = ScanOptions {
            roots,
            cross_filesystems: false,
            excludes: vec![index_directory.as_os_str().as_bytes().to_vec()],
            accounting: Accounting::Allocated,
            throttle_bytes_per_second: None,
            max_depth: None,
        };
        let totals = walk(&options, &mut writer, &AtomicBool::new(false)).unwrap();
        writer.finish(&totals, &limits).unwrap();
        (
            index::open_scan(&index_directory, &scan_id)
                .unwrap()
                .unwrap(),
            scan_id,
        )
    }

    fn request(_scan_id: &str) -> Request {
        Request {
            under: None,
            minimum_bytes: 1,
            maximum_groups: MAX_GROUPS,
            maximum_files_per_group: MAX_FILES_PER_GROUP,
        }
    }

    fn write(sandbox: &Sandbox, name: &str, bytes: &[u8]) {
        std::fs::write(sandbox.path().join(name), bytes).expect("a sandbox file");
    }

    fn names(group: &Group) -> Vec<String> {
        let mut found: Vec<String> = group
            .files
            .iter()
            .map(|file| {
                String::from_utf8_lossy(file.path.rsplit(|byte| *byte == b'/').next().unwrap())
                    .into_owned()
            })
            .collect();
        found.sort();
        found
    }

    #[test]
    fn files_holding_the_same_bytes_are_one_group() {
        let sandbox = Sandbox::new("duplicates-same");
        write(&sandbox, "a", &vec![7u8; 200_000]);
        write(&sandbox, "b", &vec![7u8; 200_000]);
        write(&sandbox, "c", &vec![9u8; 200_000]);

        let (connection, scan_id) = scanned(&sandbox, "same");
        let report = find(&connection, &request(&scan_id), &AtomicBool::new(false)).unwrap();

        assert_eq!(report.groups.len(), 1);
        assert_eq!(names(&report.groups[0]), vec!["a", "b"]);
        assert_eq!(report.groups[0].apparent_bytes, 200_000);
        assert!(report.complete);
    }

    #[test]
    fn a_size_class_that_narrows_to_one_file_is_not_a_group() {
        let sandbox = Sandbox::new("duplicates-lonely");
        write(&sandbox, "a", &vec![7u8; 200_000]);
        write(&sandbox, "b", &vec![9u8; 200_000]);

        let (connection, scan_id) = scanned(&sandbox, "lonely");
        let report = find(&connection, &request(&scan_id), &AtomicBool::new(false)).unwrap();

        assert!(
            report.groups.is_empty(),
            "two different files are not a group"
        );
    }

    #[test]
    fn two_names_for_one_inode_are_not_duplicates() {
        let sandbox = Sandbox::new("duplicates-hardlink");
        write(&sandbox, "a", &vec![7u8; 200_000]);
        sandbox.hardlink(b"a", b"linked");

        let (connection, scan_id) = scanned(&sandbox, "hardlink");
        let report = find(&connection, &request(&scan_id), &AtomicBool::new(false)).unwrap();

        assert!(
            report.groups.is_empty(),
            "removing either name frees nothing, so they are not a pair to act on",
        );
    }

    #[test]
    fn a_third_distinct_file_still_pairs_with_one_of_two_hardlinks() {
        let sandbox = Sandbox::new("duplicates-hardlink-plus");
        write(&sandbox, "a", &vec![7u8; 200_000]);
        sandbox.hardlink(b"a", b"linked");
        write(&sandbox, "copy", &vec![7u8; 200_000]);

        let (connection, scan_id) = scanned(&sandbox, "hardlink-plus");
        let report = find(&connection, &request(&scan_id), &AtomicBool::new(false)).unwrap();

        assert_eq!(report.groups.len(), 1);
        assert_eq!(
            report.groups[0].files.len(),
            2,
            "one inode counted once, plus the copy"
        );
    }

    #[test]
    fn only_regular_files_are_candidates() {
        let sandbox = Sandbox::new("duplicates-kinds");
        sandbox.directory(b"one");
        sandbox.directory(b"two");
        write(&sandbox, "a", &vec![7u8; 200_000]);
        sandbox.symlink(b"a", b"link-one");
        sandbox.symlink(b"a", b"link-two");

        let (connection, scan_id) = scanned(&sandbox, "kinds");
        let report = find(&connection, &request(&scan_id), &AtomicBool::new(false)).unwrap();

        assert!(report.groups.is_empty());
    }

    #[test]
    fn files_below_the_minimum_are_never_read() {
        let sandbox = Sandbox::new("duplicates-minimum");
        write(&sandbox, "a", b"tiny");
        write(&sandbox, "b", b"tiny");

        let (connection, scan_id) = scanned(&sandbox, "minimum");
        let report = find(
            &connection,
            &Request {
                minimum_bytes: 1024,
                ..request(&scan_id)
            },
            &AtomicBool::new(false),
        )
        .unwrap();

        assert!(report.groups.is_empty());
        assert_eq!(report.files_hashed, 0);
    }

    #[test]
    fn files_whose_ends_match_but_whose_middles_differ_are_not_a_group() {
        let sandbox = Sandbox::new("duplicates-middle");
        let length = 300_000;
        let common: Vec<u8> = (0..length).map(|index| index as u8).collect();
        let mut other = common.clone();
        other[length / 2] ^= 0xff;

        write(&sandbox, "a", &common);
        write(&sandbox, "b", &other);

        let (connection, scan_id) = scanned(&sandbox, "middle");
        let report = find(&connection, &request(&scan_id), &AtomicBool::new(false)).unwrap();

        assert!(report.groups.is_empty());
        assert!(
            report.files_hashed >= 2,
            "both files had to be read fully to tell them apart",
        );
    }

    #[test]
    fn a_group_cap_bites_within_one_size_class_too() {
        let sandbox = Sandbox::new("duplicates-cap-one-class");
        // Three pairs, all the same size, so they are all one size class. The
        // cap has to stop the answer inside that class, not only between
        // classes.
        for pair in 0..3u8 {
            let bytes: Vec<u8> = (0..200_000u32)
                .map(|index| (index as u8).wrapping_add(pair))
                .collect();
            write(&sandbox, &format!("a{pair}"), &bytes);
            write(&sandbox, &format!("b{pair}"), &bytes);
        }

        let (connection, scan_id) = scanned(&sandbox, "cap-one-class");
        let report = find(
            &connection,
            &Request {
                maximum_groups: 1,
                ..request(&scan_id)
            },
            &AtomicBool::new(false),
        )
        .unwrap();

        assert_eq!(report.groups.len(), 1, "the cap stopped the answer");
        assert!(
            !report.complete,
            "an answer that dropped groups is not the whole picture",
        );
        assert!(
            report
                .warnings
                .iter()
                .any(|warning| warning.contains("group")),
            "a truncated listing says what it dropped: {:?}",
            report.warnings,
        );
    }

    #[test]
    fn a_group_cap_truncates_the_answer_and_says_so() {
        let sandbox = Sandbox::new("duplicates-cap");
        for pair in 0..3u8 {
            let bytes = vec![pair + 1; 100_000 + usize::from(pair)];
            write(&sandbox, &format!("a{pair}"), &bytes);
            write(&sandbox, &format!("b{pair}"), &bytes);
        }

        let (connection, scan_id) = scanned(&sandbox, "cap");
        let report = find(
            &connection,
            &Request {
                maximum_groups: 2,
                ..request(&scan_id)
            },
            &AtomicBool::new(false),
        )
        .unwrap();

        assert_eq!(report.groups.len(), 2);
        assert!(!report.complete);
        assert!(
            report
                .warnings
                .iter()
                .any(|warning| warning.contains("group")),
            "a truncated listing names what it dropped: {:?}",
            report.warnings,
        );
    }

    #[test]
    fn a_cancelled_search_reports_what_it_had_and_is_not_complete() {
        let sandbox = Sandbox::new("duplicates-cancel");
        write(&sandbox, "a", &vec![7u8; 200_000]);
        write(&sandbox, "b", &vec![7u8; 200_000]);

        let (connection, scan_id) = scanned(&sandbox, "cancel");
        let report = find(&connection, &request(&scan_id), &AtomicBool::new(true)).unwrap();

        assert!(!report.complete);
        assert!(report.groups.is_empty());
    }

    #[test]
    fn a_group_reports_each_files_live_identity() {
        let sandbox = Sandbox::new("duplicates-identity");
        write(&sandbox, "a", &vec![7u8; 200_000]);
        write(&sandbox, "b", &vec![7u8; 200_000]);
        sandbox.chmod(b"b", 0o600);

        let (connection, scan_id) = scanned(&sandbox, "identity");
        let report = find(&connection, &request(&scan_id), &AtomicBool::new(false)).unwrap();

        let group = &report.groups[0];
        let other = group
            .files
            .iter()
            .find(|file| file.path.ends_with(b"/b"))
            .expect("b is in the group");
        assert_eq!(
            other.permissions, 0o600,
            "the mode is read live, not from the index"
        );
        assert_eq!(other.apparent_bytes, 200_000);
        assert_ne!(other.inode, 0);
        assert_eq!(other.owner_id, unsafe { libc::getuid() });
    }

    #[test]
    fn a_subtree_filter_keeps_the_search_inside_that_path() {
        let sandbox = Sandbox::new("duplicates-subtree");
        sandbox.directory(b"inside");
        write(&sandbox, "inside/a", &vec![7u8; 200_000]);
        write(&sandbox, "outside", &vec![7u8; 200_000]);

        let (connection, scan_id) = scanned(&sandbox, "subtree");
        let mut under = sandbox.bytes();
        under.extend_from_slice(b"/inside");
        let range = index::subtree_range(&connection, &under)
            .unwrap()
            .expect("the path is in this scan");

        let report = find(
            &connection,
            &Request {
                under: Some(range),
                ..request(&scan_id)
            },
            &AtomicBool::new(false),
        )
        .unwrap();

        assert!(
            report.groups.is_empty(),
            "the copy outside the searched path is not its pair",
        );
    }

    #[test]
    fn a_cancel_stops_the_search_inside_a_large_file() {
        let sandbox = Sandbox::new("duplicates-cancel-large");
        // Two identical sparse files of a gigabyte each: one size class, two
        // edge digests, and then two full reads that take seconds.
        for name in ["a", "b"] {
            std::fs::File::create(sandbox.path().join(name))
                .and_then(|file| file.set_len(1 << 30))
                .expect("a sparse file");
        }
        let (connection, scan_id) = scanned(&sandbox, "cancel-large");

        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        let canceller = {
            let cancelled = std::sync::Arc::clone(&cancelled);
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(50));
                cancelled.store(true, Ordering::Relaxed);
            })
        };
        let started = std::time::Instant::now();
        let report = find(&connection, &request(&scan_id), &cancelled).unwrap();
        let elapsed = started.elapsed();
        canceller.join().unwrap();

        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "the search ran for {elapsed:?} after being asked to stop"
        );
        assert!(!report.complete);
        assert!(report.groups.is_empty());
        assert!(
            report
                .warnings
                .iter()
                .any(|warning| warning.contains("cancelled")),
            "{:?}",
            report.warnings
        );
    }

    #[test]
    fn the_digest_that_groups_files_is_the_sha256_of_their_content() {
        use std::os::unix::io::AsRawFd;
        let sandbox = Sandbox::new("duplicates-digest");
        let bytes: Vec<u8> = (0..1_000_003u32).map(|index| (index % 251) as u8).collect();
        write(&sandbox, "a", &bytes);
        let file = std::fs::File::open(sandbox.path().join("a")).unwrap();

        let streamed = full_digest(file.as_raw_fd(), &AtomicBool::new(false))
            .unwrap()
            .expect("not cancelled");
        assert_eq!(
            streamed,
            content::full_digest(file.as_raw_fd()).unwrap(),
            "the cancellable digest drifted from the one content.rs defines"
        );
    }

    #[test]
    fn unreadable_candidates_are_counted_without_growing_the_warnings_for_ever() {
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let sandbox = Sandbox::new("duplicates-unreadable");
        let count = MAX_WARNINGS + 40;
        for index in 0..count {
            let name = format!("locked-{index}");
            write(&sandbox, &name, &vec![3u8; 4096]);
            sandbox.chmod(name.as_bytes(), 0o000);
        }
        let (connection, scan_id) = scanned(&sandbox, "unreadable");

        let report = find(&connection, &request(&scan_id), &AtomicBool::new(false)).unwrap();
        for index in 0..count {
            sandbox.chmod(format!("locked-{index}").as_bytes(), 0o600);
        }

        assert!(!report.complete);
        assert!(
            report.warnings.len() <= MAX_WARNINGS + 1,
            "{} warnings",
            report.warnings.len()
        );
        assert!(
            report
                .warnings
                .iter()
                .any(|warning| warning.contains("40 further")),
            "the overflow is summarised rather than dropped: {:?}",
            report.warnings.last()
        );
    }
}
