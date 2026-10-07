//! A stable directory listing with bounded resident memory.
//!
//! Actions must read names before removing any, and subtree fingerprints need
//! byte order. Small listings stay in memory; wide directories spill into one
//! anonymous SQLite database shared by a traversal's stack. Its page cache is
//! bounded and closing it removes the scratch file, including after failure.

use crate::sys::Directory;
use rusqlite::{Connection, params};
use std::cell::{Cell, RefCell};
use std::io;
use std::rc::Rc;
use std::sync::atomic::AtomicBool;

const MEMORY_BYTES: usize = 64 * 1024;
const PAGE_NAMES: u32 = 128;

#[derive(Clone, Default)]
pub struct Store(Rc<StoreInner>);

#[derive(Default)]
struct StoreInner {
    connection: RefCell<Option<Connection>>,
    next_set: Cell<i64>,
}

impl Store {
    fn with<T>(&self, work: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> io::Result<T> {
        let mut held = self.0.connection.borrow_mut();
        if held.is_none() {
            let connection = Connection::open("").map_err(io::Error::other)?;
            connection
                .execute_batch(
                    "PRAGMA cache_size = -2048; PRAGMA temp_store = FILE;
                PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;
                CREATE TABLE name (set_id INTEGER NOT NULL, name BLOB NOT NULL,
                    PRIMARY KEY(set_id, name)) WITHOUT ROWID;",
                )
                .map_err(io::Error::other)?;
            *held = Some(connection);
        }
        work(held.as_mut().expect("the scratch database was opened")).map_err(io_error)
    }

    fn next_set(&self) -> i64 {
        let next = self.0.next_set.get() + 1;
        self.0.next_set.set(next);
        next
    }
}

pub enum Names {
    Memory(Vec<Vec<u8>>),
    Disk {
        store: Store,
        set: i64,
        after: Vec<u8>,
        buffer: Vec<Vec<u8>>,
    },
}

impl Names {
    /// Snapshot without changing the directory. Both collecting its names and
    /// processing them remain cancellable while an action has not committed.
    pub fn read(
        directory: &mut Directory,
        store: &Store,
        cancelled: &AtomicBool,
    ) -> io::Result<Self> {
        let mut names = Vec::new();
        let mut bytes = 0usize;
        while let Some(name) = directory.next_name()? {
            crate::transfer::check(cancelled)?;
            bytes += name.len() + std::mem::size_of::<Vec<u8>>();
            names.push(name);
            if bytes >= MEMORY_BYTES {
                let set = store.next_set();
                let mut snapshot = Self::Disk {
                    store: store.clone(),
                    set,
                    after: Vec::new(),
                    buffer: Vec::new(),
                };
                store.with(|connection| {
                    let transaction = connection.transaction()?;
                    {
                        let mut insert =
                            transaction.prepare("INSERT OR IGNORE INTO name VALUES (?1, ?2)")?;
                        for name in names {
                            insert.execute(params![set, name])?;
                        }
                        while let Some(name) = directory.next_name().map_err(sqlite_io)? {
                            crate::transfer::check(cancelled).map_err(sqlite_io)?;
                            insert.execute(params![set, name])?;
                        }
                    }
                    transaction.commit()
                })?;
                // A cancelled empty tail must not accidentally return success.
                crate::transfer::check(cancelled)?;
                if let Self::Disk { buffer, .. } = &mut snapshot {
                    buffer.reserve(PAGE_NAMES as usize);
                }
                return Ok(snapshot);
            }
        }
        crate::transfer::check(cancelled)?;
        names.sort_unstable_by(|left, right| right.cmp(left));
        Ok(Self::Memory(names))
    }

    /// The next name in ascending byte order, at most one bounded page held.
    pub fn pop(&mut self) -> io::Result<Option<Vec<u8>>> {
        match self {
            Self::Memory(names) => Ok(names.pop()),
            Self::Disk {
                store,
                set,
                after,
                buffer,
            } => {
                if buffer.is_empty() {
                    *buffer = store.with(|connection| {
                        let mut query = connection.prepare_cached(
                            "SELECT name FROM name
                            WHERE set_id = ?1 AND name > ?2 ORDER BY name LIMIT ?3",
                        )?;
                        query
                            .query_map(params![*set, &*after, PAGE_NAMES], |row| row.get(0))?
                            .collect()
                    })?;
                    if let Some(last) = buffer.last() {
                        *after = last.clone();
                    }
                    buffer.reverse();
                }
                Ok(buffer.pop())
            }
        }
    }
}

impl Drop for Names {
    fn drop(&mut self) {
        if let Self::Disk { store, set, .. } = self {
            // Scratch cleanup has no bearing on the source or durable journal;
            // dropping the shared connection also removes its entire file.
            let _ = store.with(|connection| {
                connection.execute("DELETE FROM name WHERE set_id = ?1", params![*set])
            });
        }
    }
}

fn sqlite_io(error: io::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

fn io_error(error: rusqlite::Error) -> io::Error {
    match error {
        rusqlite::Error::ToSqlConversionFailure(inner) => match inner.downcast::<io::Error>() {
            Ok(error) => *error,
            Err(inner) => io::Error::other(inner),
        },
        rusqlite::Error::SqliteFailure(ref failure, _)
            if failure.code == rusqlite::ErrorCode::DiskFull =>
        {
            io::Error::from_raw_os_error(libc::ENOSPC)
        }
        other => io::Error::other(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Sandbox;

    #[test]
    fn a_wide_directory_spills_and_returns_every_raw_name_in_byte_order() {
        let sandbox = Sandbox::new("names-wide");
        let mut expected = Vec::new();
        for slot in (0..4000).rev() {
            let mut name = format!("file-{slot:05}-").into_bytes();
            name.push(0xff);
            sandbox.file(&name, 0);
            expected.push(name);
        }
        expected.sort();
        let store = Store::default();
        let mut directory =
            Directory::from_descriptor(crate::sys::open_root(&sandbox.bytes()).unwrap()).unwrap();
        let mut names = Names::read(&mut directory, &store, &AtomicBool::new(false)).unwrap();
        assert!(matches!(names, Names::Disk { .. }));
        for expected in expected {
            assert_eq!(names.pop().unwrap(), Some(expected));
        }
        assert!(names.pop().unwrap().is_none());
        drop(names);
        assert_eq!(
            store
                .with(|connection| connection
                    .query_row("SELECT count(*) FROM name", [], |row| row.get::<_, i64>(0)))
                .unwrap(),
            0
        );
    }

    #[test]
    fn listings_on_one_stack_share_a_database_and_keep_their_names_separate() {
        let sandbox = Sandbox::new("names-isolation");
        for directory in [b"one".as_slice(), b"two"] {
            sandbox.directory(directory);
            for slot in 0..2200 {
                let mut path = directory.to_vec();
                path.extend_from_slice(format!("/file-{slot:05}").as_bytes());
                sandbox.file(&path, 0);
            }
        }
        let store = Store::default();
        let root = crate::sys::open_root(&sandbox.bytes()).unwrap();
        let mut one = Directory::from_descriptor(
            crate::sys::open_child_directory(root, b"one", false).unwrap(),
        )
        .unwrap();
        let mut two = Directory::from_descriptor(
            crate::sys::open_child_directory(root, b"two", false).unwrap(),
        )
        .unwrap();
        crate::sys::close(root);
        let mut first = Names::read(&mut one, &store, &AtomicBool::new(false)).unwrap();
        let mut second = Names::read(&mut two, &store, &AtomicBool::new(false)).unwrap();
        assert!(matches!(first, Names::Disk { .. }));
        assert!(matches!(second, Names::Disk { .. }));
        assert_eq!(first.pop().unwrap(), second.pop().unwrap());
        drop(first);
        let mut count = 1;
        while second.pop().unwrap().is_some() {
            count += 1;
        }
        assert_eq!(count, 2200);
    }

    #[test]
    fn a_cancelled_snapshot_never_returns_names_or_modifies_the_directory() {
        let sandbox = Sandbox::new("names-cancel");
        sandbox.file(b"one", 0);
        let mut directory =
            Directory::from_descriptor(crate::sys::open_root(&sandbox.bytes()).unwrap()).unwrap();
        let store = Store::default();
        let result = Names::read(&mut directory, &store, &AtomicBool::new(true));
        assert!(crate::transfer::is_cancelled(&result.err().unwrap()));
        assert!(sandbox.path().join("one").exists());
        assert!(store.0.connection.borrow().is_none());
    }
}
