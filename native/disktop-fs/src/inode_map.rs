//! Inode tracking that does not grow with a filesystem's hardlink count.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use std::collections::HashMap;
use std::io;

const MEMORY_BYTES: usize = 1024 * 1024;

pub struct Map<V> {
    memory: HashMap<(u64, u64), V>,
    bytes: usize,
    disk: Option<Connection>,
}

impl<V: Clone + Serialize + DeserializeOwned> Map<V> {
    pub fn new() -> Self {
        Self {
            memory: HashMap::new(),
            bytes: 0,
            disk: None,
        }
    }

    pub fn get(&self, key: &(u64, u64)) -> io::Result<Option<V>> {
        let Some(disk) = &self.disk else {
            return Ok(self.memory.get(key).cloned());
        };
        let bytes: Option<Vec<u8>> = disk
            .query_row(
                "SELECT value FROM inode WHERE identity = ?1",
                params![encoded(*key)],
                |row| row.get(0),
            )
            .optional()
            .map_err(io::Error::other)?;
        bytes
            .map(|bytes| serde_json::from_slice(&bytes).map_err(io::Error::other))
            .transpose()
    }

    /// Insert once, returning false when this inode was already tracked.
    pub fn insert(&mut self, key: (u64, u64), value: V) -> io::Result<bool> {
        if self.disk.is_none() && self.memory.contains_key(&key) {
            return Ok(false);
        }
        let payload = serde_json::to_vec(&value).map_err(io::Error::other)?;
        if self.disk.is_none() && self.bytes.saturating_add(payload.len() + 64) > MEMORY_BYTES {
            let disk = Connection::open("").map_err(io::Error::other)?;
            disk.execute_batch(
                "PRAGMA cache_size = -2048; PRAGMA temp_store = FILE;
                PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;
                CREATE TABLE inode (identity BLOB PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID;",
            )
            .map_err(io::Error::other)?;
            {
                let mut insert = disk
                    .prepare("INSERT INTO inode VALUES (?1, ?2)")
                    .map_err(io::Error::other)?;
                for (key, value) in &self.memory {
                    let value = serde_json::to_vec(value).map_err(io::Error::other)?;
                    insert
                        .execute(params![encoded(*key), value])
                        .map_err(io::Error::other)?;
                }
            }
            self.memory.clear();
            self.memory.shrink_to_fit();
            self.bytes = 0;
            self.disk = Some(disk);
        }
        if let Some(disk) = &self.disk {
            return disk
                .execute(
                    "INSERT OR IGNORE INTO inode VALUES (?1, ?2)",
                    params![encoded(key), payload],
                )
                .map(|changed| changed == 1)
                .map_err(io::Error::other);
        }
        self.bytes += payload.len() + 64;
        self.memory.insert(key, value);
        Ok(true)
    }
}

fn encoded((device, inode): (u64, u64)) -> [u8; 16] {
    let mut encoded = [0u8; 16];
    encoded[..8].copy_from_slice(&device.to_le_bytes());
    encoded[8..].copy_from_slice(&inode.to_le_bytes());
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn many_distinct_hardlinks_spill_without_losing_unsigned_inode_identity() {
        let mut map = Map::new();
        for inode in 0..20_000u64 {
            assert!(map.insert((u64::MAX, inode), inode.to_string()).unwrap());
        }
        assert!(map.disk.is_some());
        assert!(map.memory.is_empty());
        for inode in [0, 15_000, 19_999] {
            assert_eq!(
                map.get(&(u64::MAX, inode)).unwrap(),
                Some(inode.to_string())
            );
            assert!(
                !map.insert((u64::MAX, inode), "replacement".to_owned())
                    .unwrap()
            );
            assert_eq!(
                map.get(&(u64::MAX, inode)).unwrap(),
                Some(inode.to_string())
            );
        }
        assert_eq!(map.get(&(0, 19_999)).unwrap(), None);
    }
}
