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

use crate::content;
use crate::guard::{self, Fingerprint, Guard, GuardContext};
use crate::journal::{Counts, Identity, Journal, Outcome, State};
use crate::sys::{self, EntryKind};
use std::path::{Path, PathBuf};
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

/// A permanent removal. There is no Trash here and no undo; the plan that
/// authorised it said so, and `--permanent` at apply time only acknowledged
/// what that plan already contained.
pub struct EraseRequest {
    pub plan_id: String,
    pub journal_directory: PathBuf,
    pub targets: Vec<Target>,
}

/// Emptying Trash. Each directory must look like a Trash before anything in it
/// is touched, so a plan that named the wrong directory cannot erase somebody's
/// documents on the strength of being listed as Trash.
pub struct EmptyTrashRequest {
    pub plan_id: String,
    pub journal_directory: PathBuf,
    /// `$XDG_DATA_HOME/Trash`, so the helper can recognise it without asking
    /// Node which directories it is allowed to empty.
    pub home_trash_directory: Vec<u8>,
    pub trash_directories: Vec<Vec<u8>>,
}

/// Putting back what a Trash move moved. The journal is the authority for
/// where each item went and where it came from; nothing is reconstructed from
/// a path the caller supplied.
pub struct RestoreRequest {
    pub journal_directory: PathBuf,
    pub journal_id: String,
}

/// Replacing duplicates with links to one file that is kept.
///
/// The kept file is validated once, before any item: it is the thing every
/// target becomes, so a kept file that is not what the plan reviewed makes the
/// whole request wrong rather than one item of it.
pub struct DedupHardlinkRequest {
    pub plan_id: String,
    pub journal_directory: PathBuf,
    pub keep: Target,
    pub targets: Vec<Target>,
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
    let home_trash = request.home_trash_directory.clone();
    run_action(
        Operation::Trash,
        &request.plan_id,
        &request.journal_directory,
        &request.targets,
        report,
        cancelled,
        |guard, journal, journal_id, position, target| {
            trash_one(guard, &home_trash, journal, journal_id, position, target)
        },
    )
}

/// Remove every reviewed target permanently. Nothing here is recoverable, and
/// the result says so: no bytes moved to Trash, and no undo.
pub fn run_erase(
    request: &EraseRequest,
    report: &mut dyn FnMut(ItemReport),
    cancelled: &AtomicBool,
) -> Result<ActionSummary, ActionRefusal> {
    run_action(
        Operation::Erase,
        &request.plan_id,
        &request.journal_directory,
        &request.targets,
        report,
        cancelled,
        erase_one,
    )
}

/// Replace every reviewed duplicate with a link to the file being kept.
///
/// Nothing here is recoverable once the last other name to an inode is gone,
/// which is why the plan that authorised it is irreversible and why the byte
/// compare below is not optional. The digests that grouped these files said
/// they were probably identical; this reads both files in full and refuses
/// unless they are.
pub fn run_dedup_hardlink(
    request: &DedupHardlinkRequest,
    report: &mut dyn FnMut(ItemReport),
    cancelled: &AtomicBool,
) -> Result<ActionSummary, ActionRefusal> {
    // The kept file is validated once, before anything is linked to it. A
    // kept file that is not what the plan reviewed makes every item wrong, so
    // it refuses the request rather than failing each target in turn.
    let keep_parent = guard::resolve_parent(&request.keep.path)
        .map_err(|refusal| ActionRefusal::new(refusal.code, refusal.message))?;
    let keep_live = guard::revalidate(&keep_parent, &request.keep.expected)
        .map_err(|refusal| ActionRefusal::new(refusal.code, refusal.message))?;
    if keep_live.kind != EntryKind::File {
        return Err(ActionRefusal::new(
            "invalid-arguments",
            "The file being kept is not a regular file, so nothing can be linked to it.",
        ));
    }

    let keep_descriptor = sys::openat_read_no_symlinks(keep_parent.descriptor(), &keep_parent.name)
        .map_err(|error| {
            ActionRefusal::new(
                "permission-denied",
                format!("The file being kept could not be opened: {error}"),
            )
        })?;
    let keep = KeptFile {
        descriptor: keep_descriptor,
        parent: keep_parent,
        metadata: keep_live,
    };

    let outcome = run_action(
        Operation::DedupHardlink,
        &request.plan_id,
        &request.journal_directory,
        &request.targets,
        report,
        cancelled,
        |guard, journal, journal_id, position, target| {
            hardlink_one(guard, &keep, journal, journal_id, position, target)
        },
    );
    sys::close(keep.descriptor);
    outcome
}

/// The file every target becomes a name for, held open for the whole action.
///
/// Holding the descriptor is what makes the byte compare mean something: the
/// bytes compared are the bytes of the inode that gets linked, not of whatever
/// the kept path happens to name a moment later.
struct KeptFile {
    descriptor: std::os::unix::io::RawFd,
    parent: guard::ResolvedParent,
    metadata: sys::Metadata,
}

/// Replace one duplicate with a link to the kept file.
///
/// The order matters. Identity is checked before content, because comparing
/// two files that are already one inode is pointless and replacing one with a
/// link to itself would be worse. Content is checked before metadata is
/// trusted and before the journal is written, because a file whose bytes do
/// not match is not this operation's business at all. And the link is made
/// under a staging name and exchanged, so the reviewed name never points at
/// nothing: either it holds the old inode or it holds the kept one.
fn hardlink_one(
    guard: &Guard,
    keep: &KeptFile,
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

    if live.kind != EntryKind::File {
        return refuse(
            "invalid-arguments",
            "Only a regular file can be replaced by a hardlink.".to_owned(),
            Outcome::Failed,
        );
    }
    if live.device != keep.metadata.device {
        return refuse(
            "different-filesystem",
            "A hardlink cannot cross a filesystem, so this file cannot become a name for the one \
             being kept."
                .to_owned(),
            Outcome::Failed,
        );
    }
    if live.inode == keep.metadata.inode {
        // Already one inode reached by two names. Replacing it would free
        // nothing and would briefly point the name at a staging link to itself.
        return refuse(
            "already-linked",
            "This name already reaches the file being kept, so removing it would free nothing."
                .to_owned(),
            Outcome::Skipped,
        );
    }
    if live.owner_id != keep.metadata.owner_id
        || live.group_id != keep.metadata.group_id
        || live.permissions != keep.metadata.permissions
    {
        return refuse(
            "metadata-incompatible",
            "This file's owner, group, or permissions differ from the file being kept. One inode \
             has one set of them, so linking would silently change this file's."
                .to_owned(),
            Outcome::Failed,
        );
    }

    let descriptor = match sys::openat_read_no_symlinks(parent.descriptor(), &parent.name) {
        Ok(descriptor) => descriptor,
        Err(error) => {
            return refuse(
                "permission-denied",
                format!("This file could not be opened to compare it: {error}"),
                Outcome::Failed,
            );
        }
    };
    // The gate. A digest said these were probably identical; this is the only
    // thing that says they are. See docs/adr/0006.
    let identical = content::bytes_equal(keep.descriptor, descriptor);
    sys::close(descriptor);
    match identical {
        Ok(true) => {}
        Ok(false) => {
            return refuse(
                "content-changed",
                "This file does not hold the same bytes as the file being kept, so it was left \
                 alone."
                    .to_owned(),
                Outcome::Failed,
            );
        }
        Err(error) => {
            return refuse(
                "permission-denied",
                format!("The two files could not be compared, so neither was changed: {error}"),
                Outcome::Failed,
            );
        }
    }

    // The intent names both paths, so an interrupted item is legible: the
    // record says which file was about to become a name for which other one.
    if let Err(error) =
        journal.record_intent(journal_id, position, &target.path, Some(&keep.path()))
    {
        return refuse(
            "journal-write-failed",
            format!("This item's intent could not be recorded, so it was not replaced: {error}"),
            Outcome::Failed,
        );
    }

    let staging = match stage_link(&keep.parent, parent.descriptor()) {
        Ok(staging) => staging,
        Err((code, message)) => {
            return settle(
                journal,
                journal_id,
                position,
                target,
                refuse(code, message, Outcome::Failed),
            );
        }
    };

    // After this the reviewed name holds the kept inode and the staging name
    // holds the old one. The name never points at nothing in between.
    if let Err(error) = sys::renameat_exchange(
        parent.descriptor(),
        &staging,
        parent.descriptor(),
        &parent.name,
    ) {
        let _ = sys::unlinkat(parent.descriptor(), &staging, false);
        let (code, message) = match error.raw_os_error() {
            Some(libc::EINVAL) | Some(libc::ENOSYS) => (
                "unsupported-filesystem",
                "This filesystem cannot exchange two names atomically, and Disktop will not \
                 replace a file through a sequence that leaves its name pointing at nothing."
                    .to_owned(),
            ),
            Some(libc::EACCES) | Some(libc::EPERM) => (
                "permission-denied",
                format!("This user may not replace the file: {error}"),
            ),
            _ => (
                "internal-error",
                format!("The replacement could not be completed: {error}"),
            ),
        };
        return settle(
            journal,
            journal_id,
            position,
            target,
            refuse(code, message, Outcome::Failed),
        );
    }

    // Removing the staging name releases the old inode, if this was its last
    // name. That is the step this operation cannot take back.
    let leftover = sys::unlinkat(parent.descriptor(), &staging, false).is_err();

    // Removing one of several names to an inode frees nothing; only the last
    // one does. Reporting the plan's number either way would claim space back
    // that is still in use.
    let freed = if live.link_count <= 1 {
        target.reviewed_bytes
    } else {
        0
    };

    let report = ItemReport {
        path: target.path.clone(),
        outcome: Outcome::Completed,
        reason: None,
        message: if leftover {
            Some(format!(
                "Replaced, but the staging name '{}' could not be removed and is still in the \
                 directory.",
                String::from_utf8_lossy(&staging),
            ))
        } else if freed == 0 {
            Some(
                "Replaced. This file had another name, so nothing was freed by removing this one."
                    .to_owned(),
            )
        } else {
            None
        },
        bytes: freed,
    };
    settle(journal, journal_id, position, target, report)
}

impl KeptFile {
    fn path(&self) -> Vec<u8> {
        self.parent.name.clone()
    }
}

/// Reserve a name in the target's own directory and link the kept file to it.
///
/// The link is made in the directory the replacement happens in, so the
/// exchange that follows is between two names under one descriptor. `EEXIST`
/// is what makes the name exclusive: there is no check-then-create window.
fn stage_link(
    keep_parent: &guard::ResolvedParent,
    target_parent: libc::c_int,
) -> Result<Vec<u8>, (&'static str, String)> {
    for attempt in 0..64u32 {
        let name = format!(".disktop-link-{}-{attempt}", std::process::id()).into_bytes();
        match sys::linkat(
            keep_parent.descriptor(),
            &keep_parent.name,
            target_parent,
            &name,
        ) {
            Ok(()) => return Ok(name),
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => continue,
            Err(error) => {
                let code = match error.raw_os_error() {
                    Some(libc::EXDEV) => "different-filesystem",
                    Some(libc::EACCES) | Some(libc::EPERM) => "permission-denied",
                    Some(libc::EMLINK) => "unsupported-filesystem",
                    _ => "internal-error",
                };
                return Err((
                    code,
                    format!("A link to the file being kept could not be made: {error}"),
                ));
            }
        }
    }
    Err((
        "internal-error",
        "No staging name was free in the target's directory.".to_owned(),
    ))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Operation {
    Trash,
    Erase,
    EmptyTrash,
    Restore,
    DedupHardlink,
}

impl Operation {
    fn as_str(self) -> &'static str {
        match self {
            Operation::Trash => "trash",
            Operation::Erase => "erase",
            Operation::EmptyTrash => "empty-trash",
            Operation::Restore => "restore",
            Operation::DedupHardlink => "dedup-hardlink",
        }
    }

    /// Only a Trash move leaves something to put back.
    fn reversible(self) -> bool {
        self == Operation::Trash
    }
}

/// The sequence every mutation shares. An operation supplies only what it does
/// to one item once that item has been judged.
fn run_action(
    operation: Operation,
    plan_id: &str,
    journal_directory: &Path,
    targets: &[Target],
    report: &mut dyn FnMut(ItemReport),
    cancelled: &AtomicBool,
    mut act: impl FnMut(&Guard, &Journal, &str, u64, &Target) -> ItemReport,
) -> Result<ActionSummary, ActionRefusal> {
    let guard = Guard::new(&GuardContext {
        journal_directory: Some(journal_directory.as_os_str().as_encoded_bytes().to_vec()),
    })
    .map_err(|refusal| ActionRefusal::new(refusal.code, refusal.message))?;

    let journal = Journal::open(journal_directory).map_err(|error| {
        ActionRefusal::new(
            "journal-write-failed",
            format!("The action journal could not be opened: {error}"),
        )
    })?;

    // Read free space before anything moves, on the filesystem holding the
    // first target's parent: the target itself is about to stop existing there.
    let anchor = targets.first().map(|target| parent_path(&target.path));
    let free_before = anchor.as_deref().and_then(guard::free_bytes);

    let journal_id = journal
        .begin(plan_id, operation.as_str(), free_before)
        .map_err(|error| {
            ActionRefusal::new(
                "journal-write-failed",
                format!("The action's intent could not be recorded: {error}"),
            )
        })?;

    let mut counts = Counts::default();
    let mut undo_available = false;
    let mut cancelled_early = false;

    for (position, target) in targets.iter().enumerate() {
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

        let outcome = act(&guard, &journal, &journal_id, position as u64, target);
        match &outcome.outcome {
            Outcome::Completed => {
                counts.completed += 1;
                if operation.reversible() {
                    counts.trashed_bytes =
                        counts.trashed_bytes.saturating_add(target.reviewed_bytes);
                    undo_available = true;
                }
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

    if moved.is_ok() {
        // What moved, not only where it went. A destination is a name, and a
        // name is free again as soon as the file leaves Trash.
        return settle_move(
            journal,
            journal_id,
            position,
            target,
            target.reviewed_bytes,
            Some(Identity {
                device: live.device,
                inode: live.inode,
            }),
        );
    }

    let report = match moved {
        Ok(()) => unreachable!("the success path returned above"),
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

    settle(journal, journal_id, position, target, report)
}

/// Remove one reviewed target for good.
///
/// The revalidation above it is what stops an addition: a directory somebody
/// dropped a file into since review has a different modification time, so it
/// is skipped rather than erased with the new file inside it. Below the
/// reviewed entry there is no second manifest — the plan named this directory,
/// and the whole of it goes — which is why the preview says so and why a
/// changed one is refused rather than re-reviewed here.
fn erase_one(
    guard: &Guard,
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

    if let Err(error) = journal.record_intent(journal_id, position, &target.path, None) {
        return refuse(
            "journal-write-failed",
            format!("This item's intent could not be recorded, so it was not removed: {error}"),
            Outcome::Failed,
        );
    }

    let removed = remove_entry(parent.descriptor(), &parent.name, live.kind);
    let report = match removed {
        Ok(()) => ItemReport {
            path: target.path.clone(),
            outcome: Outcome::Completed,
            reason: None,
            message: None,
            bytes: target.reviewed_bytes,
        },
        Err(error) => {
            let (code, message) = describe_removal(&error);
            ItemReport {
                path: target.path.clone(),
                outcome: Outcome::Failed,
                reason: Some(code),
                message: Some(message),
                bytes: 0,
            }
        }
    };

    settle(journal, journal_id, position, target, report)
}

/// Put back every item a Trash move moved, where its original path is free.
///
/// An item's destination comes from the journal, not from the caller: the
/// record is the only thing that knows where a file went, and reconstructing
/// it from a name would let a mistaken request move an unrelated file into a
/// place somebody else's data used to be. A record that removed things
/// permanently has nothing to put back and is refused rather than attempted.
pub fn run_restore(
    request: &RestoreRequest,
    report: &mut dyn FnMut(ItemReport),
    cancelled: &AtomicBool,
) -> Result<ActionSummary, ActionRefusal> {
    let journal = Journal::open(&request.journal_directory).map_err(|error| {
        ActionRefusal::new(
            "journal-write-failed",
            format!("The action journal could not be opened: {error}"),
        )
    })?;

    let record = journal
        .get(&request.journal_id)
        .map_err(|error| {
            ActionRefusal::new(
                "journal-write-failed",
                format!("The action journal could not be read: {error}"),
            )
        })?
        .ok_or_else(|| {
            ActionRefusal::new(
                "unknown-request",
                "No action with that ID is in the journal.",
            )
        })?;

    if record.operation != "trash" {
        return Err(ActionRefusal::new(
            "invalid-arguments",
            format!(
                "A '{}' action moved nothing to Trash, so there is nothing to put back.",
                record.operation
            ),
        ));
    }
    if record.state == State::InProgress || record.state == State::Uncertain {
        return Err(ActionRefusal::new(
            "invalid-arguments",
            "That action has not been resolved yet. Reconcile the journal before undoing it.",
        ));
    }

    // Each completed item becomes a target of its own, so one that cannot come
    // back does not stop the rest.
    let restorable: Vec<&crate::journal::ItemRecord> = record
        .items
        .iter()
        .filter(|item| item.outcome == Outcome::Completed && item.destination.is_some())
        .collect();
    let targets: Vec<Target> = restorable
        .iter()
        .map(|item| Target {
            path: item.path.clone(),
            expected: UNCHECKED,
            reviewed_bytes: item.bytes,
        })
        .collect();
    let destinations: Vec<(Vec<u8>, Option<Identity>)> = restorable
        .iter()
        .map(|item| (item.destination.clone().unwrap_or_default(), item.identity))
        .collect();

    run_action(
        Operation::Restore,
        &record.plan_id,
        &request.journal_directory,
        &targets,
        report,
        cancelled,
        |guard, journal, journal_id, position, target| {
            let (from, identity) = destinations
                .get(position as usize)
                .cloned()
                .unwrap_or_default();
            restore_one(
                guard, journal, journal_id, position, target, &from, identity,
            )
        },
    )
}

/// Move one item out of Trash and back to the path it came from.
fn restore_one(
    guard: &Guard,
    journal: &Journal,
    journal_id: &str,
    position: u64,
    target: &Target,
    from: &[u8],
    identity: Option<Identity>,
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
    let source = match guard::resolve_parent(from) {
        Ok(source) => source,
        Err(refusal) => {
            let outcome = outcome_for(refusal.code);
            return refuse(
                refusal.code,
                format!(
                    "What Trash was holding could not be reached: {}",
                    refusal.message
                ),
                outcome,
            );
        }
    };
    // What is in Trash has to be what this action put there. The name is free
    // again the moment somebody takes the original out by hand, and an undo
    // that trusted the name alone would move a stranger's file to a path it
    // never came from.
    let Ok(held) = sys::metadata_at(source.descriptor(), &source.name) else {
        return refuse(
            "changed-target",
            "Trash no longer holds this item, so there is nothing to put back.".to_owned(),
            Outcome::Skipped,
        );
    };
    match identity {
        Some(recorded) if recorded.device == held.device && recorded.inode == held.inode => {}
        Some(_) => {
            return refuse(
                "changed-target",
                "Something else is under that name in Trash now, so it was left alone.".to_owned(),
                Outcome::Skipped,
            );
        }
        None => {
            return refuse(
                "changed-target",
                "This action predates Disktop recording what it moved, so what is in Trash \
                 cannot be identified and was left alone."
                    .to_owned(),
                Outcome::Skipped,
            );
        }
    }

    // The same parent-safety rule a trash or an erase is held to: a directory
    // any user can write to is one where the final name can be swapped.
    let parent_metadata = match sys::metadata_of(source.descriptor()) {
        Ok(metadata) => metadata,
        Err(error) => {
            return refuse(
                "permission-denied",
                format!("Trash could not be read: {error}"),
                Outcome::Failed,
            );
        }
    };
    if parent_metadata.writable_by_anyone_without_sticky {
        return refuse(
            "unsafe-parent",
            "The Trash holding this item can be written by any user and is not sticky, so it \
             was left alone."
                .to_owned(),
            Outcome::Failed,
        );
    }
    let destination = match guard::resolve_parent(&target.path) {
        Ok(destination) => destination,
        Err(refusal) => {
            let outcome = outcome_for(refusal.code);
            return refuse(
                refusal.code,
                format!(
                    "The original location could not be reached: {}",
                    refusal.message
                ),
                outcome,
            );
        }
    };

    if let Err(error) = journal.record_intent(journal_id, position, &target.path, Some(from)) {
        return refuse(
            "journal-write-failed",
            format!("This item's intent could not be recorded, so it was not moved: {error}"),
            Outcome::Failed,
        );
    }

    // No-replace again: an undo that overwrote whatever is at the original
    // path now would undo one loss by causing another.
    let moved = sys::renameat_no_replace(
        source.descriptor(),
        &source.name,
        destination.descriptor(),
        &destination.name,
    );

    let report = match moved {
        Ok(()) => {
            remove_trash_metadata(from);
            ItemReport {
                path: target.path.clone(),
                outcome: Outcome::Completed,
                reason: None,
                message: None,
                bytes: target.reviewed_bytes,
            }
        }
        Err(error) => {
            let (code, message, outcome) = match error.raw_os_error() {
                Some(libc::EEXIST) | Some(libc::ENOTEMPTY) => (
                    "changed-target",
                    "Something else is at the original path now, so it was left alone.".to_owned(),
                    Outcome::Skipped,
                ),
                Some(libc::ENOENT) => (
                    "changed-target",
                    "Trash no longer holds this item, so there is nothing to put back.".to_owned(),
                    Outcome::Skipped,
                ),
                Some(libc::EXDEV) => (
                    "unsupported-filesystem",
                    "Trash and the original location are on different filesystems now.".to_owned(),
                    Outcome::Failed,
                ),
                _ => (
                    "internal-error",
                    format!("The move out of Trash failed: {error}"),
                    Outcome::Failed,
                ),
            };
            ItemReport {
                path: target.path.clone(),
                outcome,
                reason: Some(code),
                message: Some(message),
                bytes: 0,
            }
        }
    };

    settle(journal, journal_id, position, target, report)
}

/// Drop the `.trashinfo` beside a file that has left Trash. A leftover one
/// would describe something Trash no longer holds.
///
/// The path is rebuilt rather than reached through `..`: every descent here
/// uses `RESOLVE_BENEATH`, which is exactly a refusal to walk upwards, and
/// relaxing it for a convenience would relax it for everything.
fn remove_trash_metadata(trashed: &[u8]) {
    let Some(name) = trashed.rsplit(|byte| *byte == b'/').next() else {
        return;
    };
    let files = parent_path(trashed);
    if !files.ends_with(b"/files") {
        return;
    }
    let mut info = files[..files.len() - b"files".len()].to_vec();
    info.extend_from_slice(b"info/");
    info.extend_from_slice(name);
    info.extend_from_slice(b".trashinfo");

    if let Ok(parent) = guard::resolve_parent(&info) {
        let _ = sys::unlinkat(parent.descriptor(), &parent.name, false);
    }
}

/// Empty every directory that really is a Trash.
pub fn run_empty_trash(
    request: &EmptyTrashRequest,
    report: &mut dyn FnMut(ItemReport),
    cancelled: &AtomicBool,
) -> Result<ActionSummary, ActionRefusal> {
    // Every Trash directory is its own item, so one that is not a Trash refuses
    // on its own without stopping the others.
    let targets: Vec<Target> = request
        .trash_directories
        .iter()
        .map(|path| Target {
            path: path.clone(),
            expected: UNCHECKED,
            reviewed_bytes: 0,
        })
        .collect();

    let home_trash = request.home_trash_directory.clone();
    run_action(
        Operation::EmptyTrash,
        &request.plan_id,
        &request.journal_directory,
        &targets,
        report,
        cancelled,
        |guard, journal, journal_id, position, target| {
            empty_one(guard, &home_trash, journal, journal_id, position, target)
        },
    )
}

/// Whether a path is a Trash directory this user's Trash could be.
///
/// Shape alone is not enough: `files` and `info` side by side is a layout
/// plenty of ordinary data uses, and a plan that named the wrong directory
/// would empty it. A Trash is either the home Trash Node resolved from the XDG
/// rules, or one of the two per-mount locations the freedesktop specification
/// defines, at the top of a mount.
fn is_trash_location(guard: &Guard, home_trash: &[u8], path: &[u8]) -> bool {
    if path == home_trash {
        return true;
    }
    let Some(top) = guard.mount_point_for(path) else {
        return false;
    };
    let uid = uid_text();
    let mut below = top.clone();
    if below.last() != Some(&b'/') {
        below.push(b'/');
    }

    let mut owned = below.clone();
    owned.extend_from_slice(format!(".Trash-{uid}").as_bytes());
    let mut shared = below;
    shared.extend_from_slice(b".Trash/");
    shared.extend_from_slice(uid.as_bytes());

    path == owned.as_slice() || path == shared.as_slice()
}

/// A Trash directory has no reviewed fingerprint: it is named by its role, not
/// by the identity it had at review time, and it is checked by what it holds.
const UNCHECKED: Fingerprint = Fingerprint {
    device: 0,
    inode: 0,
    mount_id: 0,
    kind: EntryKind::Directory,
    apparent_bytes: 0,
    modified_nanoseconds: 0,
};

fn empty_one(
    guard: &Guard,
    home_trash: &[u8],
    journal: &Journal,
    journal_id: &str,
    position: u64,
    target: &Target,
) -> ItemReport {
    let refuse = |code: &'static str, message: String| ItemReport {
        path: target.path.clone(),
        outcome: Outcome::Failed,
        reason: Some(code),
        message: Some(message),
        bytes: 0,
    };

    if let Err(refusal) = guard.classify(&target.path) {
        return refuse(refusal.code, refusal.message);
    }
    if !is_trash_location(guard, home_trash, &target.path) {
        return refuse(
            "protected-path",
            "That is not one of this user's Trash directories. Only the home Trash and a \
             mount's own '.Trash/<uid>' or '.Trash-<uid>' can be emptied."
                .to_owned(),
        );
    }
    let parent = match guard::resolve_parent(&target.path) {
        Ok(parent) => parent,
        Err(refusal) => return refuse(refusal.code, refusal.message),
    };
    let directory = match sys::open_directory_no_symlinks(parent.descriptor(), &parent.name) {
        Ok(descriptor) => descriptor,
        Err(error) => {
            return refuse(
                "no-safe-trash",
                format!("The Trash directory could not be opened: {error}"),
            );
        }
    };

    // The shape is the check. A directory holding `files` and `info` is a
    // Trash; one that merely appears in a plan is not, and the difference is
    // what stops a mistyped plan erasing somebody's documents.
    let shaped = ["files", "info"].iter().all(|name| {
        sys::metadata_at(directory, name.as_bytes())
            .map(|metadata| metadata.kind == EntryKind::Directory)
            .unwrap_or(false)
    });
    if !shaped {
        sys::close(directory);
        return refuse(
            "protected-path",
            "That directory holds no 'files' and 'info' pair, so it is not a Trash and nothing \
             in it was touched."
                .to_owned(),
        );
    }

    if let Err(error) = journal.record_intent(journal_id, position, &target.path, None) {
        sys::close(directory);
        return refuse(
            "journal-write-failed",
            format!("This item's intent could not be recorded, so it was not emptied: {error}"),
        );
    }

    let emptied = ["files", "info"]
        .iter()
        .try_for_each(|name| empty_directory(directory, name.as_bytes()));
    sys::close(directory);

    let report = match emptied {
        Ok(()) => ItemReport {
            path: target.path.clone(),
            outcome: Outcome::Completed,
            reason: None,
            message: None,
            bytes: 0,
        },
        Err(error) => {
            let (code, message) = describe_removal(&error);
            ItemReport {
                path: target.path.clone(),
                outcome: Outcome::Failed,
                reason: Some(code),
                message: Some(message),
                bytes: 0,
            }
        }
    };

    settle(journal, journal_id, position, target, report)
}

/// Remove everything inside a directory, leaving the directory itself.
fn empty_directory(parent: libc::c_int, name: &[u8]) -> std::io::Result<()> {
    // `remove_children` takes the descriptor and closes it with its stream.
    remove_children(sys::open_directory_no_symlinks(parent, name)?)
}

/// Remove one entry, recursively if it is a directory.
///
/// A symlink is unlinked as the link object it is and never followed, which is
/// what makes erasing a directory safe: a link inside it to somewhere else is
/// removed, and what it pointed at is not.
fn remove_entry(parent: libc::c_int, name: &[u8], kind: EntryKind) -> std::io::Result<()> {
    if kind != EntryKind::Directory {
        return sys::unlinkat(parent, name, false);
    }
    let descriptor = sys::open_directory_no_symlinks(parent, name)?;
    remove_children(descriptor)?;
    sys::unlinkat(parent, name, true)
}

/// Remove every entry under an open directory, depth first.
///
/// `openat2` without mount crossing is what refuses a nested mount: a tree with
/// something mounted inside it fails rather than deleting through the mount
/// point, and the item reports why.
fn remove_children(descriptor: libc::c_int) -> std::io::Result<()> {
    let mut stream = sys::Directory::from_descriptor(descriptor)?;
    // One directory's names are read before any of them is removed: what
    // `readdir` returns after entries have been unlinked under it is
    // unspecified, and a walk that silently missed one would report a tree as
    // gone while something was still in it. Memory follows the widest
    // directory, not the size of the tree.
    let mut names = Vec::new();
    while let Some(name) = stream.next_name()? {
        names.push(name);
    }
    let descriptor = stream.descriptor();
    for name in names {
        let metadata = match sys::metadata_at(descriptor, &name) {
            Ok(metadata) => metadata,
            // Something else removed it first. The outcome is the one asked
            // for, so this is not a failure.
            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => continue,
            Err(error) => return Err(error),
        };
        if metadata.kind == EntryKind::Directory {
            let child = sys::open_directory_no_symlinks(descriptor, &name)?;
            remove_children(child)?;
            sys::unlinkat(descriptor, &name, true)?;
        } else {
            sys::unlinkat(descriptor, &name, false)?;
        }
    }
    Ok(())
}

fn describe_removal(error: &std::io::Error) -> (&'static str, String) {
    match error.raw_os_error() {
        Some(libc::EXDEV) | Some(libc::ELOOP) => (
            "protected-path",
            "Something is mounted inside this tree, or a component of it is a symlink, so it \
             was left alone rather than removed through the mount point."
                .to_owned(),
        ),
        Some(libc::EACCES) | Some(libc::EPERM) => (
            "permission-denied",
            format!("This user may not remove part of the target: {error}"),
        ),
        Some(libc::ENOENT) => (
            "changed-target",
            "The target went away between the check and the removal.".to_owned(),
        ),
        Some(libc::ENOTEMPTY) | Some(libc::EBUSY) => (
            "changed-target",
            format!("The target changed while it was being removed: {error}"),
        ),
        _ => ("internal-error", format!("The removal failed: {error}")),
    }
}

/// Write one item's outcome and hand back the report the caller will emit.
///
/// A journal write that fails is not a detail. The record is the authority an
/// undo and a restart read, so an item whose outcome nobody could record is
/// reported `uncertain` rather than completed: something may have happened to
/// it and Disktop cannot prove what.
fn settle(
    journal: &Journal,
    journal_id: &str,
    position: u64,
    target: &Target,
    report: ItemReport,
) -> ItemReport {
    match journal.record_outcome(
        journal_id,
        position,
        report.outcome,
        report.message.as_deref(),
        report.bytes,
        None,
    ) {
        Ok(()) => report,
        Err(error) => unrecorded(target, &error.to_string()),
    }
}

/// The same, for an item that really moved and whose identity has to be kept.
fn settle_move(
    journal: &Journal,
    journal_id: &str,
    position: u64,
    target: &Target,
    bytes: u64,
    identity: Option<Identity>,
) -> ItemReport {
    match journal.record_moved(journal_id, position, bytes, identity.as_ref()) {
        Ok(()) => ItemReport {
            path: target.path.clone(),
            outcome: Outcome::Completed,
            reason: None,
            message: None,
            bytes,
        },
        Err(error) => unrecorded(target, &error.to_string()),
    }
}

fn unrecorded(target: &Target, error: &str) -> ItemReport {
    ItemReport {
        path: target.path.clone(),
        outcome: Outcome::Uncertain,
        reason: Some("journal-write-failed"),
        message: Some(format!(
            "This item's outcome could not be recorded, so Disktop cannot say what happened to \
             it: {error}"
        )),
        bytes: 0,
    }
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
