//! The durable record of every change the helper made to a user file.
//!
//! One writer, one file, one ordering. Node reads this through
//! `journal-reconcile` and never writes it, because the process that performed
//! an operation is the only one that knows what actually happened, and two
//! writers cannot give one ordering across a crash (`adr/0004`).
//!
//! Each item is written twice: an intent before the syscall and an outcome
//! after it. That is what makes a crash legible. An item that holds only an
//! intent is `uncertain` — it may or may not have happened — and an action
//! holding one is uncertain too. Nothing here guesses in the hopeful
//! direction.
//!
//! Times cross as unix milliseconds in decimal strings, like every other
//! number in this protocol. The helper has no calendar and Node already
//! formats timestamps for the public JSON.

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};

pub const JOURNAL_FILE: &str = "journal-v1.sqlite";

/// The most records one page may return, whatever the request asks for.
pub const MAX_LIMIT: u32 = 200;

/// The most items one record carries in a history page. The rest are counted
/// in `items_omitted`; `get` always returns every one.
pub const PAGE_ITEMS_PER_RECORD: u64 = 1_000;

/// The most items one history page carries across all its records, so a page
/// stays a line a client can read whatever the actions in it did. A page always
/// holds at least one record.
pub const PAGE_ITEMS: u64 = 5_000;

/// How long a write waits for another Disktop to finish with the journal.
const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    InProgress,
    Complete,
    Partial,
    Uncertain,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::InProgress => "in-progress",
            State::Complete => "complete",
            State::Partial => "partial",
            State::Uncertain => "uncertain",
        }
    }

    fn parse(value: &str) -> State {
        match value {
            "complete" => State::Complete,
            "partial" => State::Partial,
            "uncertain" => State::Uncertain,
            // An unrecognised state is one this build did not write. Reading it
            // as finished would hide an interrupted action; in-progress sends
            // it through reconciliation instead.
            _ => State::InProgress,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    InProgress,
    Completed,
    Skipped,
    Failed,
    Uncertain,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::InProgress => "in-progress",
            Outcome::Completed => "completed",
            Outcome::Skipped => "skipped",
            Outcome::Failed => "failed",
            Outcome::Uncertain => "uncertain",
        }
    }

    fn parse(value: &str) -> Outcome {
        match value {
            "completed" => Outcome::Completed,
            "skipped" => Outcome::Skipped,
            "failed" => Outcome::Failed,
            "uncertain" => Outcome::Uncertain,
            _ => Outcome::InProgress,
        }
    }
}

#[derive(Default)]
pub struct Counts {
    pub completed: u64,
    pub skipped: u64,
    pub failed: u64,
    pub selected_bytes: u64,
    pub trashed_bytes: u64,
}

/// What one moved object was, so an undo can tell it from whatever has since
/// taken its name.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Identity {
    pub device: u64,
    pub inode: u64,
    pub kind: crate::sys::EntryKind,
    pub apparent_bytes: u64,
    pub modified_nanoseconds: u64,
    pub created_nanoseconds: Option<u64>,
}

impl Identity {
    pub fn from_metadata(metadata: &crate::sys::Metadata) -> Self {
        Self {
            device: metadata.device,
            inode: metadata.inode,
            kind: metadata.kind,
            apparent_bytes: metadata.apparent_bytes,
            modified_nanoseconds: metadata.modified_nanoseconds,
            created_nanoseconds: metadata.created_nanoseconds,
        }
    }

    /// Staged contents change while written; birth time and kind do not.
    /// Without birth time, require the entire original fingerprint instead.
    pub fn same_object(&self, metadata: &crate::sys::Metadata) -> bool {
        self.device == metadata.device
            && self.inode == metadata.inode
            && self.kind == metadata.kind
            && match (self.created_nanoseconds, metadata.created_nanoseconds) {
                (Some(recorded), Some(live)) => recorded == live,
                (None, None) => {
                    self.apparent_bytes == metadata.apparent_bytes
                        && self.modified_nanoseconds == metadata.modified_nanoseconds
                }
                _ => false,
            }
    }

    pub fn unchanged(&self, metadata: &crate::sys::Metadata) -> bool {
        self.same_object(metadata)
            && self.apparent_bytes == metadata.apparent_bytes
            && self.modified_nanoseconds == metadata.modified_nanoseconds
    }
}

pub struct ItemRecord {
    pub position: u64,
    pub path: Vec<u8>,
    /// Where the item was moved, for an operation that moves rather than
    /// removes. This is what an undo reads to find the file again.
    pub destination: Option<Vec<u8>>,
    /// What was moved there. A destination alone is a name, and a name can be
    /// taken by something else once the original leaves Trash.
    pub identity: Option<Identity>,
    pub outcome: Outcome,
    pub reason: Option<String>,
    pub bytes: u64,
}

pub struct CommandRecord {
    pub position: u64,
    pub tool: String,
    pub arguments: Vec<String>,
    /// `pending`, `started`, `finished`, or `uncertain` once reconciliation
    /// finds one that started and never finished.
    pub state: String,
    pub exit_code: Option<i64>,
    pub output: Option<String>,
}

pub struct ManagerRecord {
    pub adapter: String,
    pub action: String,
    pub privilege: String,
    pub estimated_bytes: Option<u64>,
    pub commands: Vec<CommandRecord>,
}

pub struct ActionRecord {
    pub id: String,
    pub plan_id: String,
    pub operation: String,
    pub started_at_milliseconds: u64,
    pub finished_at_milliseconds: Option<u64>,
    pub state: State,
    pub completed: u64,
    pub skipped: u64,
    pub failed: u64,
    pub selected_bytes: u64,
    pub trashed_bytes: u64,
    pub free_bytes_before: Option<u64>,
    pub free_bytes_after: Option<u64>,
    pub items: Vec<ItemRecord>,
    /// Items a history page left out of `items`. Always zero from `get`,
    /// which is what anything that acts on a record reads.
    pub items_omitted: u64,
    pub manager: Option<ManagerRecord>,
}

pub struct AbandonedStaging {
    pub action_id: String,
    pub position: u64,
    pub path: Vec<u8>,
    pub identity: Option<Identity>,
}

pub struct JournalPage {
    pub records: Vec<ActionRecord>,
    pub next_cursor: Option<String>,
}

pub struct Journal {
    connection: Connection,
    _directory: OwnedFd,
    /// Actions this handle began and has not finished. Dropping the handle
    /// without finishing them is what an abandoned action looks like from
    /// inside the process, so they stop counting as in flight then.
    began: std::cell::RefCell<Vec<String>>,
}

/// Every action this process has begun and not yet finished or abandoned.
///
/// A record's owner is the process that began it, and while that process is
/// alive its record is in flight, not abandoned. That cannot be told from the
/// process ID alone when the process asking is the owner itself: a
/// `journal-reconcile` that reaches a helper in the middle of its own action
/// would otherwise declare that action uncertain and release the output it is
/// staging at that moment.
static IN_FLIGHT: std::sync::Mutex<std::collections::BTreeSet<String>> =
    std::sync::Mutex::new(std::collections::BTreeSet::new());

fn in_flight() -> std::sync::MutexGuard<'static, std::collections::BTreeSet<String>> {
    IN_FLIGHT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Drop for Journal {
    fn drop(&mut self) {
        let mut flying = in_flight();
        for id in self.began.borrow().iter() {
            flying.remove(id);
        }
    }
}

pub fn journal_path(directory: &Path) -> PathBuf {
    directory.join(JOURNAL_FILE)
}

impl Journal {
    /// Open or create the journal.
    ///
    /// `synchronous = FULL` is the point of this file: it is the record a
    /// crash is judged against, so an item's intent has to be on the platter
    /// before the syscall it describes, not merely in the page cache. The
    /// index next door can afford `NORMAL` because every row in it can be
    /// produced again by scanning; nothing here can.
    pub fn open(directory: &Path) -> rusqlite::Result<Journal> {
        let held = private_directory(directory).map_err(sqlite_io_failure)?;
        let path = journal_path(directory);
        let name = JOURNAL_FILE.as_bytes();
        let descriptor = match crate::sys::openat_create_exclusive(held.as_raw_fd(), name, 0o600) {
            Ok(descriptor) => descriptor,
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => {
                crate::sys::openat_read_no_symlinks(held.as_raw_fd(), name)
                    .map_err(sqlite_io_failure)?
            }
            Err(error) => return Err(sqlite_io_failure(error)),
        };
        let file = unsafe { OwnedFd::from_raw_fd(descriptor) };
        let metadata = crate::sys::metadata_of(file.as_raw_fd()).map_err(sqlite_io_failure)?;
        if metadata.kind != crate::sys::EntryKind::File
            || metadata.owner_id != unsafe { libc::geteuid() }
            || metadata.link_count != 1
        {
            return Err(sqlite_io_failure(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "The action journal must be a regular file owned by this user with no other hardlinks.",
            )));
        }
        crate::sys::fchmod(file.as_raw_fd(), 0o600).map_err(sqlite_io_failure)?;
        crate::sys::fsync(held.as_raw_fd()).map_err(sqlite_io_failure)?;
        let connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        // Two Disktops can reach this file at once: a `history` reading
        // reconciles, which writes, and an apply writes every item. Without a
        // timeout the second one fails immediately with SQLITE_BUSY, and a
        // journal write that fails is an item whose outcome nobody recorded.
        connection.busy_timeout(BUSY_TIMEOUT)?;
        connection.execute_batch(SCHEMA)?;
        migrate(&connection)?;
        // The journal names every path Disktop has acted on, so it is private
        // to the user who owns it whichever process created it first.
        Ok(Journal {
            connection,
            _directory: held,
            began: std::cell::RefCell::new(Vec::new()),
        })
    }

    /// Record an action's intent and return its ID. Nothing may touch a user
    /// file before this returns.
    pub fn begin(
        &self,
        plan_id: &str,
        operation: &str,
        free_bytes_before: Option<u64>,
    ) -> rusqlite::Result<String> {
        let id = new_action_id();
        self.connection.execute(
            "INSERT INTO action
                 (id, plan_id, operation, started_at, state, free_before, owner_pid)
             VALUES (?1, ?2, ?3, ?4, 'in-progress', ?5, ?6)",
            params![
                id,
                plan_id,
                operation,
                clamp(unix_milliseconds()),
                free_bytes_before.map(clamp),
                i64::from(std::process::id()),
            ],
        )?;
        in_flight().insert(id.clone());
        self.began.borrow_mut().push(id.clone());
        Ok(id)
    }

    /// Say what is about to happen to one item, before it happens.
    pub fn record_intent(
        &self,
        action_id: &str,
        position: u64,
        path: &[u8],
        destination: Option<&[u8]>,
    ) -> rusqlite::Result<()> {
        self.connection.execute(
            "INSERT OR REPLACE INTO action_item
                 (action_id, position, path, destination, outcome, bytes)
             VALUES (?1, ?2, ?3, ?4, 'in-progress', 0)",
            params![action_id, clamp(position), path, destination],
        )?;
        Ok(())
    }

    /// Record that one item really moved, with what moved and where.
    ///
    /// A destination on its own is a name, and a name is free again as soon as
    /// the file leaves Trash. An undo that trusted the name alone would take
    /// whatever is sitting there now.
    pub fn record_moved(
        &self,
        action_id: &str,
        position: u64,
        bytes: u64,
        identity: Option<&Identity>,
    ) -> rusqlite::Result<()> {
        self.connection.execute(
            "UPDATE action_item
                SET outcome = 'completed', reason = NULL, bytes = ?3,
                    moved_device = ?4, moved_inode = ?5, moved_kind = ?6,
                    moved_size = ?7, moved_mtime = ?8, moved_btime = ?9
              WHERE action_id = ?1 AND position = ?2",
            params![
                action_id,
                clamp(position),
                clamp(bytes),
                identity.map(|identity| clamp(identity.device)),
                identity.map(|identity| clamp(identity.inode)),
                identity.map(|identity| identity.kind.code()),
                identity.map(|identity| clamp(identity.apparent_bytes)),
                identity.map(|identity| clamp(identity.modified_nanoseconds)),
                identity
                    .and_then(|identity| identity.created_nanoseconds)
                    .map(clamp),
            ],
        )?;
        Ok(())
    }

    /// Name what an item staged, so a crash before it is published can be found.
    pub fn record_staging(
        &self,
        action_id: &str,
        position: u64,
        path: &[u8],
        identity: &Identity,
    ) -> rusqlite::Result<()> {
        self.connection.execute(
            "UPDATE action_item SET staging = ?3, staging_device = ?4, staging_inode = ?5,
                    staging_kind = ?6, staging_size = ?7, staging_mtime = ?8, staging_btime = ?9
              WHERE action_id = ?1 AND position = ?2",
            params![
                action_id,
                clamp(position),
                path,
                clamp(identity.device),
                clamp(identity.inode),
                identity.kind.code(),
                clamp(identity.apparent_bytes),
                clamp(identity.modified_nanoseconds),
                identity.created_nanoseconds.map(clamp),
            ],
        )?;
        Ok(())
    }

    pub fn clear_staging(&self, action_id: &str, position: u64) -> rusqlite::Result<()> {
        self.connection.execute(
            "UPDATE action_item SET staging = NULL, staging_device = NULL, staging_inode = NULL,
                    staging_kind = NULL, staging_size = NULL, staging_mtime = NULL, staging_btime = NULL
              WHERE action_id = ?1 AND position = ?2",
            params![action_id, clamp(position)],
        )?;
        Ok(())
    }

    /// Staged outputs whose item reconciliation could not settle.
    pub fn abandoned_staging(&self) -> rusqlite::Result<Vec<AbandonedStaging>> {
        let mut statement = self.connection.prepare(
            "SELECT action_id, position, staging, staging_device, staging_inode,
                    staging_kind, staging_size, staging_mtime, staging_btime FROM action_item
              WHERE staging IS NOT NULL AND outcome = 'uncertain' ORDER BY action_id, position",
        )?;
        statement
            .query_map([], |row| {
                Ok(AbandonedStaging {
                    action_id: row.get(0)?,
                    position: unclamp(row.get(1)?),
                    path: row.get(2)?,
                    identity: read_identity(row, 3)?,
                })
            })?
            .collect()
    }

    pub fn resolve_staging(
        &self,
        action_id: &str,
        position: u64,
        note: &str,
    ) -> rusqlite::Result<()> {
        self.connection.execute(
            "UPDATE action_item
                SET staging = NULL, staging_device = NULL, staging_inode = NULL,
                    staging_kind = NULL, staging_size = NULL, staging_mtime = NULL, staging_btime = NULL,
                    reason = CASE WHEN reason IS NULL THEN ?3 ELSE reason || ' ' || ?3 END
              WHERE action_id = ?1 AND position = ?2",
            params![action_id, clamp(position), note],
        )?;
        Ok(())
    }

    /// Say what happened to it, after it happened.
    pub fn record_outcome(
        &self,
        action_id: &str,
        position: u64,
        outcome: Outcome,
        reason: Option<&str>,
        bytes: u64,
        destination: Option<&[u8]>,
    ) -> rusqlite::Result<()> {
        self.connection.execute(
            "UPDATE action_item
                SET outcome = ?3, reason = ?4, bytes = ?5,
                    destination = coalesce(?6, destination)
              WHERE action_id = ?1 AND position = ?2",
            params![
                action_id,
                clamp(position),
                outcome.as_str(),
                reason,
                clamp(bytes),
                destination,
            ],
        )?;
        Ok(())
    }

    pub fn finish(
        &self,
        action_id: &str,
        state: State,
        counts: &Counts,
        free_bytes_after: Option<u64>,
    ) -> rusqlite::Result<()> {
        self.connection.execute(
            "UPDATE action
                SET state = ?2, finished_at = ?3, completed = ?4, skipped = ?5, failed = ?6,
                    selected_bytes = ?7, trashed_bytes = ?8, free_after = ?9
              WHERE id = ?1",
            params![
                action_id,
                state.as_str(),
                clamp(unix_milliseconds()),
                clamp(counts.completed),
                clamp(counts.skipped),
                clamp(counts.failed),
                clamp(counts.selected_bytes),
                clamp(counts.trashed_bytes),
                free_bytes_after.map(clamp),
            ],
        )?;
        in_flight().remove(action_id);
        self.began.borrow_mut().retain(|began| began != action_id);
        Ok(())
    }

    /// Resolve every record an interrupted process left behind, and say how
    /// many it changed.
    ///
    /// An item holding only an intent becomes `uncertain`: the helper was
    /// killed around the syscall and nothing here can tell which side of it.
    /// An action holding one is uncertain too. An action whose items all
    /// reached a terminal outcome but which never finished is `partial` — the
    /// work it did is known, the work it had left is not. Running this twice
    /// changes nothing the second time.
    pub fn reconcile(&self) -> rusqlite::Result<u64> {
        let candidates: Vec<(String, i64)> = self
            .connection
            .prepare("SELECT id, owner_pid FROM action WHERE state = 'in-progress'")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<(String, i64)>>>()?;

        // A record whose owner is still running belongs to an action in
        // flight, not to a crash. Judging it now would declare a live
        // operation uncertain; leaving it alone costs one more reconcile.
        let unresolved: Vec<String> = candidates
            .into_iter()
            .filter(|(id, pid)| !owner_alive(*pid, id))
            .map(|(id, _)| id)
            .collect();

        for id in &unresolved {
            self.connection.execute(
                "UPDATE action_item SET outcome = 'uncertain', reason = coalesce(reason, ?2)
                  WHERE action_id = ?1 AND outcome = 'in-progress'",
                params![
                    id,
                    "Disktop stopped around this operation and cannot tell whether it happened."
                ],
            )?;
            self.connection.execute(
                "UPDATE manager_command SET state = 'uncertain'
                  WHERE action_id = ?1 AND state = 'started'",
                params![id],
            )?;
            let uncertain: i64 = self.connection.query_row(
                "SELECT (SELECT count(*) FROM action_item WHERE action_id = ?1 AND outcome = 'uncertain')
                      + (SELECT count(*) FROM manager_command WHERE action_id = ?1 AND state = 'uncertain')",
                params![id],
                |row| row.get(0),
            )?;
            let counted = |outcome: &str| -> rusqlite::Result<i64> {
                self.connection.query_row(
                    "SELECT count(*) FROM action_item WHERE action_id = ?1 AND outcome = ?2",
                    params![id, outcome],
                    |row| row.get(0),
                )
            };
            let state = if uncertain > 0 {
                State::Uncertain
            } else {
                State::Partial
            };
            self.connection.execute(
                "UPDATE action
                    SET state = ?2, completed = ?3, skipped = ?4, failed = ?5,
                        selected_bytes = (
                            SELECT coalesce(sum(bytes), 0) FROM action_item WHERE action_id = ?1
                        ),
                        -- Only an operation that puts things into Trash has
                        -- bytes in it. A restore's items carry a destination
                        -- too, and counting those would have an undo report
                        -- that it filled Trash up. A move or a compress whose
                        -- disposition was Trash records where each source
                        -- went; one whose disposition was permanent records
                        -- no destination, so it counts nothing here.
                        trashed_bytes = CASE
                          WHEN operation IN ('trash', 'copy-move', 'compress') THEN (
                            SELECT coalesce(sum(bytes), 0) FROM action_item
                             WHERE action_id = ?1 AND outcome = 'completed'
                               AND destination IS NOT NULL
                          ) ELSE 0 END
                  WHERE id = ?1",
                params![
                    id,
                    state.as_str(),
                    counted("completed")?,
                    counted("skipped")?,
                    counted("failed")?,
                ],
            )?;
        }
        Ok(unresolved.len() as u64)
    }

    /// One record by ID. `restore` reads it to find where a trashed file went.
    pub fn get(&self, id: &str) -> rusqlite::Result<Option<ActionRecord>> {
        let record = self
            .connection
            .query_row(
                &format!("SELECT {ACTION_COLUMNS} FROM action WHERE id = ?1"),
                params![id],
                read_action,
            )
            .optional()?;
        match record {
            None => Ok(None),
            Some(mut record) => {
                record.items = self.items(&record.id)?;
                record.manager = self.manager(&record.id)?;
                Ok(Some(record))
            }
        }
    }

    /// One page, newest first. The cursor is keyed on `(started_at, id)` so
    /// two actions begun in the same millisecond still have one order.
    pub fn page(&self, cursor: Option<&str>, limit: u32) -> rusqlite::Result<JournalPage> {
        let limit = limit.clamp(1, MAX_LIMIT);
        let (started, id) = match cursor {
            None => (i64::MAX, String::new()),
            Some(text) => decode_cursor(text)?,
        };

        let mut statement = self.connection.prepare(&format!(
            "SELECT {ACTION_COLUMNS} FROM action
              WHERE started_at < ?1 OR (started_at = ?1 AND id < ?2)
              ORDER BY started_at DESC, id DESC LIMIT ?3"
        ))?;
        let mut records = statement
            .query_map(params![started, id, i64::from(limit) + 1], read_action)?
            .collect::<rusqlite::Result<Vec<ActionRecord>>>()?;

        let mut overflow = records.len() > limit as usize;
        records.truncate(limit as usize);

        // A page is one line on the wire, and one action can hold hundreds of
        // thousands of items. Each record carries at most a bounded number of
        // them and says how many it left out, and a page stops taking records
        // once it holds a bounded number in all; the cursor continues from
        // there. Nothing that acts on a record reads it from here: `restore`
        // and a manager's finish read the whole record with `get`.
        let mut shown = 0u64;
        let mut kept = 0;
        for record in &mut records {
            let total = self.item_count(&record.id)?;
            let carried = total.min(PAGE_ITEMS_PER_RECORD);
            if kept > 0 && shown + carried > PAGE_ITEMS {
                overflow = true;
                break;
            }
            record.items = self.items_up_to(&record.id, carried)?;
            record.items_omitted = total - record.items.len() as u64;
            record.manager = self.manager(&record.id)?;
            shown += carried;
            kept += 1;
        }
        records.truncate(kept);

        let next_cursor = match (overflow, records.last()) {
            (true, Some(last)) => {
                Some(encode_cursor(clamp(last.started_at_milliseconds), &last.id))
            }
            _ => None,
        };
        Ok(JournalPage {
            records,
            next_cursor,
        })
    }

    /// Record a manager action, its commands, and its items, in one transaction.
    #[allow(clippy::too_many_arguments)]
    pub fn begin_manager(
        &self,
        plan_id: &str,
        adapter: &str,
        action: &str,
        privilege: &str,
        commands: &[(String, Vec<String>)],
        items: &[(Vec<u8>, u64)],
        estimated_bytes: Option<u64>,
        free_bytes_before: Option<u64>,
    ) -> rusqlite::Result<String> {
        self.connection.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| {
            let id = self.begin(plan_id, "manager", free_bytes_before)?;
            self.connection.execute(
                "INSERT INTO manager_action (action_id, adapter, manager_action, privilege, estimated_bytes)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, adapter, action, privilege, estimated_bytes.map(clamp)],
            )?;
            for (position, (tool, arguments)) in commands.iter().enumerate() {
                let encoded = serde_json::to_string(arguments)
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
                self.connection.execute(
                    "INSERT INTO manager_command (action_id, position, tool, arguments, state)
                     VALUES (?1, ?2, ?3, ?4, 'pending')",
                    params![id, clamp(position as u64), tool, encoded],
                )?;
            }
            for (position, (path, bytes)) in items.iter().enumerate() {
                self.connection.execute(
                    "INSERT INTO action_item (action_id, position, path, outcome, bytes)
                     VALUES (?1, ?2, ?3, 'in-progress', ?4)",
                    params![id, clamp(position as u64), path, clamp(*bytes)],
                )?;
            }
            Ok(id)
        })();
        // A manager action spans one helper session of several requests, each
        // with its own handle, so it stays in flight past this handle until it
        // is finished or the process goes.
        let forget = |id: &str| {
            self.began.borrow_mut().retain(|began| began != id);
        };
        match outcome {
            Ok(id) => match self.connection.execute_batch("COMMIT") {
                Ok(()) => {
                    forget(&id);
                    Ok(id)
                }
                Err(error) => {
                    forget(&id);
                    in_flight().remove(&id);
                    Err(error)
                }
            },
            Err(error) => {
                let _ = self.connection.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    /// Who holds an action open, and what state it is in.
    pub fn owner(&self, action_id: &str) -> rusqlite::Result<Option<(i64, State)>> {
        self.connection
            .query_row(
                "SELECT owner_pid, state FROM action WHERE id = ?1",
                params![action_id],
                |row| {
                    let state: String = row.get(1)?;
                    Ok((row.get(0)?, State::parse(&state)))
                },
            )
            .optional()
    }

    pub fn command_state(
        &self,
        action_id: &str,
        position: u64,
    ) -> rusqlite::Result<Option<String>> {
        self.connection
            .query_row(
                "SELECT state FROM manager_command WHERE action_id = ?1 AND position = ?2",
                params![action_id, clamp(position)],
                |row| row.get(0),
            )
            .optional()
    }

    pub fn set_command(
        &self,
        action_id: &str,
        position: u64,
        state: &str,
        exit_code: Option<i64>,
        output: Option<&str>,
    ) -> rusqlite::Result<()> {
        self.connection.execute(
            "UPDATE manager_command SET state = ?3, exit_code = coalesce(?4, exit_code),
                    output = coalesce(?5, output)
              WHERE action_id = ?1 AND position = ?2",
            params![action_id, clamp(position), state, exit_code, output],
        )?;
        Ok(())
    }

    pub fn add_observed(
        &self,
        action_id: &str,
        position: u64,
        path: &[u8],
    ) -> rusqlite::Result<()> {
        self.connection.execute(
            "INSERT INTO action_item (action_id, position, path, outcome, bytes)
             VALUES (?1, ?2, ?3, 'completed', 0)",
            params![action_id, clamp(position), path],
        )?;
        Ok(())
    }

    pub fn manager(&self, action_id: &str) -> rusqlite::Result<Option<ManagerRecord>> {
        let header = self
            .connection
            .query_row(
                "SELECT adapter, manager_action, privilege, estimated_bytes FROM manager_action
                  WHERE action_id = ?1",
                params![action_id],
                |row| {
                    let estimated: Option<i64> = row.get(3)?;
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        estimated,
                    ))
                },
            )
            .optional()?;
        let Some((adapter, action, privilege, estimated)) = header else {
            return Ok(None);
        };
        let mut statement = self.connection.prepare(
            "SELECT position, tool, arguments, state, exit_code, output FROM manager_command
              WHERE action_id = ?1 ORDER BY position",
        )?;
        let commands = statement
            .query_map(params![action_id], |row| {
                let encoded: String = row.get(2)?;
                Ok(CommandRecord {
                    position: unclamp(row.get(0)?),
                    tool: row.get(1)?,
                    arguments: serde_json::from_str(&encoded).unwrap_or_default(),
                    state: row.get(3)?,
                    exit_code: row.get(4)?,
                    output: row.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<CommandRecord>>>()?;
        Ok(Some(ManagerRecord {
            adapter,
            action,
            privilege,
            estimated_bytes: estimated.map(unclamp),
            commands,
        }))
    }

    fn items(&self, action_id: &str) -> rusqlite::Result<Vec<ItemRecord>> {
        self.items_up_to(action_id, u64::MAX)
    }

    fn item_count(&self, action_id: &str) -> rusqlite::Result<u64> {
        self.connection
            .query_row(
                "SELECT count(*) FROM action_item WHERE action_id = ?1",
                params![action_id],
                |row| row.get::<_, i64>(0),
            )
            .map(unclamp)
    }

    /// The first `limit` items in position order.
    fn items_up_to(&self, action_id: &str, limit: u64) -> rusqlite::Result<Vec<ItemRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT position, path, destination, outcome, reason, bytes, moved_device, moved_inode,
                    moved_kind, moved_size, moved_mtime, moved_btime
               FROM action_item WHERE action_id = ?1 ORDER BY position LIMIT ?2",
        )?;
        statement
            .query_map(params![action_id, clamp(limit)], |row| {
                let outcome: String = row.get(3)?;
                Ok(ItemRecord {
                    position: unclamp(row.get(0)?),
                    path: row.get(1)?,
                    destination: row.get(2)?,
                    identity: read_identity(row, 6)?,
                    outcome: Outcome::parse(&outcome),
                    reason: row.get(4)?,
                    bytes: unclamp(row.get(5)?),
                })
            })?
            .collect()
    }
}

const ACTION_COLUMNS: &str = "id, plan_id, operation, started_at, finished_at, state, completed,
     skipped, failed, selected_bytes, trashed_bytes, free_before, free_after";

/// Old records lacking a full fingerprint remain readable but cannot mutate.
fn read_identity(row: &rusqlite::Row<'_>, start: usize) -> rusqlite::Result<Option<Identity>> {
    let device: Option<i64> = row.get(start)?;
    let inode: Option<i64> = row.get(start + 1)?;
    let kind: Option<i64> = row.get(start + 2)?;
    let size: Option<i64> = row.get(start + 3)?;
    let modified: Option<i64> = row.get(start + 4)?;
    let created: Option<i64> = row.get(start + 5)?;
    Ok(match (device, inode, kind, size, modified) {
        (Some(device), Some(inode), Some(kind @ 0..=3), Some(size), Some(modified)) => {
            Some(Identity {
                device: unclamp(device),
                inode: unclamp(inode),
                kind: crate::sys::EntryKind::from_code(kind),
                apparent_bytes: unclamp(size),
                modified_nanoseconds: unclamp(modified),
                created_nanoseconds: created.map(unclamp),
            })
        }
        _ => None,
    })
}

fn read_action(row: &rusqlite::Row<'_>) -> rusqlite::Result<ActionRecord> {
    let state: String = row.get(5)?;
    let finished: Option<i64> = row.get(4)?;
    let before: Option<i64> = row.get(11)?;
    let after: Option<i64> = row.get(12)?;
    Ok(ActionRecord {
        id: row.get(0)?,
        plan_id: row.get(1)?,
        operation: row.get(2)?,
        started_at_milliseconds: unclamp(row.get(3)?),
        finished_at_milliseconds: finished.map(unclamp),
        state: State::parse(&state),
        completed: unclamp(row.get(6)?),
        skipped: unclamp(row.get(7)?),
        failed: unclamp(row.get(8)?),
        selected_bytes: unclamp(row.get(9)?),
        trashed_bytes: unclamp(row.get(10)?),
        free_bytes_before: before.map(unclamp),
        free_bytes_after: after.map(unclamp),
        items: Vec::new(),
        items_omitted: 0,
        manager: None,
    })
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS action (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  state TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  selected_bytes INTEGER NOT NULL DEFAULT 0,
  trashed_bytes INTEGER NOT NULL DEFAULT 0,
  free_before INTEGER,
  free_after INTEGER,
  owner_pid INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS action_item (
  action_id TEXT NOT NULL REFERENCES action(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  path BLOB NOT NULL,
  destination BLOB,
  outcome TEXT NOT NULL,
  reason TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  moved_device INTEGER,
  moved_inode INTEGER,
  moved_kind INTEGER,
  moved_size INTEGER,
  moved_mtime INTEGER,
  moved_btime INTEGER,
  staging BLOB,
  staging_device INTEGER,
  staging_inode INTEGER,
  staging_kind INTEGER,
  staging_size INTEGER,
  staging_mtime INTEGER,
  staging_btime INTEGER,
  PRIMARY KEY (action_id, position)
);

CREATE INDEX IF NOT EXISTS action_started ON action(started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS manager_action (
  action_id TEXT PRIMARY KEY REFERENCES action(id) ON DELETE CASCADE,
  adapter TEXT NOT NULL,
  manager_action TEXT NOT NULL,
  privilege TEXT NOT NULL,
  estimated_bytes INTEGER
);

CREATE TABLE IF NOT EXISTS manager_command (
  action_id TEXT NOT NULL REFERENCES action(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  tool TEXT NOT NULL,
  arguments TEXT NOT NULL,
  state TEXT NOT NULL,
  exit_code INTEGER,
  output TEXT,
  PRIMARY KEY (action_id, position)
);
";

/// Add the columns a journal written by an earlier build does not have.
fn migrate(connection: &Connection) -> rusqlite::Result<()> {
    let columns: Vec<String> = connection
        .prepare("PRAGMA table_info(action_item)")?
        .query_map([], |row| row.get(1))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    for (name, kind) in [
        ("staging", "BLOB"),
        ("staging_device", "INTEGER"),
        ("staging_inode", "INTEGER"),
        ("staging_kind", "INTEGER"),
        ("staging_size", "INTEGER"),
        ("staging_mtime", "INTEGER"),
        ("staging_btime", "INTEGER"),
        ("moved_kind", "INTEGER"),
        ("moved_size", "INTEGER"),
        ("moved_mtime", "INTEGER"),
        ("moved_btime", "INTEGER"),
    ] {
        if !columns.iter().any(|column| column == name) {
            connection
                .execute_batch(&format!("ALTER TABLE action_item ADD COLUMN {name} {kind}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
impl Journal {
    pub fn connection_for_tests(&self) -> &Connection {
        &self.connection
    }
}

#[cfg(test)]
pub mod tests_support {
    use super::*;

    pub fn abandon(journal: &Journal, id: &str) {
        journal
            .connection
            .execute("UPDATE action SET owner_pid = 0 WHERE id = ?1", params![id])
            .unwrap();
    }
}

/// Whether some other live process holds this record open. A process ID the
/// kernel has since handed to something else reads as alive, which only delays
/// reconciliation; the record stays visibly unresolved rather than being
/// wrongly declared.
fn owner_alive(pid: i64, id: &str) -> bool {
    if pid <= 0 {
        return false;
    }
    if pid == i64::from(std::process::id()) {
        return in_flight().contains(id);
    }
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    unsafe { libc::kill(pid, 0) == 0 }
}

fn new_action_id() -> String {
    let mut random = [0u8; 8];
    if let Ok(mut file) = std::fs::File::open("/dev/urandom") {
        let _ = std::io::Read::read_exact(&mut file, &mut random);
    }
    let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("act-{}-{suffix}", unix_milliseconds())
}

fn unix_milliseconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

/// SQLite integers are signed; anything past that is clamped rather than
/// wrapped into a negative number a reader would believe.
fn clamp(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

fn unclamp(value: i64) -> u64 {
    value.max(0) as u64
}

fn sqlite_io_failure(error: std::io::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

/// Create and open the journal's directory one component at a time. No
/// symlink or directory another account can replace may redirect journal
/// writes, and a privacy failure must refuse the action before its intent.
fn private_directory(path: &Path) -> std::io::Result<OwnedFd> {
    use std::os::unix::ffi::OsStrExt;
    let bytes = path.as_os_str().as_bytes();
    if bytes == b"/" || !crate::guard::is_absolute_normalised(bytes) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "The journal directory must be an absolute, normalized private path.",
        ));
    }
    let mut directory = unsafe { OwnedFd::from_raw_fd(crate::sys::open_filesystem_root()?) };
    let user = unsafe { libc::geteuid() };
    for component in bytes[1..].split(|byte| *byte == b'/') {
        let parent = crate::sys::metadata_of(directory.as_raw_fd())?;
        if (parent.owner_id != user && parent.owner_id != 0)
            || parent.writable_by_anyone_without_sticky
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "A directory above the journal is owned or writable by another account.",
            ));
        }
        match crate::sys::mkdirat_exclusive(directory.as_raw_fd(), component, 0o700) {
            Ok(()) => crate::sys::fsync(directory.as_raw_fd())?,
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => {}
            Err(error) => return Err(error),
        }
        directory = unsafe {
            OwnedFd::from_raw_fd(crate::sys::open_directory_no_symlinks(
                directory.as_raw_fd(),
                component,
            )?)
        };
    }
    let metadata = crate::sys::metadata_of(directory.as_raw_fd())?;
    if metadata.owner_id != user {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "The journal directory must belong to this user.",
        ));
    }
    crate::sys::fchmod(directory.as_raw_fd(), 0o700)?;
    Ok(directory)
}

/// Hex, so the cursor survives the contract's restricted alphabet, and opaque,
/// so nothing a caller sends can select rows by any key but this one.
fn encode_cursor(started: i64, id: &str) -> String {
    let mut payload = started.to_string().into_bytes();
    payload.push(0);
    payload.extend_from_slice(id.as_bytes());
    payload.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_cursor(cursor: &str) -> rusqlite::Result<(i64, String)> {
    let invalid = || {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "The journal cursor is not one this journal issued.",
        )))
    };
    if cursor.is_empty() || !cursor.len().is_multiple_of(2) {
        return Err(invalid());
    }
    let mut payload = Vec::with_capacity(cursor.len() / 2);
    for pair in cursor.as_bytes().chunks(2) {
        let text = std::str::from_utf8(pair).map_err(|_| invalid())?;
        payload.push(u8::from_str_radix(text, 16).map_err(|_| invalid())?);
    }
    let split = payload
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(invalid)?;
    let started: i64 = std::str::from_utf8(&payload[..split])
        .map_err(|_| invalid())?
        .parse()
        .map_err(|_| invalid())?;
    let id = String::from_utf8(payload[split + 1..].to_vec()).map_err(|_| invalid())?;
    Ok((started, id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Sandbox;

    const OLD_SCHEMA: &str = "
CREATE TABLE action (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, operation TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER, state TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0, selected_bytes INTEGER NOT NULL DEFAULT 0,
  trashed_bytes INTEGER NOT NULL DEFAULT 0, free_before INTEGER, free_after INTEGER,
  owner_pid INTEGER NOT NULL DEFAULT 0);
CREATE TABLE action_item (action_id TEXT NOT NULL REFERENCES action(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, path BLOB NOT NULL, destination BLOB, outcome TEXT NOT NULL,
  reason TEXT, bytes INTEGER NOT NULL DEFAULT 0, moved_device INTEGER, moved_inode INTEGER,
  PRIMARY KEY (action_id, position));
";

    use super::tests_support::abandon;

    #[test]
    fn a_journal_file_symlink_is_refused_without_changing_its_target() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let sandbox = Sandbox::new("journal-symlink-file");
        let directory = sandbox.directory(b"state");
        sandbox.file(b"unrelated", 123);
        let unrelated = sandbox.path().join("unrelated");
        std::fs::set_permissions(&unrelated, std::fs::Permissions::from_mode(0o644)).unwrap();
        let before = std::fs::read(&unrelated).unwrap();
        symlink(&unrelated, journal_path(&directory)).unwrap();
        assert!(Journal::open(&directory).is_err());
        assert_eq!(std::fs::read(&unrelated).unwrap(), before);
        assert_eq!(
            std::fs::metadata(unrelated).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }

    #[test]
    fn a_symlinked_journal_directory_is_refused_before_any_file_is_created() {
        use std::os::unix::fs::symlink;
        let sandbox = Sandbox::new("journal-symlink-directory");
        let actual = sandbox.directory(b"actual");
        let link = sandbox.path().join("state");
        symlink(&actual, &link).unwrap();
        assert!(Journal::open(&link).is_err());
        assert!(!journal_path(&actual).exists());
    }

    #[test]
    fn a_journal_with_another_hardlink_is_refused_before_its_permissions_change() {
        use std::os::unix::fs::PermissionsExt;
        let sandbox = Sandbox::new("journal-hardlink");
        let directory = sandbox.directory(b"state");
        sandbox.file(b"unrelated", 123);
        let unrelated = sandbox.path().join("unrelated");
        std::fs::set_permissions(&unrelated, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::hard_link(&unrelated, journal_path(&directory)).unwrap();
        assert!(Journal::open(&directory).is_err());
        assert_eq!(
            std::fs::metadata(unrelated).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }

    #[test]
    fn an_ancestor_writable_by_other_accounts_refuses_journal_creation() {
        use std::os::unix::fs::PermissionsExt;
        let sandbox = Sandbox::new("journal-unsafe-ancestor");
        let shared = sandbox.directory(b"shared");
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o777)).unwrap();
        let directory = shared.join("state");
        assert!(Journal::open(&directory).is_err());
        assert!(!directory.exists());
    }

    #[test]
    fn a_journal_written_before_staging_was_recorded_opens_and_records_it() {
        let sandbox = Sandbox::new("journal-migrate");
        let connection = Connection::open(journal_path(sandbox.path())).unwrap();
        connection.execute_batch(OLD_SCHEMA).unwrap();
        drop(connection);

        let journal = Journal::open(sandbox.path()).unwrap();
        let id = journal
            .begin("plan-0123456789ab", "copy-move", None)
            .unwrap();
        journal
            .record_intent(&id, 0, b"/src/a", Some(b"/dst/a"))
            .unwrap();
        journal
            .record_staging(
                &id,
                0,
                b"/dst/a.disktop-partial-1-0",
                &Identity {
                    device: 1,
                    inode: 2,
                    kind: crate::sys::EntryKind::File,
                    apparent_bytes: 4096,
                    modified_nanoseconds: 123456,
                    created_nanoseconds: Some(123),
                },
            )
            .unwrap();
    }

    #[test]
    fn old_moved_items_remain_readable_but_have_no_authoritative_identity() {
        let sandbox = Sandbox::new("journal-old-identity");
        let connection = Connection::open(journal_path(sandbox.path())).unwrap();
        connection.execute_batch(OLD_SCHEMA).unwrap();
        connection.execute_batch(
            "INSERT INTO action (id, plan_id, operation, started_at, state) VALUES
             ('old', 'plan-0123456789ab', 'trash', 1, 'complete');
             INSERT INTO action_item (action_id, position, path, destination, outcome, moved_device, moved_inode)
             VALUES ('old', 0, X'2F737263', X'2F7472617368', 'completed', 1, 2);"
        ).unwrap();
        drop(connection);
        let journal = Journal::open(sandbox.path()).unwrap();
        let record = journal.get("old").unwrap().unwrap();
        assert_eq!(record.items[0].destination.as_deref(), Some(&b"/trash"[..]));
        assert_eq!(
            record.items[0].identity, None,
            "device/inode alone cannot authorise undo"
        );
    }

    #[test]
    fn only_an_uncertain_item_with_a_staged_name_is_abandoned() {
        let sandbox = Sandbox::new("journal-abandoned");
        let journal = Journal::open(sandbox.path()).unwrap();
        let id = journal
            .begin("plan-0123456789ab", "copy-move", None)
            .unwrap();
        journal
            .record_intent(&id, 0, b"/src/a", Some(b"/dst/a"))
            .unwrap();
        journal
            .record_staging(
                &id,
                0,
                b"/dst/a.disktop-partial-1-0",
                &Identity {
                    device: 1,
                    inode: 2,
                    kind: crate::sys::EntryKind::File,
                    apparent_bytes: 4096,
                    modified_nanoseconds: 123456,
                    created_nanoseconds: Some(123),
                },
            )
            .unwrap();
        journal
            .record_intent(&id, 1, b"/src/b", Some(b"/dst/b"))
            .unwrap();
        journal
            .record_staging(
                &id,
                1,
                b"/dst/b.disktop-partial-1-1",
                &Identity {
                    device: 1,
                    inode: 3,
                    kind: crate::sys::EntryKind::File,
                    apparent_bytes: 4096,
                    modified_nanoseconds: 123456,
                    created_nanoseconds: Some(123),
                },
            )
            .unwrap();
        journal.clear_staging(&id, 1).unwrap();
        assert!(
            journal.abandoned_staging().unwrap().is_empty(),
            "nothing is abandoned while its owner runs"
        );

        abandon(&journal, &id);
        journal.reconcile().unwrap();
        let abandoned = journal.abandoned_staging().unwrap();
        assert_eq!(abandoned.len(), 1);
        assert_eq!(abandoned[0].path, b"/dst/a.disktop-partial-1-0");
        assert_eq!(
            abandoned[0].identity,
            Some(Identity {
                device: 1,
                inode: 2,
                kind: crate::sys::EntryKind::File,
                apparent_bytes: 4096,
                modified_nanoseconds: 123456,
                created_nanoseconds: Some(123),
            })
        );

        journal.resolve_staging(&id, 0, "released").unwrap();
        assert!(journal.abandoned_staging().unwrap().is_empty());
        let record = journal.get(&id).unwrap().unwrap();
        assert!(
            record.items[0]
                .reason
                .as_deref()
                .unwrap()
                .contains("released")
        );
    }

    #[test]
    fn a_finished_action_reads_back_with_its_items() {
        let sandbox = Sandbox::new("journal-finished");
        let journal = Journal::open(sandbox.path()).unwrap();

        let id = journal
            .begin("plan-0123456789ab", "trash", Some(1_000))
            .unwrap();
        journal
            .record_intent(
                &id,
                0,
                b"/home/example/.cache/pip",
                Some(b"/home/example/.local/share/Trash/files/pip"),
            )
            .unwrap();
        journal
            .record_outcome(&id, 0, Outcome::Completed, None, 4_096, None)
            .unwrap();
        journal
            .finish(
                &id,
                State::Complete,
                &Counts {
                    completed: 1,
                    skipped: 0,
                    failed: 0,
                    selected_bytes: 4_096,
                    trashed_bytes: 4_096,
                },
                Some(1_000),
            )
            .unwrap();

        let page = journal.page(None, 10).unwrap();
        assert_eq!(page.records.len(), 1);
        let record = &page.records[0];
        assert_eq!(record.state, State::Complete);
        assert_eq!(record.operation, "trash");
        assert_eq!(record.items.len(), 1);
        assert_eq!(record.items[0].outcome, Outcome::Completed);
        assert_eq!(record.items[0].path, b"/home/example/.cache/pip");
    }

    #[test]
    fn an_item_whose_outcome_was_never_written_reconciles_to_uncertain() {
        let sandbox = Sandbox::new("journal-uncertain");
        let id = {
            let journal = Journal::open(sandbox.path()).unwrap();
            let id = journal.begin("plan-0123456789ab", "erase", None).unwrap();
            journal
                .record_intent(&id, 0, b"/home/example/junk", None)
                .unwrap();
            id
        };

        let journal = Journal::open(sandbox.path()).unwrap();
        assert_eq!(journal.reconcile().unwrap(), 1);
        let record = journal.get(&id).unwrap().unwrap();
        assert_eq!(record.state, State::Uncertain);
        assert_eq!(record.items[0].outcome, Outcome::Uncertain);

        // Reconciling again changes nothing: a second startup must not rewrite
        // a record it already judged.
        assert_eq!(journal.reconcile().unwrap(), 0);
    }

    #[test]
    fn an_action_whose_items_all_finished_reconciles_to_partial() {
        let sandbox = Sandbox::new("journal-partial");
        let id = {
            let journal = Journal::open(sandbox.path()).unwrap();
            let id = journal.begin("plan-0123456789ab", "trash", None).unwrap();
            journal
                .record_intent(&id, 0, b"/home/example/one", None)
                .unwrap();
            journal
                .record_outcome(&id, 0, Outcome::Completed, None, 512, Some(b"/trash/one"))
                .unwrap();
            id
        };

        let journal = Journal::open(sandbox.path()).unwrap();
        journal.reconcile().unwrap();
        let record = journal.get(&id).unwrap().unwrap();
        assert_eq!(record.state, State::Partial);
        assert_eq!(record.completed, 1);
        assert_eq!(
            record.items[0].destination.as_deref(),
            Some(b"/trash/one".as_slice())
        );
    }

    #[test]
    fn an_item_restored_out_of_trash_is_not_counted_as_bytes_moved_into_it() {
        let sandbox = Sandbox::new("journal-restore-bytes");
        let id = {
            let journal = Journal::open(sandbox.path()).unwrap();
            let id = journal.begin("plan-0123456789ab", "restore", None).unwrap();
            journal
                .record_intent(&id, 0, b"/home/example/one", Some(b"/trash/files/one"))
                .unwrap();
            journal
                .record_outcome(&id, 0, Outcome::Completed, None, 512, None)
                .unwrap();
            id
        };

        let journal = Journal::open(sandbox.path()).unwrap();
        journal.reconcile().unwrap();
        let record = journal.get(&id).unwrap().unwrap();
        assert_eq!(
            record.trashed_bytes, 0,
            "an undo moved bytes out of Trash, not into it"
        );
        assert_eq!(record.selected_bytes, 512);
    }

    /// A reconcile that reaches the helper while that same helper is running
    /// an action must not judge the action abandoned: its owner is alive, it is
    /// just the process asking. Once the action's handle is gone without a
    /// finish, it is abandoned and reads as such.
    #[test]
    fn this_process_never_reconciles_an_action_it_is_still_running() {
        let sandbox = Sandbox::new("journal-own-in-flight");
        let running = Journal::open(sandbox.path()).unwrap();
        let id = running
            .begin("plan-0123456789ab", "copy-move", None)
            .unwrap();
        running
            .record_intent(&id, 0, b"/work/a", Some(b"/elsewhere/a"))
            .unwrap();

        let asking = Journal::open(sandbox.path()).unwrap();
        assert_eq!(asking.reconcile().unwrap(), 0, "the action is in flight");
        assert_eq!(
            asking.get(&id).unwrap().unwrap().items[0].outcome,
            Outcome::InProgress
        );

        drop(running);
        assert_eq!(
            asking.reconcile().unwrap(),
            1,
            "abandoned once its handle is gone"
        );
        assert_eq!(asking.get(&id).unwrap().unwrap().state, State::Uncertain);
    }

    #[test]
    fn a_manager_action_stays_in_flight_between_the_requests_of_its_session() {
        let sandbox = Sandbox::new("journal-manager-in-flight");
        let id = Journal::open(sandbox.path())
            .unwrap()
            .begin_manager(
                "plan-0123456789ab",
                "docker",
                "docker.remove-dangling-images",
                "user",
                &[("docker".to_owned(), vec!["image".to_owned()])],
                &[(b"sha256:1".to_vec(), 1)],
                None,
                None,
            )
            .unwrap();

        let asking = Journal::open(sandbox.path()).unwrap();
        assert_eq!(asking.reconcile().unwrap(), 0);
        asking
            .finish(&id, State::Complete, &Counts::default(), None)
            .unwrap();
        assert_eq!(asking.get(&id).unwrap().unwrap().state, State::Complete);
    }

    /// A move or a compress whose plan said `trash` puts its sources in Trash
    /// just as a Trash action does, and the action reported those bytes while
    /// it ran. Reconciling an interrupted one must not report zero instead.
    #[test]
    fn a_reconciled_move_counts_the_sources_it_put_in_trash() {
        let sandbox = Sandbox::new("journal-move-trashed");
        let journal = Journal::open(sandbox.path()).unwrap();
        let mut ids = Vec::new();
        for (operation, destination) in [
            ("copy-move", Some(&b"/trash/files/a"[..])),
            ("compress", Some(&b"/trash/files/b"[..])),
            ("copy-move", None),
        ] {
            let id = journal.begin("plan-0123456789ab", operation, None).unwrap();
            journal
                .record_intent(&id, 0, b"/work/a", destination)
                .unwrap();
            journal
                .record_moved(
                    &id,
                    0,
                    512,
                    Some(&Identity {
                        device: 1,
                        inode: 2,
                        kind: crate::sys::EntryKind::File,
                        apparent_bytes: 4096,
                        modified_nanoseconds: 123456,
                        created_nanoseconds: Some(123),
                    }),
                )
                .unwrap();
            journal.record_intent(&id, 1, b"/work/b", None).unwrap();
            abandon(&journal, &id);
            ids.push(id);
        }
        journal.reconcile().unwrap();

        let trashed: Vec<u64> = ids
            .iter()
            .map(|id| journal.get(id).unwrap().unwrap().trashed_bytes)
            .collect();
        assert_eq!(
            trashed,
            vec![512, 512, 0],
            "a source put in Trash counts; one removed permanently does not",
        );
    }

    fn action_with_items(journal: &Journal, items: u64) -> String {
        let id = journal.begin("plan-0123456789ab", "trash", None).unwrap();
        journal.connection.execute_batch("BEGIN").unwrap();
        for position in 0..items {
            journal
                .record_intent(
                    &id,
                    position,
                    format!("/home/example/{position}").as_bytes(),
                    Some(b"/trash/files/x"),
                )
                .unwrap();
        }
        journal.connection.execute_batch("COMMIT").unwrap();
        journal
            .finish(&id, State::Complete, &Counts::default(), None)
            .unwrap();
        id
    }

    /// One action can hold hundreds of thousands of items, and a history page
    /// is one line on the wire. A page carries a bounded number of each
    /// record's items and says how many it left out; the record itself, which
    /// is what an undo reads, still holds every one.
    #[test]
    fn a_history_page_bounds_the_items_it_carries_and_says_what_it_left_out() {
        let sandbox = Sandbox::new("journal-page-items");
        let journal = Journal::open(sandbox.path()).unwrap();
        let id = action_with_items(&journal, PAGE_ITEMS_PER_RECORD + 1_500);

        let page = journal.page(None, 10).unwrap();
        let record = &page.records[0];
        assert_eq!(record.items.len() as u64, PAGE_ITEMS_PER_RECORD);
        assert_eq!(record.items_omitted, 1_500);
        assert_eq!(record.items[0].position, 0, "the first items, in order");

        let whole = journal.get(&id).unwrap().unwrap();
        assert_eq!(whole.items.len() as u64, PAGE_ITEMS_PER_RECORD + 1_500);
        assert_eq!(whole.items_omitted, 0);
    }

    #[test]
    fn a_history_page_stops_taking_records_once_it_holds_enough_items() {
        let sandbox = Sandbox::new("journal-page-budget");
        let journal = Journal::open(sandbox.path()).unwrap();
        let records = PAGE_ITEMS / PAGE_ITEMS_PER_RECORD + 2;
        for _ in 0..records {
            action_with_items(&journal, PAGE_ITEMS_PER_RECORD);
        }

        let first = journal.page(None, MAX_LIMIT).unwrap();
        let carried: u64 = first
            .records
            .iter()
            .map(|record| record.items.len() as u64)
            .sum();
        assert!(carried <= PAGE_ITEMS, "{carried} items on one page");
        assert!(first.next_cursor.is_some(), "the rest is a page away");

        let mut seen: Vec<String> = first
            .records
            .iter()
            .map(|record| record.id.clone())
            .collect();
        let mut cursor = first.next_cursor;
        while let Some(next) = cursor {
            let page = journal.page(Some(&next), MAX_LIMIT).unwrap();
            assert!(!page.records.is_empty(), "a page always holds a record");
            seen.extend(page.records.iter().map(|record| record.id.clone()));
            cursor = page.next_cursor;
        }
        assert_eq!(seen.len() as u64, records, "every record, once");
        seen.dedup();
        assert_eq!(seen.len() as u64, records);
    }

    #[test]
    fn a_trashed_item_records_the_identity_an_undo_has_to_find_again() {
        let sandbox = Sandbox::new("journal-identity");
        let journal = Journal::open(sandbox.path()).unwrap();
        let id = journal.begin("plan-0123456789ab", "trash", None).unwrap();
        journal
            .record_intent(&id, 0, b"/home/example/one", Some(b"/trash/files/one"))
            .unwrap();
        journal
            .record_moved(
                &id,
                0,
                4096,
                Some(&Identity {
                    device: 66306,
                    inode: 12345,
                    kind: crate::sys::EntryKind::File,
                    apparent_bytes: 4096,
                    modified_nanoseconds: 123456,
                    created_nanoseconds: Some(123),
                }),
            )
            .unwrap();

        let record = journal.get(&id).unwrap().unwrap();
        let identity = record.items[0]
            .identity
            .expect("a completed move records what it moved");
        assert_eq!(identity.device, 66306);
        assert_eq!(identity.inode, 12345);
    }

    #[test]
    fn the_journal_directory_and_its_file_are_private_to_this_user() {
        use std::os::unix::fs::PermissionsExt;
        let sandbox = Sandbox::new("journal-private");
        let directory = sandbox.path().join("state");
        let journal = Journal::open(&directory).unwrap();
        let id = journal.begin("plan-0123456789ab", "trash", None).unwrap();
        journal
            .finish(&id, State::Complete, &Counts::default(), None)
            .unwrap();

        let mode =
            |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&directory), 0o700, "the state directory is private");
        assert_eq!(
            mode(&journal_path(&directory)),
            0o600,
            "the journal names every path Disktop acted on",
        );
    }

    #[test]
    fn a_page_lists_newest_first_and_the_cursor_continues_it_without_repeats() {
        let sandbox = Sandbox::new("journal-page");
        let journal = Journal::open(sandbox.path()).unwrap();
        for index in 0..5 {
            let id = journal
                .begin(&format!("plan-00000000000{index}"), "trash", None)
                .unwrap();
            journal
                .finish(&id, State::Complete, &Counts::default(), None)
                .unwrap();
        }

        let mut seen = Vec::new();
        let mut cursor = None;
        loop {
            let page = journal.page(cursor.as_deref(), 2).unwrap();
            assert!(page.records.len() <= 2);
            for record in &page.records {
                assert!(!seen.contains(&record.id), "a record was returned twice");
                seen.push(record.id.clone());
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(seen.len(), 5);
    }
}
