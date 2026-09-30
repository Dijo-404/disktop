//! Paginated, filtered reads of one scan's index.
//!
//! Pages are keyset-based: the cursor carries the last row's sort value and ID
//! rather than an offset, so a large listing costs the same at page 900 as at
//! page 1 and cannot skip or repeat a row when the index is pruned between
//! pages. Node asks for a page; it never receives the tree.

use crate::index::{self, PathResolver};
use crate::sys::EntryKind;
use rusqlite::types::Value;
use rusqlite::{Connection, params_from_iter};

/// The schema caps a page at a thousand rows; so does the helper, whatever a
/// request asks for.
pub const MAX_LIMIT: u32 = 1000;
const MAX_TYPE_TOTALS: u32 = 64;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Sort {
    Allocated,
    Apparent,
    Modified,
    Name,
}

impl Sort {
    pub fn parse(value: &str) -> Option<Sort> {
        match value {
            "allocated" => Some(Sort::Allocated),
            "apparent" => Some(Sort::Apparent),
            "modified" => Some(Sort::Modified),
            "name" => Some(Sort::Name),
            _ => None,
        }
    }

    fn column(self) -> &'static str {
        match self {
            Sort::Allocated => "allocated_bytes",
            Sort::Apparent => "apparent_bytes",
            Sort::Modified => "modified_ns",
            Sort::Name => "search_name",
        }
    }

    fn key_of(self, row: &IndexRow) -> String {
        match self {
            Sort::Allocated => row.allocated_bytes.to_string(),
            Sort::Apparent => row.apparent_bytes.to_string(),
            Sort::Modified => row.modified_nanoseconds.to_string(),
            Sort::Name => row.search_name.clone(),
        }
    }

    fn key_value(self, key: &str) -> Value {
        match self {
            Sort::Name => Value::Text(key.to_owned()),
            _ => Value::Integer(key.parse::<i64>().unwrap_or(0)),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Order {
    Ascending,
    Descending,
}

impl Order {
    pub fn parse(value: &str) -> Option<Order> {
        match value {
            "ascending" => Some(Order::Ascending),
            "descending" => Some(Order::Descending),
            _ => None,
        }
    }

    fn keyword(self) -> &'static str {
        match self {
            Order::Ascending => "ASC",
            Order::Descending => "DESC",
        }
    }

    fn comparison(self) -> &'static str {
        match self {
            Order::Ascending => ">",
            Order::Descending => "<",
        }
    }
}

#[derive(Default)]
pub struct EntryFilter {
    /// Inclusive primary-key range covering one path and its whole subtree.
    pub under: Option<(i64, i64)>,
    pub parent_id: Option<i64>,
    pub name_contains: Option<String>,
    pub extension: Option<String>,
    pub min_allocated_bytes: Option<u64>,
    pub max_allocated_bytes: Option<u64>,
    pub modified_before_nanoseconds: Option<u64>,
    pub owner_id: Option<u64>,
    pub kinds: Option<Vec<EntryKind>>,
}

pub struct QueryRequest {
    pub scan_id: String,
    pub filter: EntryFilter,
    pub sort: Sort,
    pub order: Order,
    pub limit: u32,
    pub cursor: Option<String>,
    pub include_type_totals: bool,
}

pub struct IndexRow {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub path: Vec<u8>,
    pub kind: EntryKind,
    pub device: String,
    pub inode: String,
    pub mount_id: String,
    pub link_count: i64,
    pub apparent_bytes: i64,
    pub allocated_bytes: i64,
    pub owner_id: i64,
    pub modified_nanoseconds: i64,
    pub shared: bool,
    search_name: String,
}

pub struct TypeTotal {
    pub extension: String,
    pub entries: i64,
    pub allocated_bytes: i64,
    pub apparent_bytes: i64,
}

pub struct QueryPage {
    pub entries: Vec<IndexRow>,
    pub next_cursor: Option<String>,
    pub type_totals: Option<Vec<TypeTotal>>,
}

/// One page, plus the cursor that continues it when more rows remain.
pub fn query(connection: &Connection, request: &QueryRequest) -> rusqlite::Result<QueryPage> {
    let limit = request.limit.clamp(1, MAX_LIMIT);
    let mut clauses = vec!["scan_id = ?".to_owned()];
    let mut arguments: Vec<Value> = vec![Value::Text(request.scan_id.clone())];
    push_filters(&request.filter, &mut clauses, &mut arguments);

    if let Some(cursor) = &request.cursor {
        let (key, id) = decode_cursor(cursor)?;
        clauses.push(format!(
            "({column} {comparison} ? OR ({column} = ? AND id {comparison} ?))",
            column = request.sort.column(),
            comparison = request.order.comparison(),
        ));
        arguments.push(request.sort.key_value(&key));
        arguments.push(request.sort.key_value(&key));
        arguments.push(Value::Integer(id));
    }

    // One extra row answers "is there another page?" without a second count.
    arguments.push(Value::Integer(i64::from(limit) + 1));
    let sql = format!(
        "SELECT id, parent_id, name, search_name, kind, device, inode, mount_id, link_count,
                apparent_bytes, allocated_bytes, owner_id, modified_ns, shared
         FROM entry WHERE {} ORDER BY {} {}, id {} LIMIT ?",
        clauses.join(" AND "),
        request.sort.column(),
        request.order.keyword(),
        request.order.keyword(),
    );

    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(arguments.iter()))?;
    let mut resolver = PathResolver::new(connection);
    let mut entries = Vec::new();
    let mut overflow = false;

    while let Some(row) = rows.next()? {
        if entries.len() as u32 == limit {
            overflow = true;
            break;
        }
        let parent_id: Option<i64> = row.get(1)?;
        let name: Vec<u8> = row.get(2)?;
        let path = resolver.path(parent_id, &name)?;
        let shared: i64 = row.get(13)?;
        entries.push(IndexRow {
            id: row.get(0)?,
            parent_id,
            path,
            search_name: row.get(3)?,
            kind: index::kind_of(row.get(4)?),
            device: row.get(5)?,
            inode: row.get(6)?,
            mount_id: row.get(7)?,
            link_count: row.get(8)?,
            apparent_bytes: row.get(9)?,
            allocated_bytes: row.get(10)?,
            owner_id: row.get(11)?,
            modified_nanoseconds: row.get(12)?,
            shared: shared != 0,
        });
    }

    let next_cursor = match (overflow, entries.last()) {
        (true, Some(last)) => Some(encode_cursor(&request.sort.key_of(last), last.id)),
        _ => None,
    };

    let type_totals = if request.include_type_totals {
        Some(type_totals(connection, request)?)
    } else {
        None
    };

    Ok(QueryPage {
        entries,
        next_cursor,
        type_totals,
    })
}

/// Per-extension totals over regular files only.
///
/// Directory rows carry their whole subtree, and a second hardlink to a
/// counted inode carries bytes already attributed elsewhere; including either
/// would report more bytes than the filesystem holds.
fn type_totals(
    connection: &Connection,
    request: &QueryRequest,
) -> rusqlite::Result<Vec<TypeTotal>> {
    let mut clauses = vec![
        "scan_id = ?".to_owned(),
        "kind = 0".to_owned(),
        "shared = 0".to_owned(),
    ];
    let mut arguments: Vec<Value> = vec![Value::Text(request.scan_id.clone())];
    let mut filter = EntryFilter {
        under: request.filter.under,
        parent_id: request.filter.parent_id,
        name_contains: request.filter.name_contains.clone(),
        extension: request.filter.extension.clone(),
        min_allocated_bytes: request.filter.min_allocated_bytes,
        max_allocated_bytes: request.filter.max_allocated_bytes,
        modified_before_nanoseconds: request.filter.modified_before_nanoseconds,
        owner_id: request.filter.owner_id,
        kinds: None,
    };
    filter.kinds = None;
    push_filters(&filter, &mut clauses, &mut arguments);
    arguments.push(Value::Integer(i64::from(MAX_TYPE_TOTALS)));

    let sql = format!(
        "SELECT extension, COUNT(*), SUM(allocated_bytes), SUM(apparent_bytes)
         FROM entry WHERE {} GROUP BY extension ORDER BY SUM(allocated_bytes) DESC LIMIT ?",
        clauses.join(" AND "),
    );
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(arguments.iter()))?;
    let mut totals = Vec::new();
    while let Some(row) = rows.next()? {
        totals.push(TypeTotal {
            extension: row.get(0)?,
            entries: row.get(1)?,
            allocated_bytes: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
            apparent_bytes: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
        });
    }
    Ok(totals)
}

fn push_filters(filter: &EntryFilter, clauses: &mut Vec<String>, arguments: &mut Vec<Value>) {
    if let Some((first, last)) = filter.under {
        clauses.push("id >= ? AND id <= ?".to_owned());
        arguments.push(Value::Integer(first));
        arguments.push(Value::Integer(last));
    }
    if let Some(parent) = filter.parent_id {
        clauses.push("parent_id = ?".to_owned());
        arguments.push(Value::Integer(parent));
    }
    if let Some(text) = &filter.name_contains {
        // ESCAPE keeps a name containing % or _ from matching everything.
        clauses.push("search_name LIKE ? ESCAPE '\\'".to_owned());
        arguments.push(Value::Text(format!(
            "%{}%",
            escape_like(&text.to_lowercase())
        )));
    }
    if let Some(extension) = &filter.extension {
        clauses.push("extension = ?".to_owned());
        arguments.push(Value::Text(extension.to_lowercase()));
    }
    if let Some(minimum) = filter.min_allocated_bytes {
        clauses.push("allocated_bytes >= ?".to_owned());
        arguments.push(Value::Integer(clamp(minimum)));
    }
    if let Some(maximum) = filter.max_allocated_bytes {
        clauses.push("allocated_bytes <= ?".to_owned());
        arguments.push(Value::Integer(clamp(maximum)));
    }
    if let Some(before) = filter.modified_before_nanoseconds {
        clauses.push("modified_ns < ?".to_owned());
        arguments.push(Value::Integer(clamp(before)));
    }
    if let Some(owner) = filter.owner_id {
        clauses.push("owner_id = ?".to_owned());
        arguments.push(Value::Integer(clamp(owner)));
    }
    if let Some(kinds) = &filter.kinds {
        let placeholders = vec!["?"; kinds.len()].join(", ");
        clauses.push(format!("kind IN ({placeholders})"));
        for kind in kinds {
            arguments.push(Value::Integer(kind.code()));
        }
    }
}

fn escape_like(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// The cursor is hex so it survives the contract's restricted alphabet, and
/// opaque so a caller cannot craft one that reaches another scan's rows: the
/// scan ID is always applied from the request, never from the cursor.
fn encode_cursor(key: &str, id: i64) -> String {
    let mut payload = key.as_bytes().to_vec();
    payload.push(0);
    payload.extend_from_slice(id.to_string().as_bytes());
    payload.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_cursor(cursor: &str) -> rusqlite::Result<(String, i64)> {
    let invalid = || {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "The page cursor is not one this index issued.",
        )))
    };
    if cursor.is_empty() || !cursor.len().is_multiple_of(2) {
        return Err(invalid());
    }
    let mut payload = Vec::with_capacity(cursor.len() / 2);
    let bytes = cursor.as_bytes();
    for pair in bytes.chunks(2) {
        let text = std::str::from_utf8(pair).map_err(|_| invalid())?;
        payload.push(u8::from_str_radix(text, 16).map_err(|_| invalid())?);
    }
    let separator = payload
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(invalid)?;
    let key = String::from_utf8(payload[..separator].to_vec()).map_err(|_| invalid())?;
    let id = std::str::from_utf8(&payload[separator + 1..])
        .map_err(|_| invalid())?
        .parse::<i64>()
        .map_err(|_| invalid())?;
    Ok((key, id))
}

fn clamp(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::IndexWriter;
    use crate::testing::Sandbox;
    use crate::walk::{Accounting, ScanOptions, walk};
    use std::os::unix::ffi::OsStrExt;
    use std::sync::atomic::AtomicBool;

    fn scanned(sandbox: &Sandbox, label: &str) -> (Connection, String) {
        let index_directory = sandbox.directory(b".disktop-index");
        let scan_id = format!("scan-test-{label}");
        let roots = vec![sandbox.path().as_os_str().as_bytes().to_vec()];
        let limits = crate::index::IndexLimits::default();
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
        (crate::index::open(&index_directory).unwrap(), scan_id)
    }

    fn request(scan_id: &str) -> QueryRequest {
        QueryRequest {
            scan_id: scan_id.to_owned(),
            filter: EntryFilter::default(),
            sort: Sort::Allocated,
            order: Order::Descending,
            limit: 100,
            cursor: None,
            include_type_totals: false,
        }
    }

    #[test]
    fn rows_come_back_with_rebuilt_byte_paths() {
        let sandbox = Sandbox::new("query-paths");
        sandbox.directory(b"nested");
        let name = [b'o', b'd', b'd', 0xff, b'.', b'l', b'o', b'g'];
        let mut relative = b"nested/".to_vec();
        relative.extend_from_slice(&name);
        sandbox.file(&relative, 4096);

        let (connection, scan_id) = scanned(&sandbox, "paths");
        let page = query(&connection, &request(&scan_id)).unwrap();

        let mut expected = sandbox.path().as_os_str().as_bytes().to_vec();
        expected.extend_from_slice(b"/nested/");
        expected.extend_from_slice(&name);
        assert!(page.entries.iter().any(|entry| entry.path == expected));
    }

    #[test]
    fn a_page_stops_at_the_limit_and_the_cursor_continues_it_without_repeats() {
        let sandbox = Sandbox::new("query-page");
        for index in 0..10 {
            sandbox.file(format!("file-{index}.bin").as_bytes(), 1024 * (index + 1));
        }

        let (connection, scan_id) = scanned(&sandbox, "page");
        let mut seen = Vec::new();
        let mut cursor = None;
        loop {
            let mut next = request(&scan_id);
            next.limit = 3;
            next.cursor = cursor.clone();
            next.filter.kinds = Some(vec![EntryKind::File]);
            let page = query(&connection, &next).unwrap();
            assert!(page.entries.len() <= 3);
            for entry in &page.entries {
                assert!(!seen.contains(&entry.id), "a row was returned twice");
                seen.push(entry.id);
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(seen.len(), 10);
    }

    #[test]
    fn filters_narrow_by_extension_and_size() {
        let sandbox = Sandbox::new("query-filter");
        sandbox.file(b"small.log", 16);
        sandbox.file(b"large.log", 200_000);
        sandbox.file(b"large.txt", 200_000);

        let (connection, scan_id) = scanned(&sandbox, "filter");
        let mut narrowed = request(&scan_id);
        narrowed.filter.extension = Some("log".to_owned());
        narrowed.filter.min_allocated_bytes = Some(100_000);
        let page = query(&connection, &narrowed).unwrap();

        assert_eq!(page.entries.len(), 1);
        assert!(page.entries[0].path.ends_with(b"large.log"));
    }

    #[test]
    fn type_totals_count_regular_files_only() {
        let sandbox = Sandbox::new("query-totals");
        sandbox.directory(b"logs");
        sandbox.file(b"logs/one.log", 8192);
        sandbox.file(b"logs/two.log", 8192);
        sandbox.file(b"notes.txt", 4096);

        let (connection, scan_id) = scanned(&sandbox, "totals");
        let mut with_totals = request(&scan_id);
        with_totals.include_type_totals = true;
        let page = query(&connection, &with_totals).unwrap();

        let totals = page.type_totals.expect("totals were requested");
        let logs = totals
            .iter()
            .find(|total| total.extension == "log")
            .expect("the log extension is present");
        assert_eq!(logs.entries, 2);
        // The `logs` directory row aggregates the same bytes and must not be
        // added to them.
        assert_eq!(logs.apparent_bytes, 16384);
    }

    #[test]
    fn a_name_filter_treats_wildcards_as_literal_characters() {
        let sandbox = Sandbox::new("query-like");
        sandbox.file(b"100%-done.txt", 32);
        sandbox.file(b"unrelated.txt", 32);

        let (connection, scan_id) = scanned(&sandbox, "like");
        let mut narrowed = request(&scan_id);
        narrowed.filter.name_contains = Some("100%-".to_owned());
        let page = query(&connection, &narrowed).unwrap();

        assert_eq!(page.entries.len(), 1);
    }

    #[test]
    fn a_malformed_cursor_is_refused_rather_than_ignored() {
        assert!(decode_cursor("not-hex").is_err());
        assert!(decode_cursor("00").is_err());
        assert_eq!(
            decode_cursor(&encode_cursor("4096", 12)).unwrap(),
            ("4096".to_owned(), 12)
        );
    }
}

#[cfg(test)]
mod subtree_tests {
    use super::*;
    use crate::index::{self, IndexWriter};
    use crate::testing::Sandbox;
    use crate::walk::{Accounting, ScanOptions, walk};
    use std::os::unix::ffi::OsStrExt;
    use std::sync::atomic::AtomicBool;

    fn scan(sandbox: &Sandbox, label: &str) -> (Connection, String, std::path::PathBuf) {
        let index_directory = sandbox.directory(b".disktop-index");
        let scan_id = format!("scan-subtree-{label}");
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
            index::open(&index_directory).unwrap(),
            scan_id,
            index_directory,
        )
    }

    #[test]
    fn a_subtree_filter_returns_only_what_lives_under_that_path() {
        let sandbox = Sandbox::new("query-subtree");
        sandbox.file(b"outside.bin", 200_000);
        sandbox.directory(b"inside");
        sandbox.file(b"inside/small.bin", 1024);
        sandbox.directory(b"inside/deeper");
        sandbox.file(b"inside/deeper/leaf.bin", 2048);

        let (connection, scan_id, _index) = scan(&sandbox, "filter");
        let mut under = sandbox.bytes();
        under.extend_from_slice(b"/inside");
        let range = index::subtree_range(&connection, &scan_id, &under)
            .unwrap()
            .expect("the path is in this scan");

        let page = query(
            &connection,
            &QueryRequest {
                scan_id: scan_id.clone(),
                filter: EntryFilter {
                    under: Some(range),
                    ..EntryFilter::default()
                },
                sort: Sort::Allocated,
                order: Order::Descending,
                limit: 100,
                cursor: None,
                include_type_totals: false,
            },
        )
        .unwrap();

        let names: Vec<String> = page
            .entries
            .iter()
            .map(|entry| String::from_utf8_lossy(&entry.path).into_owned())
            .collect();
        assert!(names.iter().any(|name| name.ends_with("/inside")));
        assert!(names.iter().any(|name| name.ends_with("/inside/small.bin")));
        assert!(
            names
                .iter()
                .any(|name| name.ends_with("/inside/deeper/leaf.bin"))
        );
        // The largest file in the tree sits outside the requested subtree and
        // must not be listed as though it were inside it.
        assert!(
            !names.iter().any(|name| name.ends_with("/outside.bin")),
            "a sibling outside the subtree was returned: {names:?}"
        );
    }

    #[test]
    fn a_path_that_is_not_in_the_scan_resolves_to_nothing_rather_than_everything() {
        let sandbox = Sandbox::new("query-subtree-missing");
        sandbox.file(b"a.bin", 10);
        let (connection, scan_id, _index) = scan(&sandbox, "missing");

        let mut absent = sandbox.bytes();
        absent.extend_from_slice(b"/never-created");
        assert_eq!(
            index::subtree_range(&connection, &scan_id, &absent).unwrap(),
            None
        );

        // A path above the scan root is not in the scan either.
        assert_eq!(
            index::subtree_range(&connection, &scan_id, b"/").unwrap(),
            None
        );
    }

    #[test]
    fn a_file_resolves_to_itself_alone() {
        let sandbox = Sandbox::new("query-subtree-file");
        sandbox.file(b"only.bin", 4096);
        sandbox.file(b"other.bin", 4096);
        let (connection, scan_id, _index) = scan(&sandbox, "file");

        let mut target = sandbox.bytes();
        target.extend_from_slice(b"/only.bin");
        let range = index::subtree_range(&connection, &scan_id, &target)
            .unwrap()
            .unwrap();

        let page = query(
            &connection,
            &QueryRequest {
                scan_id,
                filter: EntryFilter {
                    under: Some(range),
                    ..EntryFilter::default()
                },
                sort: Sort::Allocated,
                order: Order::Descending,
                limit: 100,
                cursor: None,
                include_type_totals: false,
            },
        )
        .unwrap();
        assert_eq!(page.entries.len(), 1);
        assert!(page.entries[0].path.ends_with(b"only.bin"));
    }
}
