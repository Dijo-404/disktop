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
use rusqlite::Connection;
use std::collections::HashMap;
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

/// Read one scan's index and report the groups of identical files in it.
pub fn find(
    connection: &Connection,
    request: &Request,
    cancelled: &AtomicBool,
) -> rusqlite::Result<Report> {
    let mut report = Report {
        groups: Vec::new(),
        complete: true,
        warnings: Vec::new(),
        candidates_read: 0,
        files_hashed: 0,
    };

    let classes = index::size_candidates(connection, request.under, request.minimum_bytes.max(1))?;
    let mut resolver = index::PathResolver::new(connection);

    let maximum_groups = request.maximum_groups.min(MAX_GROUPS);
    let maximum_files = request.maximum_files_per_group.min(MAX_FILES_PER_GROUP);

    for (apparent_bytes, members) in classes {
        if cancelled.load(Ordering::Relaxed) {
            report.complete = false;
            report
                .warnings
                .push("The search was cancelled; these are the groups found so far.".to_owned());
            return Ok(report);
        }
        if report.groups.len() as u32 >= maximum_groups {
            return Ok(truncated(report, maximum_groups));
        }

        report.candidates_read += members.len() as u64;
        let mut paths = Vec::with_capacity(members.len());
        for member in &members {
            paths.push(resolver.path(member.parent_id, &member.name)?);
        }

        // Each stage narrows the last one's survivors, so a file alone in its
        // size class is never opened and a file alone after the edge digest is
        // never read through.
        // One size class can hold more groups than the cap allows, so the cap
        // is checked where a group is added rather than only between classes.
        // Leaving the loop without saying so would drop groups from an answer
        // that still called itself whole.
        let edges = partition(&paths, apparent_bytes, Stage::Edges, &mut report);
        for (_, bucket) in edges {
            let full = partition(&bucket, apparent_bytes, Stage::Whole, &mut report);
            for (digest, mut group) in full {
                group.sort_by(|left, right| left.path.cmp(&right.path));
                if group.len() < 2 {
                    continue;
                }
                if report.groups.len() as u32 >= maximum_groups {
                    return Ok(truncated(report, maximum_groups));
                }
                if group.len() as u32 > maximum_files {
                    report.complete = false;
                    report.warnings.push(format!(
                        "A group of {} identical files was truncated to {maximum_files}.",
                        group.len(),
                    ));
                    group.truncate(maximum_files as usize);
                }
                report.groups.push(Group {
                    apparent_bytes,
                    digest,
                    files: group,
                });
            }
        }
    }

    Ok(report)
}

/// Stop, and say that the answer is not everything there is.
///
/// Returning the groups found so far while still claiming the answer is whole
/// would be the one thing a listing of duplicates must not do: a person would
/// read it as "these are all of them" and act on that.
fn truncated(mut report: Report, maximum_groups: u32) -> Report {
    report.complete = false;
    report.warnings.push(format!(
        "Stopped after {maximum_groups} group(s); there are more identical files than this \
         answer lists. Narrow the search with a path or a larger minimum size."
    ));
    report
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Edges,
    Whole,
}

/// Split a set of candidates by digest, keeping only the buckets with a twin.
///
/// The first stage takes paths and opens them; the second takes the candidates
/// the first already opened and identified, so a file is stat'd once however
/// many stages it survives.
fn partition<T: Candidate>(
    members: &[T],
    apparent_bytes: u64,
    stage: Stage,
    report: &mut Report,
) -> Vec<([u8; 32], Vec<CandidateFile>)> {
    let mut buckets: HashMap<[u8; 32], Vec<CandidateFile>> = HashMap::new();
    let mut seen: HashMap<(u64, u64), ()> = HashMap::new();

    for member in members {
        let path = member.path();
        let Some((file, candidate)) = open_candidate(path, apparent_bytes, report) else {
            continue;
        };

        // One inode, however many names reach it. Removing the second name
        // frees nothing, so it is not a member of a group somebody will act on.
        if seen
            .insert((candidate.device, candidate.inode), ())
            .is_some()
        {
            sys::close(file);
            continue;
        }

        let digest = match stage {
            Stage::Edges => content::edge_digest(file, candidate.apparent_bytes),
            Stage::Whole => content::full_digest(file),
        };
        sys::close(file);

        match digest {
            Ok(digest) => {
                // Counted at the first stage only. The second stage re-reads a
                // subset of these files, and counting that would make the
                // number larger than the candidates it came from.
                if stage == Stage::Edges {
                    report.files_hashed += 1;
                }
                buckets.entry(digest).or_default().push(candidate);
            }
            Err(error) => {
                report.complete = false;
                report.warnings.push(format!(
                    "{} could not be read, so it was left out: {error}",
                    String::from_utf8_lossy(path),
                ));
            }
        }
    }

    buckets.retain(|_, group| group.len() > 1);
    buckets.into_iter().collect()
}

/// Open one candidate read-only and read its live identity.
///
/// The parent is resolved from `/` a segment at a time without following a
/// symlink, the same descent a mutation makes, so a link planted since the
/// scan cannot make this read something outside the tree. A file the index
/// remembers at a different size has changed and is no longer a candidate for
/// this size class.
fn open_candidate(
    path: &[u8],
    apparent_bytes: u64,
    report: &mut Report,
) -> Option<(std::os::unix::io::RawFd, CandidateFile)> {
    let parent = match guard::resolve_parent(path) {
        Ok(parent) => parent,
        Err(refusal) => {
            report.complete = false;
            report.warnings.push(format!(
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
            report.complete = false;
            report.warnings.push(format!(
                "{} could not be opened, so it was left out: {error}",
                String::from_utf8_lossy(path),
            ));
            return None;
        }
    };

    // The open followed no symlink, but the name could have been replaced
    // between the metadata read and the open. The descriptor's own identity is
    // the one that counts, because it is what was read.
    let opened = sys::metadata_of(descriptor).ok()?;
    if opened.kind != EntryKind::File || opened.apparent_bytes != apparent_bytes {
        sys::close(descriptor);
        return None;
    }

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

/// Something with a path, so the two stages can share one partitioner.
trait Candidate {
    fn path(&self) -> &[u8];
}

impl Candidate for Vec<u8> {
    fn path(&self) -> &[u8] {
        self
    }
}

impl Candidate for CandidateFile {
    fn path(&self) -> &[u8] {
        &self.path
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
}
