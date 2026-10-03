//! The disk-backed file index.
//!
//! One row per entry, holding a name as raw bytes and its parent's ID rather
//! than a repeated absolute path. Full paths are rebuilt a page at a time when
//! a query asks for them, so neither the helper nor Node ever holds the tree.
//!
//! Each scan is its own SQLite file. A scan is written to `<id>.sqlite.partial`
//! as a plain append into a table with no secondary index, the indexes are
//! built once over the finished table, and the file is renamed to
//! `<id>.sqlite`, after which nothing writes to it again. That shape is what
//! the costs depend on: an append is far cheaper than keeping a dozen B-trees
//! ordered row by row, a reader of one scan never waits on the writer of
//! another, and pruning a scan is removing a file, which returns its space at
//! once rather than leaving free pages inside a shared one.
//!
//! The index is a cache: it is bounded by a scan count and a byte budget, and
//! old scans are pruned rather than accumulated. Nothing here can be read as
//! authority for a mutation; a reviewed plan revalidates every target live.

use crate::sys::EntryKind;
use crate::walk::{DirectoryTotals, EntryRecord, Progress, ScanSink, ScanTotals, ScanWarning};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use std::collections::HashMap;
use std::fs::File;
use std::io;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};

/// The directory, inside the index directory, that holds this layout's scans.
/// A layout this build cannot read lives somewhere else and is never opened.
pub const LAYOUT_DIRECTORY: &str = "index-v3";

/// What earlier builds left in the index directory itself. They are caches
/// this build cannot read, so they are removed when a scan begins rather than
/// left to hold their space for ever.
const LEGACY_FILES: [&str; 3] = [
    "index-v1.sqlite",
    "index-v1.sqlite-wal",
    "index-v1.sqlite-shm",
];

const FINISHED_SUFFIX: &str = ".sqlite";
const PARTIAL_SUFFIX: &str = ".sqlite.partial";

/// Recorded in every scan file. A file with any other version is a cache from
/// another build and is not served.
const SCHEMA_VERSION: i64 = 3;

/// Rows per transaction. Large enough that the per-commit cost disappears,
/// small enough that the dirty pages of one commit stay bounded.
const BATCH_ROWS: usize = 20_000;

/// The page cache the helper allows SQLite, in kibibytes. Negative values mean
/// "this many KiB" rather than "this many pages".
const PAGE_CACHE_KIB: i64 = 8 * 1024;

pub struct IndexLimits {
    pub max_bytes: u64,
    pub keep_scans: u32,
}

impl Default for IndexLimits {
    fn default() -> IndexLimits {
        IndexLimits {
            max_bytes: 2 * 1024 * 1024 * 1024,
            keep_scans: 3,
        }
    }
}

/// Whether `id` can name a scan file. The same rule as the contract's
/// `scanId`: a scan ID becomes a file name here, so the helper checks it
/// itself rather than trusting that the client did.
pub fn valid_scan_id(id: &str) -> bool {
    (8..=128).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn layout(directory: &Path) -> PathBuf {
    directory.join(LAYOUT_DIRECTORY)
}

fn finished_path(layout: &Path, scan_id: &str) -> PathBuf {
    layout.join(format!("{scan_id}{FINISHED_SUFFIX}"))
}

fn partial_path(layout: &Path, scan_id: &str) -> PathBuf {
    layout.join(format!("{scan_id}{PARTIAL_SUFFIX}"))
}

fn sqlite_failure(error: io::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

/// Open one finished scan for reading, or `None` when the index does not
/// hold it.
///
/// A scan that was pruned, never finished, or written by a build with another
/// layout is the same answer to a caller: run a new scan. A file that is not a
/// database at all is a damaged cache and gets that answer too, rather than an
/// internal error on a command somebody ran casually.
pub fn open_scan(directory: &Path, scan_id: &str) -> rusqlite::Result<Option<Connection>> {
    if !valid_scan_id(scan_id) {
        return Ok(None);
    }
    let path = finished_path(&layout(directory), scan_id);
    if !path.is_file() {
        return Ok(None);
    }
    let connection = match Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(connection) => connection,
        // Pruned between the check above and the open.
        Err(error) if is_missing_or_damaged(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let served = connection
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .and_then(|version| {
            if version != SCHEMA_VERSION {
                return Ok(false);
            }
            connection
                .query_row(
                    "SELECT 1 FROM scan WHERE id = ?1 AND finished = 1",
                    params![scan_id],
                    |_| Ok(()),
                )
                .optional()
                .map(|found| found.is_some())
        });
    match served {
        Ok(true) => {}
        Ok(false) => return Ok(None),
        Err(error) if is_missing_or_damaged(&error) => return Ok(None),
        Err(error) => return Err(error),
    }
    connection.pragma_update(None, "cache_size", -PAGE_CACHE_KIB)?;
    Ok(Some(connection))
}

fn is_missing_or_damaged(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(
            rusqlite::ErrorCode::CannotOpen
                | rusqlite::ErrorCode::NotADatabase
                | rusqlite::ErrorCode::DatabaseCorrupt
        )
    )
}

const TABLES: &str = "
CREATE TABLE scan (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  accounting TEXT NOT NULL,
  roots TEXT NOT NULL,
  scanned_entries TEXT NOT NULL DEFAULT '0',
  inaccessible_directories TEXT NOT NULL DEFAULT '0',
  allocated_bytes TEXT NOT NULL DEFAULT '0',
  apparent_bytes TEXT NOT NULL DEFAULT '0',
  shared_bytes TEXT NOT NULL DEFAULT '0',
  excluded_mounts TEXT NOT NULL DEFAULT '[]',
  warnings TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE entry (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER,
  name BLOB NOT NULL,
  search_name TEXT NOT NULL,
  extension TEXT NOT NULL,
  kind INTEGER NOT NULL,
  device TEXT NOT NULL,
  inode TEXT NOT NULL,
  mount_id TEXT NOT NULL,
  link_count INTEGER NOT NULL,
  apparent_bytes INTEGER NOT NULL,
  allocated_bytes INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  modified_ns INTEGER NOT NULL,
  shared INTEGER NOT NULL,
  broken INTEGER NOT NULL DEFAULT 0,
  child_entries INTEGER,
  subtree_entries INTEGER NOT NULL DEFAULT 1,
  subtree_max_id INTEGER NOT NULL DEFAULT 0
);
";

/// Built once, after the last row is in. Building an index over a finished
/// table is a sort; keeping it ordered while rows arrive in walk order is a
/// random write per row per index.
///
/// Every index ends in the row ID implicitly, which is the tie-break every
/// page sorts by, so a page read from one in either direction needs no sort.
/// - `entry_child_*`: one directory's children in each order a listing can
///   ask for. Browsing a directory reads exactly one page of these.
/// - `entry_allocated`, `entry_apparent`, `entry_modified`: a large subtree,
///   or the whole scan, ranked. Ranking by name is rare enough to sort.
/// - `entry_type`, `entry_owner`: covering indexes for the two aggregates,
///   which also serve an equality filter on extension or owner.
const INDEXES: &str = "
CREATE INDEX entry_child_allocated ON entry(parent_id, allocated_bytes);
CREATE INDEX entry_child_apparent ON entry(parent_id, apparent_bytes);
CREATE INDEX entry_child_modified ON entry(parent_id, modified_ns);
CREATE INDEX entry_child_name ON entry(parent_id, search_name);
CREATE INDEX entry_allocated ON entry(allocated_bytes);
CREATE INDEX entry_apparent ON entry(apparent_bytes);
CREATE INDEX entry_modified ON entry(modified_ns);
CREATE INDEX entry_type ON entry(extension, kind, shared, allocated_bytes, apparent_bytes);
CREATE INDEX entry_owner ON entry(owner_id, kind, shared, allocated_bytes, apparent_bytes);
";

/// A scan's writer. Rows go into a partial file that only this writer holds;
/// the file is published under its final name once its totals and indexes
/// are written, so an interrupted scan is never served as though it were
/// whole.
pub struct IndexWriter {
    connection: Option<Connection>,
    layout: PathBuf,
    scan_id: String,
    /// An exclusive `flock` on the partial file for as long as this writer
    /// lives. Pruning removes a partial file only when it can take that lock
    /// itself, which is how a scan another process is still writing is told
    /// from one whose writer died.
    lock: Option<File>,
    published: bool,
    pending: usize,
    in_transaction: bool,
    failure: Option<io::Error>,
}

impl IndexWriter {
    pub fn begin(
        directory: &Path,
        scan_id: &str,
        roots: &[Vec<u8>],
        accounting: &str,
        limits: &IndexLimits,
    ) -> rusqlite::Result<IndexWriter> {
        if !valid_scan_id(scan_id) {
            return Err(sqlite_failure(io::Error::new(
                io::ErrorKind::InvalidInput,
                "a scan ID cannot name an index file",
            )));
        }
        let layout = layout(directory);
        // The index names every file below the roots, including the ones in
        // directories nobody else may list, so it is as private as the most
        // private of them.
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&layout)
            .map_err(sqlite_failure)?;
        for legacy in LEGACY_FILES {
            let _ = std::fs::remove_file(directory.join(legacy));
        }
        prune(&layout, limits.keep_scans.saturating_sub(1) as usize)?;

        let partial = partial_path(&layout, scan_id);
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&partial)
            .map_err(sqlite_failure)?;
        if let Err(error) = flock(&lock, libc::LOCK_EX | libc::LOCK_NB) {
            let _ = std::fs::remove_file(&partial);
            return Err(sqlite_failure(error));
        }

        let mut writer = IndexWriter {
            connection: None,
            layout,
            scan_id: scan_id.to_owned(),
            lock: Some(lock),
            published: false,
            pending: 0,
            in_transaction: false,
            failure: None,
        };
        let connection = Connection::open(&partial)?;
        // Nothing reads this file until it is published, and a crash leaves a
        // file that is thrown away rather than recovered, so a rollback
        // journal and fsync on every commit would buy nothing.
        connection.pragma_update(None, "journal_mode", "OFF")?;
        connection.pragma_update(None, "synchronous", "OFF")?;
        connection.pragma_update(None, "locking_mode", "EXCLUSIVE")?;
        connection.pragma_update(None, "cache_size", -PAGE_CACHE_KIB)?;
        connection.execute_batch(TABLES)?;
        connection.execute(
            "INSERT INTO scan (id, started_at, accounting, roots) VALUES (?1, ?2, ?3, ?4)",
            params![
                scan_id,
                unix_seconds(),
                accounting,
                serde_json::to_string(&encode_paths(roots)).unwrap_or_else(|_| "[]".to_owned()),
            ],
        )?;
        writer.connection = Some(connection);
        writer.start_transaction()?;
        Ok(writer)
    }

    fn connection(&self) -> &Connection {
        self.connection
            .as_ref()
            .expect("the connection lives until the writer is published")
    }

    fn start_transaction(&mut self) -> rusqlite::Result<()> {
        if !self.in_transaction {
            self.connection().execute_batch("BEGIN")?;
            self.in_transaction = true;
        }
        Ok(())
    }

    fn commit(&mut self) -> rusqlite::Result<()> {
        if self.in_transaction {
            self.connection().execute_batch("COMMIT")?;
            self.in_transaction = false;
        }
        self.pending = 0;
        Ok(())
    }

    /// Write the scan's totals, build its indexes, and publish it; then bring
    /// the index directory back inside its byte budget.
    pub fn finish(mut self, totals: &ScanTotals, limits: &IndexLimits) -> rusqlite::Result<()> {
        if let Some(failure) = self.failure.take() {
            return Err(sqlite_failure(failure));
        }
        self.commit()?;
        let connection = self
            .connection
            .take()
            .expect("the connection lives until the writer is published");
        connection.execute_batch(INDEXES)?;
        connection.execute(
            "UPDATE scan SET finished = 1, complete = ?2, scanned_entries = ?3,
                    inaccessible_directories = ?4, allocated_bytes = ?5, apparent_bytes = ?6,
                    shared_bytes = ?7, excluded_mounts = ?8, warnings = ?9
             WHERE id = ?1",
            params![
                self.scan_id,
                i64::from(totals.complete),
                totals.scanned_entries.to_string(),
                totals.inaccessible_directories.to_string(),
                totals.allocated_bytes.to_string(),
                totals.apparent_bytes.to_string(),
                totals.shared_bytes.to_string(),
                serde_json::to_string(&encode_paths(&totals.excluded_mounts))
                    .unwrap_or_else(|_| "[]".to_owned()),
                serde_json::to_string(&encode_warnings(&totals.warnings))
                    .unwrap_or_else(|_| "[]".to_owned()),
            ],
        )?;
        connection.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        connection.close().map_err(|(_, error)| error)?;

        // The bytes reach the disk before the name that says they are whole.
        let lock = self.lock.as_ref().expect("the lock is held until publish");
        lock.sync_all().map_err(sqlite_failure)?;
        let finished = finished_path(&self.layout, &self.scan_id);
        std::fs::rename(partial_path(&self.layout, &self.scan_id), &finished)
            .map_err(sqlite_failure)?;
        self.published = true;
        if let Ok(directory) = File::open(&self.layout) {
            let _ = directory.sync_all();
        }
        self.lock = None;

        enforce_byte_budget(&self.layout, limits, &self.scan_id)
    }

    fn record(&mut self, record: &EntryRecord<'_>) -> rusqlite::Result<i64> {
        let metadata = record.metadata;
        let connection = self.connection();
        let mut insert = connection.prepare_cached(
            "INSERT INTO entry (
                parent_id, name, search_name, extension, kind, device, inode, mount_id,
                link_count, apparent_bytes, allocated_bytes, owner_id, modified_ns, shared,
                broken
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        )?;
        let id = insert.insert(params![
            record.parent,
            record.name,
            searchable(record.name),
            extension_of(record.name),
            metadata.kind.code(),
            metadata.device.to_string(),
            metadata.inode.to_string(),
            metadata.mount_id.to_string(),
            clamp(metadata.link_count),
            clamp(metadata.apparent_bytes),
            clamp(metadata.allocated_bytes),
            i64::from(metadata.owner_id),
            clamp(metadata.modified_nanoseconds),
            i64::from(record.shared),
            i64::from(record.broken),
        ])?;
        drop(insert);

        self.pending += 1;
        if self.pending >= BATCH_ROWS {
            self.commit()?;
            self.start_transaction()?;
        }
        Ok(id)
    }

    fn total(&mut self, id: i64, totals: &DirectoryTotals) -> rusqlite::Result<()> {
        let mut update = self.connection().prepare_cached(
            "UPDATE entry SET allocated_bytes = ?2, apparent_bytes = ?3, subtree_entries = ?4,
                    child_entries = ?5, subtree_max_id = max(?1, last_insert_rowid())
             WHERE id = ?1",
        )?;
        update.execute(params![
            id,
            clamp(totals.allocated_bytes),
            clamp(totals.apparent_bytes),
            clamp(totals.entries),
            clamp(totals.child_entries),
        ])?;
        Ok(())
    }
}

/// A writer that is dropped without being published takes its partial file
/// with it. A process that dies leaves the file, and the next scan's pruning
/// finds it unlocked and removes it.
impl Drop for IndexWriter {
    fn drop(&mut self) {
        if self.published {
            return;
        }
        drop(self.connection.take());
        let _ = std::fs::remove_file(partial_path(&self.layout, &self.scan_id));
        self.lock = None;
    }
}

/// The sink the walker writes through. A database failure is remembered and
/// surfaced by `finish`, because a half-written index must never be reported
/// as a complete scan.
impl ScanSink for IndexWriter {
    fn entry(&mut self, record: &EntryRecord<'_>) -> io::Result<i64> {
        match self.record(record) {
            Ok(id) => Ok(id),
            Err(error) => {
                let failure = io::Error::other(format!("The index could not be written: {error}"));
                self.failure = Some(io::Error::other(failure.to_string()));
                Err(failure)
            }
        }
    }

    /// The walk is depth-first, so everything inserted between a directory's
    /// own row and the moment it is closed is one of its descendants and
    /// nothing else is. Recording the last row ID at that moment turns "the
    /// subtree under this directory" into a primary-key range, which a query
    /// can apply without walking parent links or materialising a descendant
    /// set.
    fn finish_directory(&mut self, id: i64, totals: &DirectoryTotals) -> io::Result<()> {
        self.total(id, totals).map_err(|error| {
            let failure =
                io::Error::other(format!("The directory total could not be written: {error}"));
            self.failure = Some(io::Error::other(failure.to_string()));
            failure
        })
    }

    fn progress(&mut self, _snapshot: &Progress) {}
}

fn flock(file: &File, operation: libc::c_int) -> io::Result<()> {
    if unsafe { libc::flock(file.as_raw_fd(), operation) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// One published scan file, as pruning sees it.
struct Stored {
    scan_id: String,
    path: PathBuf,
    bytes: u64,
    modified: std::time::SystemTime,
}

/// The published scans in the layout directory, newest first.
///
/// A partial file whose writer is gone is removed on the way: it can never be
/// published, and nothing else would ever remove it. One whose writer is alive
/// is left alone, whichever process holds it.
fn stored_scans(layout: &Path) -> rusqlite::Result<Vec<Stored>> {
    let mut stored = Vec::new();
    let entries = match std::fs::read_dir(layout) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(stored),
        Err(error) => return Err(sqlite_failure(error)),
    };
    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if let Some(scan_id) = name.strip_suffix(PARTIAL_SUFFIX) {
            if valid_scan_id(scan_id) {
                remove_if_abandoned(&entry.path());
            }
            continue;
        }
        let Some(scan_id) = name.strip_suffix(FINISHED_SUFFIX) else {
            continue;
        };
        if !valid_scan_id(scan_id) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        stored.push(Stored {
            scan_id: scan_id.to_owned(),
            path: entry.path(),
            bytes: metadata.len(),
            modified: metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
        });
    }
    stored.sort_by(|left, right| right.modified.cmp(&left.modified));
    Ok(stored)
}

fn remove_if_abandoned(path: &Path) {
    let Ok(file) = std::fs::OpenOptions::new().read(true).open(path) else {
        return;
    };
    // The writer holds this lock for its whole life, so taking it means the
    // writer is gone. It is held across the removal so no writer can be
    // between creating the file and locking it.
    if flock(&file, libc::LOCK_EX | libc::LOCK_NB).is_ok() {
        let _ = std::fs::remove_file(path);
    }
}

/// Keep the `keep` newest published scans and remove the rest.
fn prune(layout: &Path, keep: usize) -> rusqlite::Result<()> {
    for doomed in stored_scans(layout)?.into_iter().skip(keep) {
        let _ = std::fs::remove_file(&doomed.path);
    }
    Ok(())
}

/// Drop whole scans, oldest first, until the directory fits its budget. The
/// scan just written is never the one dropped, so a scan always leaves a
/// usable index behind even on a tight budget.
fn enforce_byte_budget(layout: &Path, limits: &IndexLimits, keep: &str) -> rusqlite::Result<()> {
    let stored = stored_scans(layout)?;
    let mut total: u64 = stored.iter().map(|scan| scan.bytes).sum();
    for oldest in stored.iter().rev() {
        if total <= limits.max_bytes {
            break;
        }
        if oldest.scan_id == keep {
            continue;
        }
        if std::fs::remove_file(&oldest.path).is_ok() {
            total = total.saturating_sub(oldest.bytes);
        }
    }
    Ok(())
}

/// Rebuild absolute paths for one page of rows.
///
/// Directory paths are memoised across the page, so a listing of one directory
/// costs a single chain walk rather than one per row.
pub struct PathResolver<'a> {
    connection: &'a Connection,
    cache: HashMap<i64, Vec<u8>>,
}

impl<'a> PathResolver<'a> {
    pub fn new(connection: &'a Connection) -> PathResolver<'a> {
        PathResolver {
            connection,
            cache: HashMap::new(),
        }
    }

    pub fn path(&mut self, parent: Option<i64>, name: &[u8]) -> rusqlite::Result<Vec<u8>> {
        let Some(parent) = parent else {
            // A root row holds its whole absolute path as its name.
            return Ok(name.to_vec());
        };
        let prefix = self.directory(parent)?;
        Ok(crate::walk::join(&prefix, name))
    }

    fn directory(&mut self, id: i64) -> rusqlite::Result<Vec<u8>> {
        if let Some(cached) = self.cache.get(&id) {
            return Ok(cached.clone());
        }
        let mut lookup = self
            .connection
            .prepare_cached("SELECT parent_id, name FROM entry WHERE id = ?1")?;
        let mut chain: Vec<(i64, Option<i64>, Vec<u8>)> = Vec::new();
        let mut current = Some(id);
        while let Some(next) = current {
            if self.cache.contains_key(&next) {
                break;
            }
            let row: Option<(Option<i64>, Vec<u8>)> = lookup
                .query_row(params![next], |row| Ok((row.get(0)?, row.get(1)?)))
                .optional()?;
            let Some((parent, name)) = row else {
                break;
            };
            chain.push((next, parent, name));
            current = parent;
        }

        for (node, parent, name) in chain.into_iter().rev() {
            let path = match parent {
                None => name,
                Some(parent) => match self.cache.get(&parent) {
                    Some(prefix) => crate::walk::join(prefix, &name),
                    // A parent row that is missing means a partial scan; the
                    // name alone is still byte-accurate.
                    None => name,
                },
            };
            self.cache.insert(node, path);
        }
        Ok(self.cache.get(&id).cloned().unwrap_or_default())
    }
}

/// Lowercased, lossy text for substring search. The raw bytes stay in `name`;
/// this column exists so a filter can match without ever becoming the value an
/// operation resolves.
pub fn searchable(name: &[u8]) -> String {
    String::from_utf8_lossy(name).to_lowercase()
}

/// The final dot-separated suffix, lowercased, empty when there is none. A
/// leading dot is a hidden file rather than an extension.
pub fn extension_of(name: &[u8]) -> String {
    let base = match name.iter().rposition(|byte| *byte == b'/') {
        Some(slash) => &name[slash + 1..],
        None => name,
    };
    let Some(dot) = base.iter().rposition(|byte| *byte == b'.') else {
        return String::new();
    };
    if dot == 0 || dot + 1 >= base.len() {
        return String::new();
    }
    let suffix = &base[dot + 1..];
    if suffix.len() > 64 {
        return String::new();
    }
    String::from_utf8_lossy(suffix).to_lowercase()
}

fn clamp(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

fn unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

fn encode_paths(paths: &[Vec<u8>]) -> Vec<String> {
    paths
        .iter()
        .map(|path| crate::base64::encode(path))
        .collect()
}

fn encode_warnings(warnings: &[ScanWarning]) -> Vec<serde_json::Value> {
    warnings
        .iter()
        .map(|warning| {
            let mut object = serde_json::Map::new();
            object.insert("code".to_owned(), warning.code.into());
            object.insert("message".to_owned(), warning.message.clone().into());
            if let Some(path) = &warning.path {
                object.insert("path".to_owned(), crate::base64::encode(path).into());
            }
            serde_json::Value::Object(object)
        })
        .collect()
}

/// One regular file that might have a twin, as the index remembers it.
///
/// `shared` rows are left out at the query, not filtered afterwards: a second
/// hardlink's bytes were attributed to the first one, and offering it as a
/// duplicate would offer to free bytes that removing it does not free.
pub struct SizeCandidate {
    pub parent_id: Option<i64>,
    pub name: Vec<u8>,
}

/// Every regular file in one scan whose apparent size is shared with at least
/// one other regular file, grouped by that size, largest first.
///
/// The grouping happens in SQL because the index already has the sizes and the
/// alternative is carrying one row per file through Rust to discover that most
/// of them are alone. Only sizes with two or more members come back, so the
/// caller never opens a file that had no possible twin.
pub fn size_candidates(
    connection: &Connection,
    under: Option<(i64, i64)>,
    minimum_bytes: u64,
) -> rusqlite::Result<Vec<(u64, Vec<SizeCandidate>)>> {
    // The range is always bound, covering every row when no path narrows it,
    // so one statement serves both shapes and neither can bind the wrong count.
    let (first, last) = under.unwrap_or((i64::MIN, i64::MAX));
    let sql = "SELECT apparent_bytes, id, parent_id, name FROM entry
         WHERE kind = ?1 AND shared = 0 AND apparent_bytes >= ?2
           AND id BETWEEN ?3 AND ?4
           AND apparent_bytes IN (
             SELECT apparent_bytes FROM entry
             WHERE kind = ?1 AND shared = 0 AND apparent_bytes >= ?2
               AND id BETWEEN ?3 AND ?4
             GROUP BY apparent_bytes HAVING count(*) > 1
           )
         ORDER BY apparent_bytes DESC, id ASC";

    let mut statement = connection.prepare(sql)?;
    let mut rows = statement.query(params![
        EntryKind::File.code(),
        clamp(minimum_bytes),
        first,
        last
    ])?;

    let mut grouped: Vec<(u64, Vec<SizeCandidate>)> = Vec::new();
    while let Some(row) = rows.next()? {
        let apparent_bytes = unclamp(row.get::<_, i64>(0)?);
        let candidate = SizeCandidate {
            parent_id: row.get(2)?,
            name: row.get(3)?,
        };
        match grouped.last_mut() {
            Some((size, members)) if *size == apparent_bytes => members.push(candidate),
            _ => grouped.push((apparent_bytes, vec![candidate])),
        }
    }
    Ok(grouped)
}

fn unclamp(value: i64) -> u64 {
    value.max(0) as u64
}

/// The primary-key range covering one path and everything below it.
///
/// Returns `None` when the path is not in this scan, which a caller must
/// report as such: an empty page would read as "there is nothing there".
pub fn subtree_range(connection: &Connection, path: &[u8]) -> rusqlite::Result<Option<(i64, i64)>> {
    let mut best: Option<(i64, Vec<u8>)> = None;
    {
        let mut roots = connection.prepare("SELECT id, name FROM entry WHERE parent_id IS NULL")?;
        let mut rows = roots.query([])?;
        while let Some(row) = rows.next()? {
            let id: i64 = row.get(0)?;
            let name: Vec<u8> = row.get(1)?;
            // The longest matching root wins, so nested roots resolve to the
            // one that actually holds the path.
            if crate::walk::is_within(&name, path)
                && best
                    .as_ref()
                    .is_none_or(|(_, chosen)| name.len() > chosen.len())
            {
                best = Some((id, name));
            }
        }
    }

    let Some((mut current, root)) = best else {
        return Ok(None);
    };
    // The searchable name narrows the lookup to an index seek, so resolving a
    // path through a directory of half a million entries reads a handful of
    // rows rather than all of them; the byte comparison is the one that
    // decides, because two names can share a searchable form.
    let mut child = connection.prepare(
        "SELECT id FROM entry INDEXED BY entry_child_name
         WHERE parent_id = ?1 AND search_name = ?2 AND name = ?3",
    )?;
    for segment in path[root.len()..].split(|byte| *byte == b'/') {
        if segment.is_empty() {
            continue;
        }
        let found: Option<i64> = child
            .query_row(params![current, searchable(segment), segment], |row| {
                row.get(0)
            })
            .optional()?;
        let Some(next) = found else {
            return Ok(None);
        };
        current = next;
    }

    let maximum: i64 = connection.query_row(
        "SELECT max(?2, subtree_max_id) FROM entry WHERE id = ?1",
        params![current, current],
        |row| row.get(0),
    )?;
    Ok(Some((current, maximum)))
}

pub fn kind_of(code: i64) -> EntryKind {
    EntryKind::from_code(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_extension_is_the_last_suffix_and_a_dotfile_has_none() {
        assert_eq!(extension_of(b"archive.TAR.gz"), "gz");
        assert_eq!(extension_of(b".bashrc"), "");
        assert_eq!(extension_of(b"README"), "");
        assert_eq!(extension_of(b"trailing."), "");
        assert_eq!(extension_of(b"/var/log/system.log"), "log");
    }

    #[test]
    fn search_text_is_lossy_but_the_name_bytes_are_not_involved() {
        assert_eq!(searchable(&[b'A', 0xff, b'B']), "a\u{fffd}b");
    }

    #[test]
    fn a_scan_id_that_could_leave_its_directory_cannot_name_a_file() {
        assert!(valid_scan_id("scan-1790000000-0123456789abcdef"));
        assert!(!valid_scan_id("../../../etc/passwd"));
        assert!(!valid_scan_id("scan/with/slash"));
        assert!(!valid_scan_id("short"));
        assert!(!valid_scan_id(&"a".repeat(129)));
    }
}

#[cfg(test)]
mod storage_tests {
    use super::*;
    use crate::testing::Sandbox;
    use crate::walk::ScanTotals;
    use std::os::unix::fs::PermissionsExt;

    fn totals() -> ScanTotals {
        ScanTotals {
            complete: true,
            scanned_entries: 0,
            inaccessible_directories: 0,
            allocated_bytes: 0,
            apparent_bytes: 0,
            shared_bytes: 0,
            excluded_mounts: Vec::new(),
            warnings: Vec::new(),
            filesystems: Vec::new(),
        }
    }

    fn write_scan(directory: &Path, scan_id: &str, rows: usize, limits: &IndexLimits) {
        let mut writer = IndexWriter::begin(
            directory,
            scan_id,
            &[b"/root".to_vec()],
            "allocated",
            limits,
        )
        .expect("a writer");
        let metadata = crate::sys::metadata_of(
            File::open(directory)
                .expect("the index directory opens")
                .as_raw_fd(),
        )
        .expect("metadata");
        for index in 0..rows {
            let name = format!("file-{index}");
            writer
                .entry(&EntryRecord {
                    parent: None,
                    name: name.as_bytes(),
                    metadata: &metadata,
                    shared: false,
                    broken: false,
                })
                .expect("a row");
        }
        writer.finish(&totals(), limits).expect("finish");
    }

    fn files_in(directory: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(directory.join(LAYOUT_DIRECTORY))
            .expect("the layout directory lists")
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn bytes_in(directory: &Path) -> u64 {
        std::fs::read_dir(directory.join(LAYOUT_DIRECTORY))
            .expect("the layout directory lists")
            .map(|entry| entry.unwrap().metadata().unwrap().len())
            .sum()
    }

    #[test]
    fn a_finished_scan_is_served_and_an_unknown_one_is_not() {
        let sandbox = Sandbox::new("index-served");
        write_scan(sandbox.path(), "scan-served-1", 10, &IndexLimits::default());

        let connection = open_scan(sandbox.path(), "scan-served-1")
            .expect("open")
            .expect("the scan is held");
        let rows: i64 = connection
            .query_row("SELECT count(*) FROM entry", [], |row| row.get(0))
            .expect("count");
        assert_eq!(rows, 10);

        assert!(
            open_scan(sandbox.path(), "scan-never-run")
                .unwrap()
                .is_none()
        );
        assert!(
            open_scan(sandbox.path(), "../escape-attempt")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn pruning_a_scan_returns_its_space_to_the_filesystem() {
        let sandbox = Sandbox::new("index-prune");
        let limits = IndexLimits {
            max_bytes: u64::MAX,
            keep_scans: 2,
        };
        write_scan(sandbox.path(), "scan-prune-1", 20_000, &limits);
        let one_scan = bytes_in(sandbox.path());
        write_scan(sandbox.path(), "scan-prune-2", 20_000, &limits);
        write_scan(sandbox.path(), "scan-prune-3", 20_000, &limits);

        assert_eq!(
            files_in(sandbox.path()),
            vec!["scan-prune-2.sqlite", "scan-prune-3.sqlite"],
        );
        // Two scans' worth of bytes, not three: the pruned scan's pages are
        // gone from the disk rather than left free inside a shared file.
        assert!(
            bytes_in(sandbox.path()) <= one_scan * 2 + one_scan / 10,
            "{} bytes held for two scans of {one_scan}",
            bytes_in(sandbox.path())
        );
        assert!(open_scan(sandbox.path(), "scan-prune-1").unwrap().is_none());
    }

    #[test]
    fn the_byte_budget_drops_older_scans_but_never_the_newest() {
        let sandbox = Sandbox::new("index-budget");
        let generous = IndexLimits {
            max_bytes: u64::MAX,
            keep_scans: 10,
        };
        write_scan(sandbox.path(), "scan-budget-1", 5_000, &generous);
        write_scan(sandbox.path(), "scan-budget-2", 5_000, &generous);
        let tight = IndexLimits {
            max_bytes: 1,
            keep_scans: 10,
        };
        write_scan(sandbox.path(), "scan-budget-3", 5_000, &tight);

        assert_eq!(files_in(sandbox.path()), vec!["scan-budget-3.sqlite"]);
    }

    #[test]
    fn a_scan_being_written_never_holds_up_a_reader_of_another() {
        let sandbox = Sandbox::new("index-reader");
        let limits = IndexLimits::default();
        write_scan(sandbox.path(), "scan-reader-1", 100, &limits);

        // A second scan is mid-write, inside an open transaction, as a
        // timer-driven scan would be while somebody browses the last one.
        let mut writer = IndexWriter::begin(
            sandbox.path(),
            "scan-reader-2",
            &[b"/root".to_vec()],
            "allocated",
            &limits,
        )
        .expect("a writer");
        let metadata = crate::sys::metadata_of(
            File::open(sandbox.path())
                .expect("the sandbox opens")
                .as_raw_fd(),
        )
        .expect("metadata");
        writer
            .entry(&EntryRecord {
                parent: None,
                name: b"pending",
                metadata: &metadata,
                shared: false,
                broken: false,
            })
            .expect("a row");

        let started = std::time::Instant::now();
        let connection = open_scan(sandbox.path(), "scan-reader-1")
            .expect("open")
            .expect("the finished scan is served");
        let rows: i64 = connection
            .query_row("SELECT count(*) FROM entry", [], |row| row.get(0))
            .expect("count");
        assert_eq!(rows, 100);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "a reader waited {:?} on a writer of another scan",
            started.elapsed()
        );
        drop(writer);
    }

    #[test]
    fn a_scan_being_written_is_invisible_and_its_abandoned_file_is_removed() {
        let sandbox = Sandbox::new("index-partial");
        let limits = IndexLimits::default();
        let writer = IndexWriter::begin(
            sandbox.path(),
            "scan-partial-1",
            &[b"/root".to_vec()],
            "allocated",
            &limits,
        )
        .expect("a writer");
        assert!(
            open_scan(sandbox.path(), "scan-partial-1")
                .unwrap()
                .is_none()
        );

        // Another scan beginning meanwhile leaves a live writer's file alone.
        write_scan(sandbox.path(), "scan-partial-2", 1, &limits);
        assert!(files_in(sandbox.path()).contains(&"scan-partial-1.sqlite.partial".to_owned()));

        // A writer that is dropped unpublished takes its file with it.
        drop(writer);
        assert_eq!(files_in(sandbox.path()), vec!["scan-partial-2.sqlite"]);

        // A writer that died without dropping anything leaves an unlocked
        // partial behind, and the next scan removes it.
        let orphan = sandbox
            .path()
            .join(LAYOUT_DIRECTORY)
            .join("scan-orphan-1.sqlite.partial");
        std::fs::write(&orphan, b"half a scan").expect("an orphan");
        write_scan(sandbox.path(), "scan-partial-3", 1, &limits);
        assert!(
            !orphan.exists(),
            "an abandoned partial scan was left behind"
        );
    }

    #[test]
    fn an_index_from_another_build_is_removed_and_never_served() {
        let sandbox = Sandbox::new("index-legacy");
        let legacy = sandbox.path().join("index-v1.sqlite");
        std::fs::write(&legacy, b"an older layout").expect("a legacy index");
        write_scan(sandbox.path(), "scan-legacy-1", 1, &IndexLimits::default());
        assert!(!legacy.exists(), "the legacy cache still holds its space");

        // A file in this layout's directory with another schema version is a
        // cache from another build and is not read as this one.
        let path = finished_path(&layout(sandbox.path()), "scan-legacy-1");
        {
            let connection = Connection::open(&path).expect("open");
            connection
                .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
                .expect("restamp");
        }
        assert!(
            open_scan(sandbox.path(), "scan-legacy-1")
                .unwrap()
                .is_none()
        );

        std::fs::write(&path, b"not a database").expect("damage");
        assert!(
            open_scan(sandbox.path(), "scan-legacy-1")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn every_index_file_is_private_to_its_owner() {
        let sandbox = Sandbox::new("index-private");
        let writer = IndexWriter::begin(
            sandbox.path(),
            "scan-private-1",
            &[b"/root".to_vec()],
            "allocated",
            &IndexLimits::default(),
        )
        .expect("a writer");
        let mut modes = vec![
            std::fs::metadata(sandbox.path().join(LAYOUT_DIRECTORY))
                .unwrap()
                .permissions()
                .mode(),
        ];
        for name in files_in(sandbox.path()) {
            modes.push(
                std::fs::metadata(sandbox.path().join(LAYOUT_DIRECTORY).join(name))
                    .unwrap()
                    .permissions()
                    .mode(),
            );
        }
        writer
            .finish(&totals(), &IndexLimits::default())
            .expect("finish");
        for name in files_in(sandbox.path()) {
            modes.push(
                std::fs::metadata(sandbox.path().join(LAYOUT_DIRECTORY).join(name))
                    .unwrap()
                    .permissions()
                    .mode(),
            );
        }
        assert_eq!(modes.len(), 3);
        for mode in modes {
            assert_eq!(mode & 0o077, 0, "mode {mode:o} is open to other users");
        }
    }
}
