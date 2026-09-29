//! The disk-backed file index.
//!
//! One row per entry, holding a name as raw bytes and its parent's ID rather
//! than a repeated absolute path. Full paths are rebuilt a page at a time when
//! a query asks for them, so neither the helper nor Node ever holds the tree.
//!
//! The index is a cache: it is bounded by a scan count and a byte budget, and
//! old scans are pruned rather than accumulated. Nothing here can be read as
//! authority for a mutation; a reviewed plan revalidates every target live.

use crate::sys::EntryKind;
use crate::walk::{DirectoryTotals, EntryRecord, Progress, ScanSink, ScanTotals, ScanWarning};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

pub const INDEX_FILE: &str = "index-v1.sqlite";

/// Rows per transaction. Large enough that the per-commit cost disappears,
/// small enough that the write-ahead log does not grow with the scan.
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

pub fn index_path(directory: &Path) -> PathBuf {
    directory.join(INDEX_FILE)
}

pub fn open(directory: &Path) -> rusqlite::Result<Connection> {
    let connection = Connection::open(index_path(directory))?;
    // auto_vacuum has to be chosen before the first table exists, or pruning a
    // scan would shrink the row count without ever returning the file's pages.
    connection.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "cache_size", -PAGE_CACHE_KIB)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.execute_batch(SCHEMA)?;
    Ok(connection)
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS scan (
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

CREATE TABLE IF NOT EXISTS entry (
  id INTEGER PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
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
  subtree_entries INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS entry_allocated ON entry(scan_id, allocated_bytes DESC, id DESC);
CREATE INDEX IF NOT EXISTS entry_apparent ON entry(scan_id, apparent_bytes DESC, id DESC);
CREATE INDEX IF NOT EXISTS entry_modified ON entry(scan_id, modified_ns DESC, id DESC);
CREATE INDEX IF NOT EXISTS entry_name ON entry(scan_id, search_name, id);
CREATE INDEX IF NOT EXISTS entry_extension ON entry(scan_id, extension);
CREATE INDEX IF NOT EXISTS entry_parent ON entry(scan_id, parent_id);
CREATE INDEX IF NOT EXISTS entry_owner ON entry(scan_id, owner_id);
";

/// A scan's writer. Rows go in inside bounded transactions; the scan row is
/// only marked finished once its totals are written, so an interrupted scan is
/// visibly unfinished rather than silently short.
pub struct IndexWriter {
    connection: Connection,
    scan_id: String,
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
        let connection = open(directory)?;
        connection.execute(
            "INSERT INTO scan (id, started_at, accounting, roots) VALUES (?1, ?2, ?3, ?4)",
            params![
                scan_id,
                unix_seconds(),
                accounting,
                serde_json::to_string(&encode_paths(roots)).unwrap_or_else(|_| "[]".to_owned()),
            ],
        )?;
        prune(&connection, limits, scan_id)?;

        let mut writer = IndexWriter {
            connection,
            scan_id: scan_id.to_owned(),
            pending: 0,
            in_transaction: false,
            failure: None,
        };
        writer.start_transaction()?;
        Ok(writer)
    }

    fn start_transaction(&mut self) -> rusqlite::Result<()> {
        if !self.in_transaction {
            self.connection.execute_batch("BEGIN")?;
            self.in_transaction = true;
        }
        Ok(())
    }

    fn commit(&mut self) -> rusqlite::Result<()> {
        if self.in_transaction {
            self.connection.execute_batch("COMMIT")?;
            self.in_transaction = false;
        }
        self.pending = 0;
        Ok(())
    }

    /// Write the scan's totals and mark it usable, then bring the file back
    /// inside its byte budget.
    pub fn finish(mut self, totals: &ScanTotals, limits: &IndexLimits) -> rusqlite::Result<()> {
        if let Some(failure) = self.failure.take() {
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(failure)));
        }
        self.commit()?;
        self.connection.execute(
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
        enforce_byte_budget(&self.connection, limits, &self.scan_id)?;
        Ok(())
    }

    fn record(&mut self, record: &EntryRecord<'_>) -> rusqlite::Result<i64> {
        let metadata = record.metadata;
        self.connection.execute(
            "INSERT INTO entry (
                scan_id, parent_id, name, search_name, extension, kind, device, inode, mount_id,
                link_count, apparent_bytes, allocated_bytes, owner_id, modified_ns, shared
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                self.scan_id,
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
            ],
        )?;
        let id = self.connection.last_insert_rowid();

        self.pending += 1;
        if self.pending >= BATCH_ROWS {
            self.commit()?;
            self.start_transaction()?;
        }
        Ok(id)
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

    fn finish_directory(&mut self, id: i64, totals: &DirectoryTotals) -> io::Result<()> {
        self.connection
            .execute(
                "UPDATE entry SET allocated_bytes = ?2, apparent_bytes = ?3, subtree_entries = ?4
                 WHERE id = ?1",
                params![
                    id,
                    clamp(totals.allocated_bytes),
                    clamp(totals.apparent_bytes),
                    clamp(totals.entries),
                ],
            )
            .map(|_| ())
            .map_err(|error| {
                let failure =
                    io::Error::other(format!("The directory total could not be written: {error}"));
                self.failure = Some(io::Error::other(failure.to_string()));
                failure
            })
    }

    fn progress(&mut self, _snapshot: &Progress) {}
}

/// Keep at most `keep_scans` scans, newest first, always including the one
/// being written.
fn prune(connection: &Connection, limits: &IndexLimits, keep: &str) -> rusqlite::Result<()> {
    connection.execute(
        "DELETE FROM entry WHERE scan_id IN (
             SELECT id FROM scan WHERE id != ?1
             ORDER BY started_at DESC LIMIT -1 OFFSET ?2
         )",
        params![keep, i64::from(limits.keep_scans.saturating_sub(1))],
    )?;
    connection.execute(
        "DELETE FROM scan WHERE id != ?1
         AND id NOT IN (SELECT id FROM scan WHERE id != ?1 ORDER BY started_at DESC LIMIT ?2)",
        params![keep, i64::from(limits.keep_scans.saturating_sub(1))],
    )?;
    connection.pragma_update(None, "incremental_vacuum", 0)?;
    Ok(())
}

/// Drop whole scans, oldest first, until the file fits its budget. The scan
/// just written is never the one dropped, so a scan always leaves a usable
/// index behind even on a tight budget.
fn enforce_byte_budget(
    connection: &Connection,
    limits: &IndexLimits,
    keep: &str,
) -> rusqlite::Result<()> {
    loop {
        if file_bytes(connection)? <= limits.max_bytes {
            return Ok(());
        }
        let oldest: Option<String> = connection
            .query_row(
                "SELECT id FROM scan WHERE id != ?1 ORDER BY started_at ASC LIMIT 1",
                params![keep],
                |row| row.get(0),
            )
            .optional()?;
        let Some(oldest) = oldest else {
            return Ok(());
        };
        connection.execute("DELETE FROM entry WHERE scan_id = ?1", params![oldest])?;
        connection.execute("DELETE FROM scan WHERE id = ?1", params![oldest])?;
        connection.pragma_update(None, "incremental_vacuum", 0)?;
    }
}

fn file_bytes(connection: &Connection) -> rusqlite::Result<u64> {
    let pages: i64 = connection.query_row("PRAGMA page_count", [], |row| row.get(0))?;
    let size: i64 = connection.query_row("PRAGMA page_size", [], |row| row.get(0))?;
    Ok((pages.max(0) as u64).saturating_mul(size.max(0) as u64))
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
        let mut chain: Vec<(i64, Option<i64>, Vec<u8>)> = Vec::new();
        let mut current = Some(id);
        while let Some(next) = current {
            if self.cache.contains_key(&next) {
                break;
            }
            let row: Option<(Option<i64>, Vec<u8>)> = self
                .connection
                .query_row(
                    "SELECT parent_id, name FROM entry WHERE id = ?1",
                    params![next],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
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
                    // A parent row that is missing means a pruned or partial
                    // scan; the name alone is still byte-accurate.
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

/// Whether the index still holds this scan. A pruned scan is a refusal, never
/// an empty page that would read as "nothing here".
pub fn scan_exists(connection: &Connection, scan_id: &str) -> rusqlite::Result<bool> {
    let found: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM scan WHERE id = ?1 AND finished = 1",
            params![scan_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
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
}
