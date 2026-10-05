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
const MAX_OWNER_TOTALS: u32 = 64;

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
    /// The one row at exactly this path. A subtree's first row is the path's
    /// own, but a listing sorted by size cannot be trusted to put it first: a
    /// directory whose own inode holds no blocks ties with the files below it,
    /// and the tie-break then follows the sort order down into the subtree.
    pub at: Option<i64>,
    pub parent_id: Option<i64>,
    pub name_contains: Option<String>,
    pub extension: Option<String>,
    pub min_allocated_bytes: Option<u64>,
    pub max_allocated_bytes: Option<u64>,
    pub modified_before_nanoseconds: Option<u64>,
    pub owner_id: Option<u64>,
    pub kinds: Option<Vec<EntryKind>>,
    /// At most this many direct children. A row with no count is left out:
    /// a directory nobody could open is not an empty one.
    pub max_child_entries: Option<u64>,
    /// Only symlinks whose target resolves, or only the ones that do not.
    pub broken: Option<bool>,
    /// Only directories the walk recorded but never went inside — unreadable
    /// ones and mounts it stayed out of — or only everything else.
    pub unentered: Option<bool>,
}

pub struct QueryRequest {
    pub scan_id: String,
    pub filter: EntryFilter,
    pub sort: Sort,
    pub order: Order,
    pub limit: u32,
    pub cursor: Option<String>,
    pub include_type_totals: bool,
    pub include_owner_totals: bool,
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
    /// Direct children, for a directory the walk entered. `None` everywhere
    /// else, including a directory it could not open.
    pub child_entries: Option<i64>,
    pub broken: bool,
    search_name: String,
}

pub struct OwnerTotal {
    pub owner_id: i64,
    pub entries: i64,
    pub allocated_bytes: i64,
    pub apparent_bytes: i64,
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
    pub owner_totals: Option<Vec<OwnerTotal>>,
}

/// A subtree with no more rows than this is read whole and sorted, rather than
/// found by walking a sort index and skipping everything outside it.
///
/// Reading a range costs one step per row in it, about 60 ms per million on
/// the reference machine. Walking a sort index costs one step per row it
/// passes over, which for a page of `n` rows from a subtree holding a fraction
/// `f` of the scan is about `n / f`: the smaller the subtree, the more of the
/// index lies between two of its rows. At fifty thousand rows the range is
/// read in a few milliseconds and the walk has stopped being the cheaper one
/// for any scan of a realistic size.
const SMALL_RANGE: i64 = 50_000;

/// How a page reaches its rows.
///
/// SQLite chooses well when it can see how selective a constraint is, and it
/// cannot see that here: the subtree is a primary-key range whose width is
/// bound at run time, so every subtree looks the same size to it. The helper
/// knows the width exactly, so it makes the choice itself, and the choice is
/// visible in `EXPLAIN QUERY PLAN` and tested there.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Access {
    /// One directory's children, read from an index that already holds them
    /// in the requested order, so a page costs its own rows and no more.
    Children,
    /// A primary-key range — the subtree, or the whole scan — read in full
    /// and sorted with a bounded sorter.
    Range,
    /// A sort index read in order until the page is full. Only chosen when
    /// nothing but the subtree and a common kind narrows the rows, so the
    /// walk stops after about a page's worth of matches.
    Ranked,
    /// An equality on extension or owner, which has an index SQLite can see.
    Planner,
}

fn access(request: &QueryRequest) -> Access {
    let filter = &request.filter;
    if filter.at.is_some() {
        // One primary-key lookup.
        return Access::Range;
    }
    if filter.parent_id.is_some() {
        return Access::Children;
    }
    if filter.extension.is_some() || filter.owner_id.is_some() {
        return Access::Planner;
    }
    let ranked_sort = request.sort != Sort::Name;
    // A rare kind would leave the walk passing over nearly everything. Files
    // are most of any tree. Directories are not, but across a whole scan they
    // rank first by size, because each carries its subtree's total; inside a
    // subtree that has few of them, the walk could pass over the whole index.
    let common_kind = filter.kinds.as_ref().is_none_or(|kinds| {
        kinds.contains(&EntryKind::File)
            || (kinds.contains(&EntryKind::Directory) && filter.under.is_none())
    });
    // A size bound on the column the index is ordered by is where the walk
    // starts and stops, not a filter it skips rows for.
    let size_bound = request.sort != Sort::Allocated
        && (filter.min_allocated_bytes.is_some() || filter.max_allocated_bytes.is_some());
    let only_subtree = filter.name_contains.is_none()
        && !size_bound
        && filter.modified_before_nanoseconds.is_none()
        && filter.max_child_entries.is_none()
        && filter.broken.is_none()
        && filter.unentered.is_none()
        && common_kind;
    let small = filter
        .under
        .is_some_and(|(first, last)| last.saturating_sub(first) < SMALL_RANGE);
    if ranked_sort && only_subtree && !small {
        Access::Ranked
    } else {
        Access::Range
    }
}

/// The `FROM` clause that makes SQLite take the path `access` chose.
fn source(access: Access, sort: Sort) -> String {
    let suffix = match sort {
        Sort::Allocated => "allocated",
        Sort::Apparent => "apparent",
        Sort::Modified => "modified",
        Sort::Name => "name",
    };
    match access {
        Access::Children => format!("entry INDEXED BY entry_child_{suffix}"),
        Access::Ranked => format!("entry INDEXED BY entry_{suffix}"),
        // NOT INDEXED still lets SQLite use the primary key, which is the
        // range; it only stops it walking a sort index instead.
        Access::Range => "entry NOT INDEXED".to_owned(),
        Access::Planner => "entry".to_owned(),
    }
}

/// The statement for one page and its bound values.
fn page_statement(request: &QueryRequest) -> rusqlite::Result<(String, Vec<Value>)> {
    let limit = request.limit.clamp(1, MAX_LIMIT);
    let mut clauses: Vec<String> = Vec::new();
    let mut arguments: Vec<Value> = Vec::new();
    push_filters(&request.filter, &mut clauses, &mut arguments);

    if let Some(cursor) = &request.cursor {
        let (key, id) = decode_cursor(cursor)?;
        // A row value, not `a < ? OR (a = ? AND id < ?)`: SQLite can start an
        // index range at a row value, so page fifty costs what page one does,
        // and it cannot start one at a disjunction.
        clauses.push(format!(
            "({column}, id) {comparison} (?, ?)",
            column = request.sort.column(),
            comparison = request.order.comparison(),
        ));
        arguments.push(request.sort.key_value(&key));
        arguments.push(Value::Integer(id));
    }

    // One extra row answers "is there another page?" without a second count.
    arguments.push(Value::Integer(i64::from(limit) + 1));
    let sql = format!(
        "SELECT id, parent_id, name, search_name, kind, device, inode, mount_id, link_count,
                apparent_bytes, allocated_bytes, owner_id, modified_ns, shared, child_entries,
                broken
         FROM {} WHERE {} ORDER BY {} {}, id {} LIMIT ?",
        source(access(request), request.sort),
        if clauses.is_empty() {
            "1".to_owned()
        } else {
            clauses.join(" AND ")
        },
        request.sort.column(),
        request.order.keyword(),
        request.order.keyword(),
    );
    Ok((sql, arguments))
}

/// One page, plus the cursor that continues it when more rows remain.
pub fn query(connection: &Connection, request: &QueryRequest) -> rusqlite::Result<QueryPage> {
    let limit = request.limit.clamp(1, MAX_LIMIT);
    let (sql, arguments) = page_statement(request)?;
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
        let broken: i64 = row.get(15)?;
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
            child_entries: row.get(14)?,
            broken: broken != 0,
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

    let owner_totals = if request.include_owner_totals {
        Some(owner_totals(connection, request)?)
    } else {
        None
    };

    Ok(QueryPage {
        entries,
        next_cursor,
        type_totals,
        owner_totals,
    })
}

/// Per-owner totals over regular files only.
///
/// Same rule as the per-extension totals, and for the same reason: a directory
/// row carries its whole subtree and a second hardlink to a counted inode
/// carries bytes already attributed elsewhere, so including either would
/// report more bytes than the filesystem holds.
fn owner_totals(
    connection: &Connection,
    request: &QueryRequest,
) -> rusqlite::Result<Vec<OwnerTotal>> {
    let (sql, arguments) = totals_statement(request, Totals::Owner);
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(arguments.iter()))?;
    let mut totals = Vec::new();
    while let Some(row) = rows.next()? {
        totals.push(OwnerTotal {
            owner_id: row.get(0)?,
            entries: row.get(1)?,
            allocated_bytes: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
            apparent_bytes: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
        });
    }
    Ok(totals)
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
    let (sql, arguments) = totals_statement(request, Totals::Extension);
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Totals {
    Extension,
    Owner,
}

/// The statement for one aggregate over regular files and its bound values.
///
/// Each aggregate has a covering index that starts with its group column and
/// holds every other column it reads, so a large subtree is summed from the
/// index in group order, without a sorter and without visiting the table.
/// A small subtree is cheaper to read as a range. A filter on a column the
/// index does not hold would send every row back to the table, so that reads
/// the range too.
fn totals_statement(request: &QueryRequest, totals: Totals) -> (String, Vec<Value>) {
    let mut clauses = vec!["kind = 0".to_owned(), "shared = 0".to_owned()];
    let mut arguments: Vec<Value> = Vec::new();
    let filter = EntryFilter {
        under: request.filter.under,
        at: request.filter.at,
        parent_id: request.filter.parent_id,
        name_contains: request.filter.name_contains.clone(),
        extension: request.filter.extension.clone(),
        min_allocated_bytes: request.filter.min_allocated_bytes,
        max_allocated_bytes: request.filter.max_allocated_bytes,
        modified_before_nanoseconds: request.filter.modified_before_nanoseconds,
        owner_id: request.filter.owner_id,
        kinds: None,
        // Both totals cover regular files, which never carry a child count and
        // are never broken links, so narrowing by either would empty them.
        max_child_entries: None,
        broken: None,
        unentered: None,
    };
    push_filters(&filter, &mut clauses, &mut arguments);

    let (column, index, limit) = match totals {
        Totals::Extension => ("extension", "entry_type", MAX_TYPE_TOTALS),
        Totals::Owner => ("owner_id", "entry_owner", MAX_OWNER_TOTALS),
    };
    let covered = filter.parent_id.is_none()
        && filter.at.is_none()
        && filter.name_contains.is_none()
        && filter.modified_before_nanoseconds.is_none()
        && (totals == Totals::Owner || filter.owner_id.is_none())
        && (totals == Totals::Extension || filter.extension.is_none());
    let small = filter
        .under
        .is_some_and(|(first, last)| last.saturating_sub(first) < SMALL_RANGE);
    let source = if filter.parent_id.is_some() {
        "entry INDEXED BY entry_child_allocated".to_owned()
    } else if covered && !small {
        format!("entry INDEXED BY {index}")
    } else {
        "entry NOT INDEXED".to_owned()
    };

    arguments.push(Value::Integer(i64::from(limit)));
    let sql = format!(
        "SELECT {column}, COUNT(*), SUM(allocated_bytes), SUM(apparent_bytes)
         FROM {source} WHERE {} GROUP BY {column} ORDER BY SUM(allocated_bytes) DESC LIMIT ?",
        clauses.join(" AND "),
    );
    (sql, arguments)
}

fn push_filters(filter: &EntryFilter, clauses: &mut Vec<String>, arguments: &mut Vec<Value>) {
    if let Some((first, last)) = filter.under {
        clauses.push("id >= ? AND id <= ?".to_owned());
        arguments.push(Value::Integer(first));
        arguments.push(Value::Integer(last));
    }
    if let Some(id) = filter.at {
        clauses.push("id = ?".to_owned());
        arguments.push(Value::Integer(id));
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
    if let Some(maximum) = filter.max_child_entries {
        clauses.push("(child_entries IS NOT NULL AND child_entries <= ?)".to_owned());
        arguments.push(Value::Integer(clamp(maximum)));
    }
    if let Some(broken) = filter.broken {
        clauses.push("broken = ?".to_owned());
        arguments.push(Value::Integer(i64::from(broken)));
    }
    if let Some(unentered) = filter.unentered {
        let never_entered = format!(
            "(kind = {} AND child_entries IS NULL)",
            EntryKind::Directory.code()
        );
        clauses.push(if unentered {
            never_entered
        } else {
            format!("NOT {never_entered}")
        });
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
        (
            crate::index::open_scan(&index_directory, &scan_id)
                .unwrap()
                .unwrap(),
            scan_id,
        )
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
            include_owner_totals: false,
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
    fn owner_totals_count_regular_files_only() {
        let sandbox = Sandbox::new("query-owner-totals");
        sandbox.directory(b"logs");
        sandbox.file(b"logs/one.log", 8192);
        sandbox.file(b"logs/two.log", 8192);
        sandbox.file(b"notes.txt", 4096);

        let (connection, scan_id) = scanned(&sandbox, "owners");
        let mut with_totals = request(&scan_id);
        with_totals.include_owner_totals = true;
        let page = query(&connection, &with_totals).unwrap();

        let totals = page.owner_totals.expect("owner totals were requested");
        assert_eq!(totals.len(), 1, "one user wrote every file in the sandbox");
        // Three regular files; the directory rows aggregate the same bytes and
        // must not be added to them.
        assert_eq!(totals[0].entries, 3);
        assert_eq!(totals[0].apparent_bytes, 20480);
    }

    #[test]
    fn owner_totals_are_absent_unless_they_were_asked_for() {
        let sandbox = Sandbox::new("query-owner-absent");
        sandbox.file(b"notes.txt", 4096);

        let (connection, scan_id) = scanned(&sandbox, "owners-absent");
        let page = query(&connection, &request(&scan_id)).unwrap();

        assert!(page.owner_totals.is_none());
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
    #[test]
    fn an_empty_directory_and_a_dangling_link_are_recognisable_in_the_index() {
        let sandbox = Sandbox::new("query-empty-broken");
        sandbox.directory(b"empty");
        sandbox.directory(b"full");
        sandbox.file(b"full/a", 16);
        sandbox.symlink(b"nowhere", b"dangling");
        sandbox.symlink(b"full/a", b"live");

        let (connection, scan_id) = scanned(&sandbox, "empty-broken");
        let page = query(&connection, &request(&scan_id)).unwrap();
        let row = |name: &str| {
            page.entries
                .iter()
                .find(|entry| entry.path.ends_with(name.as_bytes()))
                .unwrap_or_else(|| panic!("{name} is missing from the index"))
        };

        assert_eq!(row("/empty").child_entries, Some(0));
        assert_eq!(row("/full").child_entries, Some(1));
        assert_eq!(row("/full/a").child_entries, None);
        assert!(row("/dangling").broken, "a link to nothing reads as broken");
        assert!(!row("/live").broken, "a link to a real file is not broken");
    }

    #[test]
    fn a_directory_the_walk_could_not_enter_is_found_by_asking_for_unentered_ones() {
        if unsafe { libc::geteuid() } == 0 {
            // Root reads a mode-000 directory, so there is nothing to refuse.
            return;
        }
        let sandbox = Sandbox::new("query-unentered");
        sandbox.directory(b"open");
        sandbox.file(b"open/a", 16);
        sandbox.directory(b"locked");
        sandbox.file(b"locked/secret", 16);
        sandbox.chmod(b"locked", 0o000);

        let (connection, scan_id) = scanned(&sandbox, "unentered");
        sandbox.chmod(b"locked", 0o700);
        let mut unentered = request(&scan_id);
        unentered.filter.unentered = Some(true);
        let page = query(&connection, &unentered).unwrap();

        assert_eq!(
            page.entries.len(),
            1,
            "only the directory nobody could open"
        );
        assert!(page.entries[0].path.ends_with(b"/locked"));

        let mut entered = request(&scan_id);
        entered.filter.unentered = Some(false);
        let rest = query(&connection, &entered).unwrap();
        assert!(
            rest.entries
                .iter()
                .all(|entry| !entry.path.ends_with(b"/locked"))
        );
        assert!(
            rest.entries
                .iter()
                .any(|entry| entry.path.ends_with(b"/open"))
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
            index::open_scan(&index_directory, &scan_id)
                .unwrap()
                .unwrap(),
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
        let range = index::subtree_range(&connection, &under)
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
                include_owner_totals: false,
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
        let (connection, _scan_id, _index) = scan(&sandbox, "missing");

        let mut absent = sandbox.bytes();
        absent.extend_from_slice(b"/never-created");
        assert_eq!(index::subtree_range(&connection, &absent).unwrap(), None);

        // A path above the scan root is not in the scan either.
        assert_eq!(index::subtree_range(&connection, b"/").unwrap(), None);
    }

    #[test]
    fn a_file_resolves_to_itself_alone() {
        let sandbox = Sandbox::new("query-subtree-file");
        sandbox.file(b"only.bin", 4096);
        sandbox.file(b"other.bin", 4096);
        let (connection, scan_id, _index) = scan(&sandbox, "file");

        let mut target = sandbox.bytes();
        target.extend_from_slice(b"/only.bin");
        let range = index::subtree_range(&connection, &target).unwrap().unwrap();

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
                include_owner_totals: false,
            },
        )
        .unwrap();
        assert_eq!(page.entries.len(), 1);
        assert!(page.entries[0].path.ends_with(b"only.bin"));
    }

    /// Give a path a modification time, without following a final symlink.
    fn set_modified(path: &std::path::Path, seconds: i64) {
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        let times = [
            libc::timespec {
                tv_sec: seconds,
                tv_nsec: 0,
            },
            libc::timespec {
                tv_sec: seconds,
                tv_nsec: 0,
            },
        ];
        let result = unsafe {
            libc::utimensat(
                libc::AT_FDCWD,
                name.as_ptr(),
                times.as_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        assert_eq!(result, 0, "utimensat failed in the sandbox");
    }

    fn sorted_page(scan_id: &str, filter: EntryFilter, sort: Sort) -> QueryRequest {
        QueryRequest {
            scan_id: scan_id.to_owned(),
            filter,
            sort,
            order: Order::Descending,
            limit: 100,
            cursor: None,
            include_type_totals: false,
            include_owner_totals: false,
        }
    }

    #[test]
    fn the_row_at_a_path_is_that_path_even_when_a_descendant_ties_with_it() {
        let sandbox = Sandbox::new("query-at-path");
        sandbox.directory(b"tied");
        sandbox.file(b"tied/only", 0);
        sandbox.file(b"sibling", 0);
        // The directory and the file below it share a modification time, as a
        // btrfs directory and an empty file below it share zero blocks.
        set_modified(&sandbox.path().join("tied/only"), 1_700_000_000);
        set_modified(&sandbox.path().join("tied"), 1_700_000_000);
        let (connection, scan_id, _index) = scan(&sandbox, "at-path");

        let mut tied = sandbox.bytes();
        tied.extend_from_slice(b"/tied");
        let range = index::subtree_range(&connection, &tied)
            .unwrap()
            .expect("the path is in this scan");

        // Sorted, the subtree's first row is not the directory's own: the tie
        // is broken by row ID in the same descending order, and the file was
        // written after its directory.
        let ranked = query(
            &connection,
            &sorted_page(
                &scan_id,
                EntryFilter {
                    under: Some(range),
                    ..EntryFilter::default()
                },
                Sort::Modified,
            ),
        )
        .unwrap();
        assert!(ranked.entries[0].path.ends_with(b"/tied/only"));

        for sort in [Sort::Allocated, Sort::Apparent, Sort::Modified, Sort::Name] {
            let page = query(
                &connection,
                &sorted_page(
                    &scan_id,
                    EntryFilter {
                        at: Some(range.0),
                        ..EntryFilter::default()
                    },
                    sort,
                ),
            )
            .unwrap();
            assert_eq!(page.entries.len(), 1, "exactly the one row at the path");
            assert_eq!(page.entries[0].path, tied);
            assert_eq!(page.entries[0].kind, EntryKind::Directory);
            assert!(page.next_cursor.is_none());
        }

        // Its children are then one parent ID away.
        let children = query(
            &connection,
            &sorted_page(
                &scan_id,
                EntryFilter {
                    parent_id: Some(range.0),
                    ..EntryFilter::default()
                },
                Sort::Name,
            ),
        )
        .unwrap();
        assert_eq!(children.entries.len(), 1);
        assert!(children.entries[0].path.ends_with(b"/tied/only"));
    }
}

#[cfg(test)]
mod plan_tests {
    use super::*;
    use crate::index::{self, IndexWriter};
    use crate::testing::Sandbox;
    use crate::walk::{Accounting, ScanOptions, walk};
    use std::os::unix::ffi::OsStrExt;
    use std::sync::atomic::AtomicBool;

    fn scanned(sandbox: &Sandbox) -> (Connection, String) {
        let index_directory = sandbox.directory(b".disktop-index");
        let scan_id = "scan-plan-tests".to_owned();
        let roots = vec![sandbox.bytes()];
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
        let connection = index::open_scan(&index_directory, &scan_id)
            .unwrap()
            .unwrap();
        (connection, scan_id)
    }

    fn plan_of(connection: &Connection, sql: &str, arguments: &[Value]) -> String {
        let mut statement = connection
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .expect("the statement prepares");
        let mut rows = statement
            .query(params_from_iter(arguments.iter()))
            .expect("the plan runs");
        let mut steps = Vec::new();
        while let Some(row) = rows.next().unwrap() {
            steps.push(row.get::<_, String>(3).unwrap());
        }
        steps.join(" | ")
    }

    fn page_plan(connection: &Connection, request: &QueryRequest) -> String {
        let (sql, arguments) = page_statement(request).expect("a statement");
        plan_of(connection, &sql, &arguments)
    }

    fn request(scan_id: &str, filter: EntryFilter, sort: Sort) -> QueryRequest {
        QueryRequest {
            scan_id: scan_id.to_owned(),
            filter,
            sort,
            order: Order::Descending,
            limit: 200,
            cursor: None,
            include_type_totals: false,
            include_owner_totals: false,
        }
    }

    #[test]
    fn browsing_a_directory_reads_one_page_of_an_index_in_every_order() {
        let sandbox = Sandbox::new("query-plan-children");
        sandbox.file(b"a.txt", 10);
        let (connection, scan_id) = scanned(&sandbox);

        for (sort, index) in [
            (Sort::Allocated, "entry_child_allocated"),
            (Sort::Apparent, "entry_child_apparent"),
            (Sort::Modified, "entry_child_modified"),
            (Sort::Name, "entry_child_name"),
        ] {
            for order in [Order::Descending, Order::Ascending] {
                let mut page = request(
                    &scan_id,
                    EntryFilter {
                        parent_id: Some(1),
                        ..EntryFilter::default()
                    },
                    sort,
                );
                page.order = order;
                let plan = page_plan(&connection, &page);
                assert!(plan.contains(index), "{plan}");
                assert!(!plan.contains("TEMP B-TREE"), "a page was sorted: {plan}");

                // A later page starts the index range at the cursor rather
                // than reading past everything before it.
                let key = if sort == Sort::Name { "m" } else { "4096" };
                page.cursor = Some(encode_cursor(key, 7));
                let plan = page_plan(&connection, &page);
                assert!(plan.contains(index), "{plan}");
                assert!(!plan.contains("TEMP B-TREE"), "{plan}");
                assert!(
                    plan.contains(&format!("(parent_id=? AND {}", sort.column())),
                    "the cursor did not bound the index range: {plan}"
                );
            }
        }
    }

    #[test]
    fn ranking_a_large_subtree_walks_a_sort_index_and_a_small_one_reads_its_range() {
        let sandbox = Sandbox::new("query-plan-ranked");
        sandbox.file(b"a.txt", 10);
        let (connection, scan_id) = scanned(&sandbox);

        let large = request(
            &scan_id,
            EntryFilter {
                under: Some((1, 1 + SMALL_RANGE * 4)),
                ..EntryFilter::default()
            },
            Sort::Allocated,
        );
        let plan = page_plan(&connection, &large);
        assert!(plan.contains("entry_allocated"), "{plan}");
        assert!(!plan.contains("TEMP B-TREE"), "{plan}");

        let whole = request(&scan_id, EntryFilter::default(), Sort::Modified);
        let plan = page_plan(&connection, &whole);
        assert!(plan.contains("entry_modified"), "{plan}");
        assert!(!plan.contains("TEMP B-TREE"), "{plan}");

        let small = request(
            &scan_id,
            EntryFilter {
                under: Some((10, 20)),
                ..EntryFilter::default()
            },
            Sort::Allocated,
        );
        let plan = page_plan(&connection, &small);
        assert!(plan.contains("INTEGER PRIMARY KEY"), "{plan}");

        // A size bound on the ranked column is where the walk starts.
        let sized = request(
            &scan_id,
            EntryFilter {
                under: Some((1, 1 + SMALL_RANGE * 4)),
                min_allocated_bytes: Some(1 << 30),
                kinds: Some(vec![EntryKind::File]),
                ..EntryFilter::default()
            },
            Sort::Allocated,
        );
        let plan = page_plan(&connection, &sized);
        assert!(
            plan.contains("entry_allocated (allocated_bytes>?"),
            "{plan}"
        );

        let exact = request(
            &scan_id,
            EntryFilter {
                at: Some(5),
                ..EntryFilter::default()
            },
            Sort::Allocated,
        );
        let plan = page_plan(&connection, &exact);
        assert!(plan.contains("INTEGER PRIMARY KEY (rowid=?)"), "{plan}");
    }

    #[test]
    fn totals_over_a_large_subtree_come_from_a_covering_index() {
        let sandbox = Sandbox::new("query-plan-totals");
        sandbox.file(b"a.txt", 10);
        let (connection, scan_id) = scanned(&sandbox);

        let large = request(
            &scan_id,
            EntryFilter {
                under: Some((1, 1 + SMALL_RANGE * 4)),
                ..EntryFilter::default()
            },
            Sort::Allocated,
        );
        for (totals, index) in [
            (Totals::Extension, "COVERING INDEX entry_type"),
            (Totals::Owner, "COVERING INDEX entry_owner"),
        ] {
            let (sql, arguments) = totals_statement(&large, totals);
            let plan = plan_of(&connection, &sql, &arguments);
            assert!(plan.contains(index), "{plan}");
            assert!(
                !plan.contains("TEMP B-TREE FOR GROUP BY"),
                "the aggregate sorted its rows: {plan}"
            );
        }
    }
}
