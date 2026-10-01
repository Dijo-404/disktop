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

use rusqlite::{Connection, OptionalExtension, params};
use std::path::{Path, PathBuf};

pub const JOURNAL_FILE: &str = "journal-v1.sqlite";

/// The most records one page may return, whatever the request asks for.
pub const MAX_LIMIT: u32 = 200;

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

pub struct ItemRecord {
    pub position: u64,
    pub path: Vec<u8>,
    /// Where the item was moved, for an operation that moves rather than
    /// removes. This is what an undo reads to find the file again.
    pub destination: Option<Vec<u8>>,
    pub outcome: Outcome,
    pub reason: Option<String>,
    pub bytes: u64,
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
}

pub struct JournalPage {
    pub records: Vec<ActionRecord>,
    pub next_cursor: Option<String>,
}

pub struct Journal {
    connection: Connection,
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
        if let Err(error) = std::fs::create_dir_all(directory) {
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(error)));
        }
        let connection = Connection::open(journal_path(directory))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.execute_batch(SCHEMA)?;
        Ok(Journal { connection })
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
            .filter(|(_, pid)| !owner_alive(*pid))
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
            let uncertain: i64 = self.connection.query_row(
                "SELECT count(*) FROM action_item WHERE action_id = ?1 AND outcome = 'uncertain'",
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
                        trashed_bytes = (
                            SELECT coalesce(sum(bytes), 0) FROM action_item
                             WHERE action_id = ?1 AND outcome = 'completed'
                               AND destination IS NOT NULL
                        )
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

    /// One record by ID. `restore` reads it to find where a trashed file went;
    /// until that operation exists, only the tests here call it.
    #[allow(dead_code)]
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

        let overflow = records.len() > limit as usize;
        records.truncate(limit as usize);
        for record in &mut records {
            record.items = self.items(&record.id)?;
        }

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

    fn items(&self, action_id: &str) -> rusqlite::Result<Vec<ItemRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT position, path, destination, outcome, reason, bytes
               FROM action_item WHERE action_id = ?1 ORDER BY position",
        )?;
        statement
            .query_map(params![action_id], |row| {
                let outcome: String = row.get(3)?;
                Ok(ItemRecord {
                    position: unclamp(row.get(0)?),
                    path: row.get(1)?,
                    destination: row.get(2)?,
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
  PRIMARY KEY (action_id, position)
);

CREATE INDEX IF NOT EXISTS action_started ON action(started_at DESC, id DESC);
";

/// Whether some other live process holds this record open. A process ID the
/// kernel has since handed to something else reads as alive, which only delays
/// reconciliation; the record stays visibly unresolved rather than being
/// wrongly declared.
fn owner_alive(pid: i64) -> bool {
    if pid <= 0 || pid == i64::from(std::process::id()) {
        return false;
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
