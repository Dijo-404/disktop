//! The operations that change a user file.
//!
//! Every one of them runs the same sequence, in this order and no other:
//! classify the target against the policy no flag unlocks, resolve its parent
//! without following a symlink, compare its live identity against the
//! fingerprint the reviewed plan recorded, write the intent to the durable
//! journal, perform one constrained syscall, write the outcome, and report the
//! item. An item that fails any step stops at that step and the next item
//! begins; nothing here continues past a refusal and nothing here invents a
//! fallback.
//!
//! Trash is a rename, so it is cheap and reversible and frees nothing until
//! Trash is emptied. That last part is why the result keeps bytes moved to
//! Trash and the filesystem's own before-and-after readings as separate
//! numbers: on one filesystem the first is large and the second is zero, and
//! presenting either as the other would be a lie about reclaimed space.

use crate::guard::{self, Fingerprint, Guard, GuardContext};
use crate::journal::{Counts, Journal, Outcome, State};
use crate::sys::{self, EntryKind};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

/// Disktop's own directories are private to the user who owns them, and so is
/// a Trash directory it has to create.
const PRIVATE_DIRECTORY_MODE: u32 = 0o700;
const PRIVATE_FILE_MODE: u32 = 0o600;

pub struct Target {
    pub path: Vec<u8>,
    pub expected: Fingerprint,
    /// What the reviewed plan measured for this entry. The helper does not
    /// re-measure a subtree it is about to rename in one syscall; it reports
    /// the plan's own number, partitioned by what actually happened to it.
    pub reviewed_bytes: u64,
}

pub struct TrashRequest {
    pub plan_id: String,
    pub journal_directory: PathBuf,
    /// `$XDG_DATA_HOME/Trash`. Node owns the location, as it owns the index
    /// and journal directories, so the XDG rules live in one place.
    pub home_trash_directory: Vec<u8>,
    pub targets: Vec<Target>,
}

pub struct ItemReport {
    pub path: Vec<u8>,
    pub outcome: Outcome,
    pub reason: Option<&'static str>,
    pub message: Option<String>,
    pub bytes: u64,
}

pub struct ActionSummary {
    pub journal_id: String,
    pub state: State,
    pub completed: u64,
    pub skipped: u64,
    pub failed: u64,
    pub selected_bytes: u64,
    pub bytes_moved_to_trash: u64,
    pub free_bytes_before: Option<u64>,
    pub free_bytes_after: Option<u64>,
    pub undo_available: bool,
}

/// A refusal that stops the whole request before any item is attempted.
pub struct ActionRefusal {
    pub code: &'static str,
    pub message: String,
}

impl ActionRefusal {
    fn new(code: &'static str, message: impl Into<String>) -> ActionRefusal {
        ActionRefusal {
            code,
            message: message.into(),
        }
    }
}

/// Move every reviewed target to Trash, reporting each item as it settles.
pub fn run_trash(
    request: &TrashRequest,
    report: &mut dyn FnMut(ItemReport),
    cancelled: &AtomicBool,
) -> Result<ActionSummary, ActionRefusal> {
    let guard = Guard::new(&GuardContext {
        journal_directory: Some(
            request
                .journal_directory
                .as_os_str()
                .as_encoded_bytes()
                .to_vec(),
        ),
    })
    .map_err(|refusal| ActionRefusal::new(refusal.code, refusal.message))?;

    let journal = Journal::open(&request.journal_directory).map_err(|error| {
        ActionRefusal::new(
            "journal-write-failed",
            format!("The action journal could not be opened: {error}"),
        )
    })?;

    // Read free space before anything moves, on the filesystem holding the
    // first target's parent: the target itself is about to stop existing there.
    let anchor = request
        .targets
        .first()
        .map(|target| parent_path(&target.path));
    let free_before = anchor.as_deref().and_then(guard::free_bytes);

    let journal_id = journal
        .begin(&request.plan_id, "trash", free_before)
        .map_err(|error| {
            ActionRefusal::new(
                "journal-write-failed",
                format!("The action's intent could not be recorded: {error}"),
            )
        })?;

    let mut counts = Counts::default();
    let mut undo_available = false;
    let mut cancelled_early = false;

    for (position, target) in request.targets.iter().enumerate() {
        counts.selected_bytes = counts.selected_bytes.saturating_add(target.reviewed_bytes);

        // Cancellation is read between items and never inside one. Stopping
        // halfway through a rename is not something the kernel offers, and
        // stopping between the metadata and the rename would leave a
        // reservation behind with nothing to explain it.
        if cancelled.load(Ordering::Relaxed) {
            cancelled_early = true;
            report(ItemReport {
                path: target.path.clone(),
                outcome: Outcome::Skipped,
                reason: Some("cancelled"),
                message: Some("Stopped before this item; nothing was changed.".to_owned()),
                bytes: 0,
            });
            counts.skipped += 1;
            continue;
        }

        let outcome = trash_one(
            &guard,
            &request.home_trash_directory,
            &journal,
            &journal_id,
            position as u64,
            target,
        );
        match &outcome.outcome {
            Outcome::Completed => {
                counts.completed += 1;
                counts.trashed_bytes = counts.trashed_bytes.saturating_add(target.reviewed_bytes);
                undo_available = true;
            }
            Outcome::Skipped => counts.skipped += 1,
            _ => counts.failed += 1,
        }
        report(outcome);
    }

    let free_after = anchor.as_deref().and_then(guard::free_bytes);
    let state = if counts.skipped == 0 && counts.failed == 0 && !cancelled_early {
        State::Complete
    } else {
        State::Partial
    };
    if let Err(error) = journal.finish(&journal_id, state, &counts, free_after) {
        return Err(ActionRefusal::new(
            "journal-write-failed",
            format!("The action's outcome could not be recorded: {error}"),
        ));
    }

    Ok(ActionSummary {
        journal_id,
        state,
        completed: counts.completed,
        skipped: counts.skipped,
        failed: counts.failed,
        selected_bytes: counts.selected_bytes,
        bytes_moved_to_trash: counts.trashed_bytes,
        free_bytes_before: free_before,
        free_bytes_after: free_after,
        undo_available,
    })
}

fn trash_one(
    guard: &Guard,
    home_trash: &[u8],
    journal: &Journal,
    journal_id: &str,
    position: u64,
    target: &Target,
) -> ItemReport {
    let refuse = |code: &'static str, message: String, outcome: Outcome| ItemReport {
        path: target.path.clone(),
        outcome,
        reason: Some(code),
        message: Some(message),
        bytes: 0,
    };

    if let Err(refusal) = guard.classify(&target.path) {
        return refuse(refusal.code, refusal.message, Outcome::Failed);
    }
    let parent = match guard::resolve_parent(&target.path) {
        Ok(parent) => parent,
        Err(refusal) => {
            let outcome = outcome_for(refusal.code);
            return refuse(refusal.code, refusal.message, outcome);
        }
    };
    let live = match guard::revalidate(&parent, &target.expected) {
        Ok(live) => live,
        Err(refusal) => {
            let outcome = outcome_for(refusal.code);
            return refuse(refusal.code, refusal.message, outcome);
        }
    };

    let destination = match choose_trash(guard, home_trash, &target.path, live.device) {
        Ok(destination) => destination,
        Err(refusal) => return refuse(refusal.code, refusal.message, Outcome::Failed),
    };

    let reserved = match reserve(&destination, &parent.name, &target.path) {
        Ok(reserved) => reserved,
        Err(refusal) => return refuse(refusal.code, refusal.message, Outcome::Failed),
    };

    let mut final_path = destination.files_path.clone();
    final_path.push(b'/');
    final_path.extend_from_slice(&reserved.name);

    // The intent goes to disk before the rename, so a crash in the next
    // microsecond leaves a record that says what was about to happen.
    if let Err(error) = journal.record_intent(journal_id, position, &target.path, Some(&final_path))
    {
        reserved.discard(&destination);
        return refuse(
            "journal-write-failed",
            format!("This item's intent could not be recorded, so it was not moved: {error}"),
            Outcome::Failed,
        );
    }

    let moved = sys::renameat_no_replace(
        parent.descriptor(),
        &parent.name,
        destination.files_descriptor,
        &reserved.name,
    );

    let report = match moved {
        Ok(()) => ItemReport {
            path: target.path.clone(),
            outcome: Outcome::Completed,
            reason: None,
            message: None,
            bytes: target.reviewed_bytes,
        },
        Err(error) => {
            reserved.discard(&destination);
            let (code, message) = match error.raw_os_error() {
                Some(libc::EXDEV) => (
                    "unsupported-filesystem",
                    "Trash for this filesystem is on another device, which needs a copy rather \
                     than a rename. Plan a move instead."
                        .to_owned(),
                ),
                Some(libc::EACCES) | Some(libc::EPERM) => (
                    "permission-denied",
                    format!("This user may not move the target: {error}"),
                ),
                Some(libc::ENOENT) => (
                    "changed-target",
                    "The target went away between the check and the move.".to_owned(),
                ),
                _ => (
                    "internal-error",
                    format!("The move into Trash failed: {error}"),
                ),
            };
            ItemReport {
                path: target.path.clone(),
                outcome: Outcome::Failed,
                reason: Some(code),
                message: Some(message),
                bytes: 0,
            }
        }
    };

    let _ = journal.record_outcome(
        journal_id,
        position,
        report.outcome,
        report.message.as_deref(),
        report.bytes,
        None,
    );
    report
}

/// A refusal to resolve or revalidate is not a failure of this action: the
/// thing it named is not what the plan reviewed, so the item is skipped and
/// everything else goes ahead. A protected path or a denied permission is a
/// failure, because the plan asked for something it may not have.
fn outcome_for(code: &str) -> Outcome {
    match code {
        "changed-target" => Outcome::Skipped,
        _ => Outcome::Failed,
    }
}

struct TrashDirectory {
    /// Where the moved files live, as a path and as an open descriptor.
    files_path: Vec<u8>,
    files_descriptor: libc::c_int,
    info_descriptor: libc::c_int,
    /// The mount the Trash belongs to, when it is not the home one. The
    /// specification stores a path relative to this.
    top_directory: Option<Vec<u8>>,
}

impl Drop for TrashDirectory {
    fn drop(&mut self) {
        sys::close(self.files_descriptor);
        sys::close(self.info_descriptor);
    }
}

/// Pick the Trash this target belongs in, per the freedesktop specification.
///
/// The home Trash takes anything on the same filesystem. Anything else goes to
/// the top of its own mount: an administrator-provided `.Trash/<uid>` when it
/// is a sticky directory and not a symlink, and otherwise a `.Trash-<uid>` this
/// user creates. If neither can be established the item refuses; it is never
/// quietly deleted instead.
fn choose_trash(
    guard: &Guard,
    home_trash: &[u8],
    path: &[u8],
    device: u64,
) -> Result<TrashDirectory, guard::Refusal> {
    if let Some(home) = open_home_trash(home_trash, device) {
        return Ok(home);
    }

    let Some(top) = guard.mount_point_for(path) else {
        return Err(refusal(
            "no-safe-trash",
            "No mount holding this path could be identified, so no Trash could be chosen.",
        ));
    };

    if let Some(administrator) = open_administrator_trash(&top) {
        return Ok(administrator);
    }
    open_user_trash(&top).ok_or_else(|| {
        refusal(
            "no-safe-trash",
            "No Trash directory could be created on the filesystem holding this path.",
        )
    })
}

fn refusal(code: &'static str, message: &str) -> guard::Refusal {
    guard::Refusal {
        code,
        message: message.to_owned(),
    }
}

fn open_home_trash(path: &[u8], device: u64) -> Option<TrashDirectory> {
    let created = create_directory_chain(path)?;
    let metadata = sys::metadata_of(created).ok();
    sys::close(created);
    // Only when the target is on the same filesystem: a rename cannot cross a
    // device, and copying is a different, reviewable operation.
    if metadata.map(|metadata| metadata.device) != Some(device) {
        return None;
    }
    open_trash_pair(path, None)
}

fn open_administrator_trash(top: &[u8]) -> Option<TrashDirectory> {
    let mut shared = top.to_vec();
    if shared.last() != Some(&b'/') {
        shared.push(b'/');
    }
    shared.extend_from_slice(b".Trash");

    let parent = guard::resolve_parent(&shared).ok()?;
    let metadata = sys::metadata_at(parent.descriptor(), &parent.name).ok()?;
    // A `.Trash` that is a symlink, or that anybody can write without the
    // sticky bit, is the one thing the specification says to refuse outright.
    if metadata.kind != EntryKind::Directory || metadata.writable_by_anyone_without_sticky {
        return None;
    }

    let mut mine = shared.clone();
    mine.push(b'/');
    mine.extend_from_slice(uid_text().as_bytes());
    create_directory_chain(&mine).map(sys::close)?;
    open_trash_pair(&mine, Some(top.to_vec()))
}

fn open_user_trash(top: &[u8]) -> Option<TrashDirectory> {
    let mut mine = top.to_vec();
    if mine.last() != Some(&b'/') {
        mine.push(b'/');
    }
    mine.extend_from_slice(format!(".Trash-{}", uid_text()).as_bytes());
    create_directory_chain(&mine).map(sys::close)?;
    open_trash_pair(&mine, Some(top.to_vec()))
}

fn open_trash_pair(trash: &[u8], top_directory: Option<Vec<u8>>) -> Option<TrashDirectory> {
    let mut files_path = trash.to_vec();
    files_path.extend_from_slice(b"/files");
    let mut info_path = trash.to_vec();
    info_path.extend_from_slice(b"/info");

    let files_descriptor = create_directory_chain(&files_path)?;
    let Some(info_descriptor) = create_directory_chain(&info_path) else {
        sys::close(files_descriptor);
        return None;
    };
    Some(TrashDirectory {
        files_path,
        files_descriptor,
        info_descriptor,
        top_directory,
    })
}

/// Create a directory and everything above it, descending without ever
/// following a symlink, and return it held open.
fn create_directory_chain(path: &[u8]) -> Option<libc::c_int> {
    if !guard::is_absolute_normalised(path) || path == b"/" {
        return None;
    }
    let mut descriptor = sys::open_filesystem_root().ok()?;
    for segment in path[1..].split(|byte| *byte == b'/') {
        if sys::mkdirat(descriptor, segment, PRIVATE_DIRECTORY_MODE).is_err() {
            // An existing directory is fine; anything else refuses here.
            let existing = sys::metadata_at(descriptor, segment);
            if existing.map(|metadata| metadata.kind).ok() != Some(EntryKind::Directory) {
                sys::close(descriptor);
                return None;
            }
        }
        match sys::open_directory_no_symlinks(descriptor, segment) {
            Ok(next) => {
                sys::close(descriptor);
                descriptor = next;
            }
            Err(_) => {
                sys::close(descriptor);
                return None;
            }
        }
    }
    Some(descriptor)
}

struct Reservation {
    name: Vec<u8>,
    info_name: Vec<u8>,
}

impl Reservation {
    /// Give the name back when the move that was going to use it did not
    /// happen. A `.trashinfo` describing a file that is not in Trash would
    /// make the next listing lie.
    fn discard(&self, destination: &TrashDirectory) {
        let _ = sys::unlinkat(destination.info_descriptor, &self.info_name, false);
    }
}

/// Claim a name in Trash by creating its metadata file exclusively.
///
/// The exclusive create is the lock. Two Disktops, or a Disktop and a file
/// manager, cannot both believe they own `notes.txt`, because only one of them
/// gets to create `notes.txt.trashinfo`.
fn reserve(
    destination: &TrashDirectory,
    name: &[u8],
    original: &[u8],
) -> Result<Reservation, guard::Refusal> {
    let recorded = match &destination.top_directory {
        // The specification stores a path relative to the top directory for a
        // Trash that is not the home one, so the files survive the filesystem
        // being mounted somewhere else.
        Some(top) => relative_to(top, original),
        None => original.to_vec(),
    };
    let encoded = percent_encode(&recorded);
    let date = deletion_date();

    for attempt in 0..1000u32 {
        let candidate = candidate_name(name, attempt);
        let mut info_name = candidate.clone();
        info_name.extend_from_slice(b".trashinfo");

        match sys::openat_write_exclusive(
            destination.info_descriptor,
            &info_name,
            PRIVATE_FILE_MODE,
        ) {
            Ok(descriptor) => {
                let body = format!("[Trash Info]\nPath={encoded}\nDeletionDate={date}\n");
                let written = write_all(descriptor, body.as_bytes())
                    .and_then(|()| sys::fsync(descriptor))
                    .and_then(|()| sys::fsync(destination.info_descriptor));
                sys::close(descriptor);
                if let Err(error) = written {
                    let _ = sys::unlinkat(destination.info_descriptor, &info_name, false);
                    return Err(refusal(
                        "no-safe-trash",
                        &format!("The Trash metadata could not be written: {error}"),
                    ));
                }
                return Ok(Reservation {
                    name: candidate,
                    info_name,
                });
            }
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => continue,
            Err(error) => {
                return Err(refusal(
                    "no-safe-trash",
                    &format!("A name in Trash could not be reserved: {error}"),
                ));
            }
        }
    }
    Err(refusal(
        "no-safe-trash",
        "A thousand names in Trash were already taken for this file.",
    ))
}

/// `notes.txt`, then `notes.1.txt`, and so on, so the extension keeps working.
fn candidate_name(name: &[u8], attempt: u32) -> Vec<u8> {
    if attempt == 0 {
        return name.to_vec();
    }
    let dot = name
        .iter()
        .rposition(|byte| *byte == b'.')
        .filter(|position| *position > 0);
    let mut candidate = Vec::with_capacity(name.len() + 8);
    match dot {
        Some(position) => {
            candidate.extend_from_slice(&name[..position]);
            candidate.extend_from_slice(format!(".{attempt}").as_bytes());
            candidate.extend_from_slice(&name[position..]);
        }
        None => {
            candidate.extend_from_slice(name);
            candidate.extend_from_slice(format!(".{attempt}").as_bytes());
        }
    }
    candidate
}

fn relative_to(top: &[u8], path: &[u8]) -> Vec<u8> {
    if guard::is_within(top, path) && path.len() > top.len() {
        let start = if top.last() == Some(&b'/') {
            top.len()
        } else {
            top.len() + 1
        };
        return path[start..].to_vec();
    }
    path.to_vec()
}

/// Percent-encode path bytes for a `.trashinfo` file, leaving the unreserved
/// set and the separator alone. Raw bytes go through byte by byte, so a name
/// that is not valid UTF-8 survives a round trip.
pub fn percent_encode(path: &[u8]) -> String {
    let mut encoded = String::with_capacity(path.len());
    for byte in path {
        let unreserved = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' | b'/'
            );
        if unreserved {
            encoded.push(*byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// Local time with no offset, as the Trash specification requires. The kernel
/// and libc own the calendar; nothing here does date arithmetic.
fn deletion_date() -> String {
    let now = unsafe { libc::time(std::ptr::null_mut()) };
    let mut parts: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&now, &mut parts) }.is_null() {
        return "1970-01-01T00:00:00".to_owned();
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        parts.tm_year + 1900,
        parts.tm_mon + 1,
        parts.tm_mday,
        parts.tm_hour,
        parts.tm_min,
        parts.tm_sec.min(59),
    )
}

fn write_all(descriptor: libc::c_int, mut bytes: &[u8]) -> std::io::Result<()> {
    while !bytes.is_empty() {
        let written = unsafe {
            libc::write(
                descriptor,
                bytes.as_ptr() as *const libc::c_void,
                bytes.len(),
            )
        };
        if written < 0 {
            return Err(std::io::Error::last_os_error());
        }
        bytes = &bytes[written as usize..];
    }
    Ok(())
}

fn uid_text() -> String {
    unsafe { libc::getuid() }.to_string()
}

fn parent_path(path: &[u8]) -> Vec<u8> {
    match path.iter().rposition(|byte| *byte == b'/') {
        Some(0) | None => b"/".to_vec(),
        Some(position) => path[..position].to_vec(),
    }
}
