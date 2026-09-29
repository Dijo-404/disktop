//! Versioned JSON-lines boundary for the filesystem helper.
//!
//! Reads are implemented: `hello`, `probe`, `scan`, `query-index`, and
//! `cancel`. Every operation that changes a user file is still refused
//! explicitly, because the reviewed plan, guard, and journal it would have to
//! go through do not exist yet.
//!
//! A scan runs on its own thread so that `cancel` can be read and acted on
//! while it is still walking. Every event goes out through one lock, so two
//! requests can never interleave halfway through a line, and each request's
//! event IDs are monotonic from 1.

use crate::index::{IndexLimits, IndexWriter};
use crate::query::{self, EntryFilter, Order, QueryRequest, Sort};
use crate::sys::EntryKind;
use crate::walk::{
    self, Accounting, DirectoryTotals, EntryRecord, Progress, ScanOptions, ScanSink, ScanTotals,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{self, BufRead, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

const PROTOCOL_VERSION: u16 = 1;
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const SUPPORTED_OPERATIONS: [&str; 5] = ["hello", "probe", "cancel", "scan", "query-index"];
const PLANNED_OPERATIONS: [&str; 13] = [
    "hash-candidates",
    "inspect",
    "trash",
    "restore",
    "erase",
    "copy-move",
    "compress",
    "dedup-hardlink",
    "empty-trash",
    "manager-begin",
    "manager-append",
    "manager-finish",
    "journal-reconcile",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    protocol_version: u16,
    request_id: String,
    operation: String,
    arguments: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelArguments {
    cancel_request_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScanArguments {
    roots: Vec<String>,
    cross_filesystems: bool,
    excludes: Vec<String>,
    accounting: String,
    index_directory: String,
    #[serde(default)]
    throttle_bytes_per_second: Option<String>,
    #[serde(default)]
    max_depth: Option<String>,
    #[serde(default)]
    max_index_bytes: Option<String>,
    #[serde(default)]
    keep_scans: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FilterArguments {
    #[serde(default)]
    under_path: Option<String>,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    name_contains: Option<String>,
    #[serde(default)]
    extension: Option<String>,
    #[serde(default)]
    min_allocated_bytes: Option<String>,
    #[serde(default)]
    max_allocated_bytes: Option<String>,
    #[serde(default)]
    modified_before_nanoseconds: Option<String>,
    #[serde(default)]
    owner_id: Option<String>,
    #[serde(default)]
    kinds: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueryIndexArguments {
    scan_id: String,
    index_directory: String,
    #[serde(default)]
    filter: FilterArguments,
    sort: String,
    order: String,
    limit: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    include_type_totals: Option<bool>,
}

enum InputLine {
    Bytes(Vec<u8>),
    TooLong,
}

/// The one writer every thread's events pass through.
struct Channel {
    output: Mutex<Box<dyn Write + Send>>,
}

impl Channel {
    fn send(&self, event: &Value) {
        // A poisoned lock means another thread panicked, possibly mid-write.
        // Dropping every later event would lose the one thing a client cannot
        // do without: a terminal event. A newline is written first instead, so
        // a half-written line is closed and this event still parses on its own.
        let poisoned = self.output.is_poisoned();
        let mut output = match self.output.lock() {
            Ok(output) => output,
            Err(held) => held.into_inner(),
        };
        if poisoned {
            let _ = output.write_all(b"\n");
        }
        if serde_json::to_writer(&mut *output, event).is_ok() {
            let _ = output.write_all(b"\n");
            let _ = output.flush();
        }
    }
}

/// One request's view of the channel, with its own monotonic event IDs.
struct Responder {
    channel: Arc<Channel>,
    request_id: String,
    next_event: AtomicU64,
}

impl Responder {
    fn new(channel: Arc<Channel>, request_id: &str) -> Responder {
        Responder {
            channel,
            request_id: request_id.to_owned(),
            next_event: AtomicU64::new(1),
        }
    }

    fn emit(&self, event: &str, body: Value) {
        let id = self.next_event.fetch_add(1, Ordering::Relaxed);
        let mut message = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": self.request_id,
            "eventId": id.to_string(),
            "event": event,
        });
        if let (Some(object), Value::Object(fields)) = (message.as_object_mut(), body) {
            for (name, value) in fields {
                object.insert(name, value);
            }
        }
        self.channel.send(&message);
    }
}

/// The cancellation registry, tolerating a poisoned lock.
///
/// Poisoning means another thread panicked, not that the map is unusable, and
/// refusing to read it afterwards would leave every running scan uncancellable
/// and unremovable.
fn registry(server: &Server) -> std::sync::MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
    server
        .cancellations
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Server {
    channel: Arc<Channel>,
    cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
    workers: Mutex<Vec<JoinHandle<()>>>,
}

pub fn serve<R: BufRead, W: Write + Send + 'static>(mut input: R, output: W) -> io::Result<()> {
    let server = Arc::new(Server {
        channel: Arc::new(Channel {
            output: Mutex::new(Box::new(output)),
        }),
        cancellations: Mutex::new(HashMap::new()),
        workers: Mutex::new(Vec::new()),
    });

    while let Some(line) = read_line(&mut input)? {
        match line {
            InputLine::Bytes(bytes) => handle_request(&server, &bytes),
            InputLine::TooLong => {
                server.channel.send(&error_event(
                    None,
                    "request-too-large",
                    "Request exceeds 1 MiB",
                ));
            }
        }
    }

    // Stdin closing means the client is gone. Every running scan is told to
    // stop and then waited for, so each one still writes its final event and
    // leaves a consistent index behind.
    for flag in registry(&server).values() {
        flag.store(true, Ordering::Relaxed);
    }
    let workers = std::mem::take(&mut *server.workers.lock().expect("workers"));
    for worker in workers {
        let _ = worker.join();
    }
    Ok(())
}

// Consume the entire oversized line, so the next request remains in sync,
// without holding unbounded input in memory.
fn read_line<R: BufRead>(input: &mut R) -> io::Result<Option<InputLine>> {
    let mut bytes = Vec::new();
    let mut too_long = false;

    loop {
        let available = input.fill_buf()?;
        if available.is_empty() {
            return if bytes.is_empty() && !too_long {
                Ok(None)
            } else if too_long {
                Ok(Some(InputLine::TooLong))
            } else {
                Ok(Some(InputLine::Bytes(bytes)))
            };
        }

        let newline = available.iter().position(|byte| *byte == b'\n');
        let segment_length = newline.map_or(available.len(), |position| position + 1);

        if !too_long {
            if bytes.len().saturating_add(segment_length) > MAX_REQUEST_BYTES {
                too_long = true;
                bytes.clear();
            } else {
                bytes.extend_from_slice(&available[..segment_length]);
            }
        }

        input.consume(segment_length);
        if newline.is_some() {
            return if too_long {
                Ok(Some(InputLine::TooLong))
            } else {
                Ok(Some(InputLine::Bytes(bytes)))
            };
        }
    }
}

fn handle_request(server: &Arc<Server>, line: &[u8]) {
    let request: Request = match serde_json::from_slice(line) {
        Ok(request) => request,
        Err(parse_error) => {
            let request_id = salvage_request_id(line);
            server.channel.send(&error_event(
                request_id.as_deref(),
                "invalid-request",
                &format!("Invalid request: {parse_error}"),
            ));
            return;
        }
    };

    if !valid_request_id(&request.request_id) {
        server.channel.send(&error_event(
            None,
            "invalid-request-id",
            "requestId must be 1 to 128 ASCII letters, digits, '.', '-', or '_'",
        ));
        return;
    }

    let responder = Responder::new(Arc::clone(&server.channel), &request.request_id);
    if request.protocol_version != PROTOCOL_VERSION {
        fail(
            &responder,
            "unsupported-protocol-version",
            "The helper supports protocol version 1",
        );
        return;
    }

    match request.operation.as_str() {
        "hello" | "probe" if request.arguments.is_empty() => {
            responder.emit("complete", json!({ "result": hello_result() }));
        }
        "hello" | "probe" => fail(
            &responder,
            "invalid-arguments",
            "hello and probe do not accept arguments",
        ),
        "cancel" => cancel(server, &responder, request.arguments),
        "scan" => scan(server, responder, request.arguments),
        "query-index" => query_index(&responder, request.arguments),
        operation if PLANNED_OPERATIONS.contains(&operation) => fail(
            &responder,
            "unsupported-operation",
            "This operation is not implemented in this helper build",
        ),
        _ => fail(&responder, "unknown-operation", "Unknown helper operation"),
    }
}

fn hello_result() -> Value {
    json!({
        "helperVersion": env!("CARGO_PKG_VERSION"),
        // Release packaging may inject provenance data. Development
        // builds report null rather than a fabricated checksum.
        "buildChecksum": option_env!("DISKTOP_HELPER_BUILD_CHECKSUM"),
        "platform": std::env::consts::OS,
        "architecture": std::env::consts::ARCH,
        "kernelCapabilities": { "openat2": probe_openat2() },
        "supportedOperations": SUPPORTED_OPERATIONS,
    })
}

fn cancel(server: &Arc<Server>, responder: &Responder, arguments: Map<String, Value>) {
    let arguments: CancelArguments = match decode(arguments) {
        Ok(arguments) => arguments,
        Err(message) => return fail(responder, "invalid-arguments", &message),
    };

    let registry = registry(server);
    let Some(flag) = registry.get(&arguments.cancel_request_id) else {
        drop(registry);
        return fail(
            responder,
            "unknown-request",
            "No in-flight request has that ID. It may already have finished.",
        );
    };
    flag.store(true, Ordering::Relaxed);
    drop(registry);

    // The cancelled request emits its own final event; this one only confirms
    // that the request was asked to stop.
    responder.emit(
        "complete",
        json!({ "result": { "cancelRequestId": arguments.cancel_request_id } }),
    );
}

fn scan(server: &Arc<Server>, responder: Responder, arguments: Map<String, Value>) {
    let arguments: ScanArguments = match decode(arguments) {
        Ok(arguments) => arguments,
        Err(message) => return fail(&responder, "invalid-arguments", &message),
    };

    let options = match scan_options(&arguments) {
        Ok(options) => options,
        Err(message) => return fail(&responder, "invalid-arguments", &message),
    };
    let index_directory = match decode_path(&arguments.index_directory) {
        Ok(path) => PathBuf::from(OsStr::from_bytes(&path)),
        Err(message) => return fail(&responder, "invalid-arguments", &message),
    };
    let limits = match index_limits(&arguments) {
        Ok(limits) => limits,
        Err(message) => return fail(&responder, "invalid-arguments", &message),
    };

    if let Err(error) = crate::sys::openat2_available() {
        return fail(
            &responder,
            "unsupported-kernel",
            &format!(
                "Scanning needs openat2 containment, which this kernel refused: {error}. \
                 There is no unsafe fallback."
            ),
        );
    }

    let scan_id = new_scan_id();
    let cancelled = Arc::new(AtomicBool::new(false));
    registry(server).insert(responder.request_id.clone(), Arc::clone(&cancelled));

    responder.emit(
        "accepted",
        json!({ "accepted": { "operation": "scan", "cancellable": true } }),
    );

    let owned = Arc::clone(server);
    let worker = std::thread::spawn(move || {
        let request_id = responder.request_id.clone();
        // A panicking worker must still settle its request. A client waits for
        // a terminal event and has no timeout, so a dropped one would hang it
        // for as long as the helper lives.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_scan(
                &responder,
                &scan_id,
                &index_directory,
                &options,
                &limits,
                &cancelled,
            );
        }));
        if outcome.is_err() {
            fail(
                &responder,
                "internal-error",
                "The scan failed unexpectedly and was abandoned. No file was changed.",
            );
        }
        registry(&owned).remove(&request_id);
    });
    server.workers.lock().expect("workers").push(worker);
}

fn run_scan(
    responder: &Responder,
    scan_id: &str,
    index_directory: &std::path::Path,
    options: &ScanOptions,
    limits: &IndexLimits,
    cancelled: &AtomicBool,
) {
    if let Err(error) = std::fs::create_dir_all(index_directory) {
        return fail(
            responder,
            "permission-denied",
            &format!("The index directory could not be created: {error}"),
        );
    }

    let mut writer = match IndexWriter::begin(
        index_directory,
        scan_id,
        &options.roots,
        options.accounting.as_str(),
        limits,
    ) {
        Ok(writer) => writer,
        Err(error) => {
            return fail(
                responder,
                "internal-error",
                &format!("The index could not be opened: {error}"),
            );
        }
    };

    let totals = {
        let mut sink = ReportingSink {
            writer: &mut writer,
            responder,
        };
        match walk::walk(options, &mut sink, cancelled) {
            Ok(totals) => totals,
            Err(error) => {
                return fail(
                    responder,
                    if error.kind() == io::ErrorKind::Unsupported {
                        "unsupported-kernel"
                    } else {
                        "internal-error"
                    },
                    &format!("The scan stopped: {error}"),
                );
            }
        }
    };

    if let Err(error) = writer.finish(&totals, limits) {
        return fail(
            responder,
            "internal-error",
            &format!("The scan result could not be stored: {error}"),
        );
    }

    responder.emit(
        "complete",
        json!({ "result": scan_result(scan_id, options, &totals) }),
    );
}

fn scan_result(scan_id: &str, options: &ScanOptions, totals: &ScanTotals) -> Value {
    json!({
        "scanId": scan_id,
        "complete": totals.complete,
        "roots": options.roots.iter().map(|root| crate::base64::encode(root)).collect::<Vec<_>>(),
        "accounting": options.accounting.as_str(),
        "scannedEntries": totals.scanned_entries.to_string(),
        "inaccessibleDirectories": totals.inaccessible_directories.to_string(),
        "allocatedBytes": totals.allocated_bytes.to_string(),
        "apparentBytes": totals.apparent_bytes.to_string(),
        "sharedBytes": totals.shared_bytes.to_string(),
        "filesystems": totals
            .filesystems
            .iter()
            .map(|device| device.to_string())
            .collect::<Vec<_>>(),
        "excludedMounts": totals
            .excluded_mounts
            .iter()
            .map(|mount| crate::base64::encode(mount))
            .collect::<Vec<_>>(),
        "warnings": totals
            .warnings
            .iter()
            .map(|warning| {
                let mut object = Map::new();
                object.insert("code".to_owned(), warning.code.into());
                object.insert("message".to_owned(), warning.message.clone().into());
                if let Some(path) = &warning.path {
                    object.insert("path".to_owned(), crate::base64::encode(path).into());
                }
                Value::Object(object)
            })
            .collect::<Vec<_>>(),
    })
}

/// Writes each entry to the index and turns the walker's periodic snapshots
/// into `progress` events.
struct ReportingSink<'a> {
    writer: &'a mut IndexWriter,
    responder: &'a Responder,
}

impl ScanSink for ReportingSink<'_> {
    fn entry(&mut self, record: &EntryRecord<'_>) -> io::Result<i64> {
        self.writer.entry(record)
    }

    fn finish_directory(&mut self, id: i64, totals: &DirectoryTotals) -> io::Result<()> {
        self.writer.finish_directory(id, totals)
    }

    fn progress(&mut self, snapshot: &Progress) {
        self.responder.emit(
            "progress",
            json!({
                "progress": {
                    "scannedEntries": snapshot.scanned_entries.to_string(),
                    "processedBytes": snapshot.processed_bytes.to_string(),
                    "inaccessibleDirectories": snapshot.inaccessible_directories.to_string(),
                    "currentPath": crate::base64::encode(&snapshot.current_path),
                }
            }),
        );
    }
}

fn query_index(responder: &Responder, arguments: Map<String, Value>) {
    let arguments: QueryIndexArguments = match decode(arguments) {
        Ok(arguments) => arguments,
        Err(message) => return fail(responder, "invalid-arguments", &message),
    };

    let mut request = match query_request(&arguments) {
        Ok(request) => request,
        Err(message) => return fail(responder, "invalid-arguments", &message),
    };
    let index_directory = match decode_path(&arguments.index_directory) {
        Ok(path) => PathBuf::from(OsStr::from_bytes(&path)),
        Err(message) => return fail(responder, "invalid-arguments", &message),
    };

    let connection = match crate::index::open(&index_directory) {
        Ok(connection) => connection,
        Err(error) => {
            return fail(
                responder,
                "internal-error",
                &format!("The index could not be opened: {error}"),
            );
        }
    };

    match crate::index::scan_exists(&connection, &request.scan_id) {
        Ok(true) => {}
        Ok(false) => {
            return fail(
                responder,
                "unknown-request",
                "That scan is not in the index. It may have been pruned; run a new scan.",
            );
        }
        Err(error) => {
            return fail(
                responder,
                "internal-error",
                &format!("The index could not be read: {error}"),
            );
        }
    }

    if let Some(encoded) = &arguments.filter.under_path {
        let path = match decode_path(encoded) {
            Ok(path) => path,
            Err(message) => return fail(responder, "invalid-arguments", &message),
        };
        match crate::index::subtree_range(&connection, &request.scan_id, &path) {
            // A path the scan never saw is refused by name. An empty page
            // would read as "there is nothing under there".
            Ok(None) => {
                return fail(
                    responder,
                    "invalid-arguments",
                    "That path is not in this scan. Scan it before exploring it.",
                );
            }
            Ok(range) => request.filter.under = range,
            Err(error) => {
                return fail(
                    responder,
                    "internal-error",
                    &format!("The subtree could not be resolved: {error}"),
                );
            }
        }
    }

    let page = match query::query(&connection, &request) {
        Ok(page) => page,
        Err(error) => {
            return fail(
                responder,
                "invalid-arguments",
                &format!("The index query failed: {error}"),
            );
        }
    };

    let mut result = Map::new();
    result.insert("scanId".to_owned(), request.scan_id.clone().into());
    result.insert(
        "entries".to_owned(),
        Value::Array(
            page.entries
                .iter()
                .map(|row| {
                    let mut entry = Map::new();
                    entry.insert("id".to_owned(), row.id.to_string().into());
                    if let Some(parent) = row.parent_id {
                        entry.insert("parentId".to_owned(), parent.to_string().into());
                    }
                    entry.insert("path".to_owned(), crate::base64::encode(&row.path).into());
                    entry.insert("kind".to_owned(), row.kind.as_str().into());
                    entry.insert("device".to_owned(), row.device.clone().into());
                    entry.insert("inode".to_owned(), row.inode.clone().into());
                    entry.insert("mountId".to_owned(), row.mount_id.clone().into());
                    entry.insert("linkCount".to_owned(), row.link_count.to_string().into());
                    entry.insert(
                        "apparentBytes".to_owned(),
                        row.apparent_bytes.to_string().into(),
                    );
                    entry.insert(
                        "allocatedBytes".to_owned(),
                        row.allocated_bytes.to_string().into(),
                    );
                    entry.insert("ownerId".to_owned(), row.owner_id.to_string().into());
                    entry.insert(
                        "modifiedNanoseconds".to_owned(),
                        row.modified_nanoseconds.to_string().into(),
                    );
                    entry.insert("shared".to_owned(), row.shared.into());
                    Value::Object(entry)
                })
                .collect(),
        ),
    );
    if let Some(cursor) = page.next_cursor {
        result.insert("nextCursor".to_owned(), cursor.into());
    }
    if let Some(totals) = page.type_totals {
        result.insert(
            "typeTotals".to_owned(),
            Value::Array(
                totals
                    .iter()
                    .map(|total| {
                        json!({
                            "extension": total.extension,
                            "entries": total.entries.to_string(),
                            "allocatedBytes": total.allocated_bytes.to_string(),
                            "apparentBytes": total.apparent_bytes.to_string(),
                        })
                    })
                    .collect(),
            ),
        );
    }

    responder.emit("complete", json!({ "result": Value::Object(result) }));
}

fn index_limits(arguments: &ScanArguments) -> Result<IndexLimits, String> {
    let defaults = IndexLimits::default();
    Ok(IndexLimits {
        max_bytes: optional_u64(arguments.max_index_bytes.as_deref(), "maxIndexBytes")?
            .unwrap_or(defaults.max_bytes),
        keep_scans: optional_u64(arguments.keep_scans.as_deref(), "keepScans")?
            .map(|value| value.clamp(1, 1000) as u32)
            .unwrap_or(defaults.keep_scans),
    })
}

fn scan_options(arguments: &ScanArguments) -> Result<ScanOptions, String> {
    if arguments.roots.is_empty() {
        return Err("A scan needs at least one root".to_owned());
    }
    let mut roots = Vec::with_capacity(arguments.roots.len());
    for root in &arguments.roots {
        let bytes = decode_path(root)?;
        if bytes.first() != Some(&b'/') {
            return Err("A scan root must be an absolute path".to_owned());
        }
        roots.push(bytes);
    }
    let mut excludes = Vec::with_capacity(arguments.excludes.len());
    for exclude in &arguments.excludes {
        excludes.push(decode_path(exclude)?);
    }

    let accounting = match arguments.accounting.as_str() {
        "allocated" => Accounting::Allocated,
        "apparent" => Accounting::Apparent,
        other => return Err(format!("Unknown accounting mode '{other}'")),
    };

    Ok(ScanOptions {
        roots,
        cross_filesystems: arguments.cross_filesystems,
        excludes,
        accounting,
        throttle_bytes_per_second: optional_u64(
            arguments.throttle_bytes_per_second.as_deref(),
            "throttleBytesPerSecond",
        )?,
        max_depth: optional_u64(arguments.max_depth.as_deref(), "maxDepth")?
            .map(|depth| depth.min(u64::from(walk::MAX_DEPTH)) as u32),
    })
}

/// A decimal-string argument is either absent or valid. Falling back to a
/// default on a malformed value would run a different operation than the one
/// asked for, without saying so.
fn optional_u64(value: Option<&str>, field: &str) -> Result<Option<u64>, String> {
    match value {
        None => Ok(None),
        Some(text) => match parse_u64(Some(text)) {
            Some(number) => Ok(Some(number)),
            None => Err(format!("{field} must be a non-negative decimal integer")),
        },
    }
}

fn query_request(arguments: &QueryIndexArguments) -> Result<QueryRequest, String> {
    let sort = Sort::parse(&arguments.sort).ok_or_else(|| "Unknown sort column".to_owned())?;
    let order = Order::parse(&arguments.order).ok_or_else(|| "Unknown sort order".to_owned())?;
    let limit = parse_u64(Some(&arguments.limit))
        .ok_or_else(|| "limit must be a decimal integer".to_owned())?;

    let filter = &arguments.filter;
    let kinds = match &filter.kinds {
        None => None,
        Some(names) => {
            let mut kinds = Vec::with_capacity(names.len());
            for name in names {
                kinds.push(match name.as_str() {
                    "file" => EntryKind::File,
                    "directory" => EntryKind::Directory,
                    "symlink" => EntryKind::Symlink,
                    "other" => EntryKind::Other,
                    other => return Err(format!("Unknown entry kind '{other}'")),
                });
            }
            Some(kinds)
        }
    };

    Ok(QueryRequest {
        scan_id: arguments.scan_id.clone(),
        filter: EntryFilter {
            // Resolved against the index once the connection is open.
            under: None,
            parent_id: optional_u64(filter.parent_id.as_deref(), "parentId")?
                .map(|id| id.min(i64::MAX as u64) as i64),
            name_contains: filter.name_contains.clone(),
            extension: filter.extension.clone(),
            min_allocated_bytes: optional_u64(
                filter.min_allocated_bytes.as_deref(),
                "minAllocatedBytes",
            )?,
            max_allocated_bytes: optional_u64(
                filter.max_allocated_bytes.as_deref(),
                "maxAllocatedBytes",
            )?,
            modified_before_nanoseconds: optional_u64(
                filter.modified_before_nanoseconds.as_deref(),
                "modifiedBeforeNanoseconds",
            )?,
            owner_id: optional_u64(filter.owner_id.as_deref(), "ownerId")?,
            kinds,
        },
        sort,
        order,
        limit: limit.min(u64::from(query::MAX_LIMIT)) as u32,
        cursor: arguments.cursor.clone(),
        include_type_totals: arguments.include_type_totals.unwrap_or(false),
    })
}

fn decode<T: serde::de::DeserializeOwned>(arguments: Map<String, Value>) -> Result<T, String> {
    serde_json::from_value(Value::Object(arguments)).map_err(|error| error.to_string())
}

fn decode_path(encoded: &str) -> Result<Vec<u8>, String> {
    let bytes = crate::base64::decode(encoded).map_err(|reason| reason.to_owned())?;
    if bytes.contains(&0) {
        return Err("A path may not contain a NUL byte".to_owned());
    }
    Ok(bytes)
}

fn parse_u64(value: Option<&str>) -> Option<u64> {
    let value = value?;
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if value.len() > 1 && value.starts_with('0') {
        return None;
    }
    value.parse::<u64>().ok()
}

/// Unique per scan and safe to echo: the clock keeps IDs ordered for a reader,
/// and kernel randomness keeps two scans started in the same second apart.
fn new_scan_id() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let mut random = [0u8; 8];
    if let Ok(mut file) = std::fs::File::open("/dev/urandom") {
        let _ = io::Read::read_exact(&mut file, &mut random);
    }
    let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("scan-{seconds}-{suffix}")
}

fn valid_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn salvage_request_id(line: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(line).ok()?;
    let id = value.get("requestId")?.as_str()?;
    valid_request_id(id).then(|| id.to_owned())
}

fn fail(responder: &Responder, code: &str, message: &str) {
    responder.emit(
        "error",
        json!({ "error": { "code": code, "message": message } }),
    );
}

fn error_event(request_id: Option<&str>, code: &str, message: &str) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "eventId": "1",
        "event": "error",
        "error": { "code": code, "message": message },
    })
}

#[cfg(target_os = "linux")]
fn probe_openat2() -> Value {
    match crate::sys::openat2_available() {
        Ok(()) => json!({ "available": true, "reason": null }),
        Err(error) => json!({
            "available": false,
            "reason": format!("openat2 probe failed: {error}"),
        }),
    }
}

#[cfg(not(target_os = "linux"))]
fn probe_openat2() -> Value {
    json!({ "available": false, "reason": "openat2 requires Linux" })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Sandbox;
    use std::io::Cursor;
    use std::sync::mpsc;

    /// Collects the helper's stdout in memory so a test can read the whole
    /// stream after `serve` returns.
    #[derive(Clone)]
    struct Recorder(Arc<Mutex<Vec<u8>>>);

    impl Write for Recorder {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.0.lock().expect("recorder").extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn responses(input: &str) -> Vec<Value> {
        let recorder = Recorder(Arc::new(Mutex::new(Vec::new())));
        serve(Cursor::new(input.as_bytes().to_vec()), recorder.clone()).unwrap();
        parse(&recorder.0.lock().expect("recorder").clone())
    }

    fn parse(bytes: &[u8]) -> Vec<Value> {
        bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect()
    }

    /// Run requests against a stdin that stays open until `settled` reports
    /// that the session can end.
    ///
    /// Closing stdin is how a client says it has gone away, and the helper
    /// answers that by cancelling in-flight scans. A test that wants to
    /// observe a scan finishing must therefore hold the stream open, exactly
    /// as the real client does.
    fn session<F>(requests: &[String], settled: F) -> Vec<Value>
    where
        F: Fn(&[Value]) -> bool,
    {
        let (sender, receiver) = mpsc::channel::<Vec<u8>>();
        let reader = ChannelReader {
            receiver,
            buffer: Vec::new(),
            position: 0,
        };
        let recorder = Recorder(Arc::new(Mutex::new(Vec::new())));
        let recorded = Arc::clone(&recorder.0);

        for request in requests {
            sender
                .send(request.clone().into_bytes())
                .expect("the reader is alive");
        }
        let worker = std::thread::spawn(move || serve(io::BufReader::new(reader), recorder));

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            let events = parse(&recorded.lock().expect("recorder").clone());
            if settled(&events) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the session never settled"
            );
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        drop(sender);
        worker
            .join()
            .expect("the server thread")
            .expect("the protocol loop");
        parse(&recorded.lock().expect("recorder").clone())
    }

    fn terminal(events: &[Value], request_id: &str) -> bool {
        events.iter().any(|event| {
            event["requestId"] == request_id
                && (event["event"] == "complete" || event["event"] == "error")
        })
    }

    fn scan_request(id: &str, root: &[u8], index: &[u8]) -> String {
        format!(
            "{{\"protocolVersion\":1,\"requestId\":\"{id}\",\"operation\":\"scan\",\"arguments\":{{\
               \"roots\":[\"{}\"],\"crossFilesystems\":false,\"excludes\":[\"{}\"],\
               \"accounting\":\"allocated\",\"indexDirectory\":\"{}\"}}}}\n",
            crate::base64::encode(root),
            crate::base64::encode(index),
            crate::base64::encode(index),
        )
    }

    #[test]
    fn handshake_reports_the_operations_this_build_implements() {
        let output = responses(
            "{\"protocolVersion\":1,\"requestId\":\"hello-1\",\"operation\":\"hello\",\"arguments\":{}}\n",
        );
        assert_eq!(output.len(), 1);
        assert_eq!(output[0]["event"], "complete");
        assert_eq!(
            output[0]["result"]["supportedOperations"],
            json!(["hello", "probe", "cancel", "scan", "query-index"])
        );
    }

    #[test]
    fn mutating_operation_is_explicitly_unsupported() {
        let output = responses(
            "{\"protocolVersion\":1,\"requestId\":\"trash-1\",\"operation\":\"trash\",\"arguments\":{}}\n",
        );
        assert_eq!(output[0]["event"], "error");
        assert_eq!(output[0]["requestId"], "trash-1");
        assert_eq!(output[0]["error"]["code"], "unsupported-operation");
    }

    #[test]
    fn rejects_unknown_fields_and_versions_without_losing_request_id() {
        let output = responses(concat!(
            "{\"protocolVersion\":1,\"requestId\":\"bad-field\",\"operation\":\"hello\",\"arguments\":{},\"extra\":true}\n",
            "{\"protocolVersion\":2,\"requestId\":\"bad-version\",\"operation\":\"hello\",\"arguments\":{}}\n",
        ));
        assert_eq!(output[0]["requestId"], "bad-field");
        assert_eq!(output[0]["error"]["code"], "invalid-request");
        assert_eq!(output[1]["requestId"], "bad-version");
        assert_eq!(output[1]["error"]["code"], "unsupported-protocol-version");
    }

    #[test]
    fn rejects_arguments_and_unknown_operations() {
        let output = responses(concat!(
            "{\"protocolVersion\":1,\"requestId\":\"args\",\"operation\":\"probe\",\"arguments\":{\"path\":\"/\"}}\n",
            "{\"protocolVersion\":1,\"requestId\":\"unknown\",\"operation\":\"wipe-all\",\"arguments\":{}}\n",
        ));
        assert_eq!(output[0]["error"]["code"], "invalid-arguments");
        assert_eq!(output[1]["error"]["code"], "unknown-operation");
    }

    #[test]
    fn oversized_line_is_drained_before_next_request() {
        let mut input = format!("{}\n", "a".repeat(MAX_REQUEST_BYTES));
        input.push_str(
            "{\"protocolVersion\":1,\"requestId\":\"next\",\"operation\":\"probe\",\"arguments\":{}}\n",
        );
        let output = responses(&input);
        assert_eq!(output.len(), 2);
        assert_eq!(output[0]["error"]["code"], "request-too-large");
        assert_eq!(output[1]["requestId"], "next");
        assert_eq!(output[1]["event"], "complete");
    }

    #[test]
    fn a_scan_is_accepted_then_completes_with_lossless_totals() {
        let sandbox = Sandbox::new("protocol-scan");
        sandbox.directory(b"index");
        sandbox.file(b"one.txt", 4096);
        sandbox.file(b"two.txt", 4096);
        let index = sandbox.path().join("index");

        let output = session(
            &[scan_request(
                "scan-1",
                &sandbox.bytes(),
                index.as_os_str().as_bytes(),
            )],
            |events| terminal(events, "scan-1"),
        );

        assert_eq!(output[0]["event"], "accepted");
        assert_eq!(output[0]["accepted"]["cancellable"], true);
        let complete = output.last().expect("a terminal event");
        assert_eq!(complete["event"], "complete");
        assert_eq!(complete["result"]["complete"], true);
        assert_eq!(complete["result"]["accounting"], "allocated");
        // Every filesystem integer crosses as a decimal string.
        assert!(complete["result"]["allocatedBytes"].is_string());
        assert!(
            complete["result"]["scannedEntries"]
                .as_str()
                .and_then(|value| value.parse::<u64>().ok())
                .is_some_and(|entries| entries >= 3)
        );
    }

    #[test]
    fn an_index_query_pages_the_scan_the_helper_just_wrote() {
        let sandbox = Sandbox::new("protocol-query");
        sandbox.directory(b"index");
        sandbox.file(b"big.log", 200_000);
        sandbox.file(b"small.log", 64);
        let index = sandbox.path().join("index");
        let index_bytes = index.as_os_str().as_bytes();

        let scan = session(
            &[scan_request("scan-1", &sandbox.bytes(), index_bytes)],
            |events| terminal(events, "scan-1"),
        );
        let scan_id = scan.last().unwrap()["result"]["scanId"]
            .as_str()
            .expect("a scan ID")
            .to_owned();

        let output = responses(&format!(
            "{{\"protocolVersion\":1,\"requestId\":\"query-index-1\",\"operation\":\"query-index\",\
              \"arguments\":{{\"scanId\":\"{scan_id}\",\"indexDirectory\":\"{}\",\
              \"filter\":{{\"extension\":\"log\"}},\"sort\":\"allocated\",\"order\":\"descending\",\
              \"limit\":\"1\",\"includeTypeTotals\":true}}}}\n",
            crate::base64::encode(index_bytes),
        ));

        let result = &output[0]["result"];
        assert_eq!(output[0]["event"], "complete");
        assert_eq!(result["entries"].as_array().unwrap().len(), 1);
        assert!(result["nextCursor"].is_string());
        assert!(result["typeTotals"].is_array());
        // The path is base64 bytes, never display text.
        assert!(!result["entries"][0]["path"].as_str().unwrap().contains('/'));
    }

    #[test]
    fn an_unknown_scan_is_refused_rather_than_answered_with_an_empty_page() {
        let sandbox = Sandbox::new("protocol-missing");
        sandbox.directory(b"index");
        let index = sandbox.path().join("index");
        let output = responses(&format!(
            "{{\"protocolVersion\":1,\"requestId\":\"query-index-1\",\"operation\":\"query-index\",\
              \"arguments\":{{\"scanId\":\"scan-does-not-exist\",\"indexDirectory\":\"{}\",\
              \"sort\":\"allocated\",\"order\":\"descending\",\"limit\":\"10\"}}}}\n",
            crate::base64::encode(index.as_os_str().as_bytes()),
        ));
        assert_eq!(output[0]["event"], "error");
        assert_eq!(output[0]["error"]["code"], "unknown-request");
    }

    #[test]
    fn a_malformed_numeric_argument_is_refused_rather_than_ignored() {
        let sandbox = Sandbox::new("protocol-numbers");
        sandbox.directory(b"index");
        let index = crate::base64::encode(sandbox.path().join("index").as_os_str().as_bytes());
        let root = crate::base64::encode(&sandbox.bytes());

        let output = responses(&format!(
            "{{\"protocolVersion\":1,\"requestId\":\"scan-1\",\"operation\":\"scan\",\"arguments\":{{\
               \"roots\":[\"{root}\"],\"crossFilesystems\":false,\"excludes\":[],\
               \"accounting\":\"allocated\",\"indexDirectory\":\"{index}\",\"maxDepth\":\"deep\"}}}}\n",
        ));
        assert_eq!(output[0]["event"], "error");
        assert_eq!(output[0]["error"]["code"], "invalid-arguments");
        assert!(
            output[0]["error"]["message"]
                .as_str()
                .unwrap()
                .contains("maxDepth")
        );
    }

    #[test]
    fn a_subtree_that_was_never_scanned_is_refused_not_answered_with_an_empty_page() {
        let sandbox = Sandbox::new("protocol-subtree");
        sandbox.directory(b"index");
        sandbox.file(b"a.txt", 32);
        let index = sandbox.path().join("index");
        let index_bytes = index.as_os_str().as_bytes();

        let scan = session(
            &[scan_request("scan-1", &sandbox.bytes(), index_bytes)],
            |events| terminal(events, "scan-1"),
        );
        let scan_id = scan.last().unwrap()["result"]["scanId"]
            .as_str()
            .unwrap()
            .to_owned();
        // The scan reports the filesystem it read, which is what makes two
        // snapshots comparable.
        assert!(
            !scan.last().unwrap()["result"]["filesystems"]
                .as_array()
                .unwrap()
                .is_empty()
        );

        let mut absent = sandbox.bytes();
        absent.extend_from_slice(b"/never-created");
        let output = responses(&format!(
            "{{\"protocolVersion\":1,\"requestId\":\"query-index-1\",\"operation\":\"query-index\",\
              \"arguments\":{{\"scanId\":\"{scan_id}\",\"indexDirectory\":\"{}\",\
              \"filter\":{{\"underPath\":\"{}\"}},\"sort\":\"allocated\",\"order\":\"descending\",\
              \"limit\":\"10\"}}}}\n",
            crate::base64::encode(index_bytes),
            crate::base64::encode(&absent),
        ));
        assert_eq!(output[0]["event"], "error");
        assert_eq!(output[0]["error"]["code"], "invalid-arguments");
        assert!(
            output[0]["error"]["message"]
                .as_str()
                .unwrap()
                .contains("not in this scan")
        );
    }

    #[test]
    fn cancelling_an_unknown_request_says_so_instead_of_silently_succeeding() {
        let output = responses(
            "{\"protocolVersion\":1,\"requestId\":\"cancel-1\",\"operation\":\"cancel\",\"arguments\":{\"cancelRequestId\":\"scan-404\"}}\n",
        );
        assert_eq!(output[0]["error"]["code"], "unknown-request");
    }

    #[test]
    fn cancelling_a_running_scan_still_produces_a_partial_result() {
        let sandbox = Sandbox::new("protocol-cancel");
        sandbox.directory(b"index");
        for bucket in 0..40 {
            let directory = format!("bucket-{bucket}");
            sandbox.directory(directory.as_bytes());
            for file in 0..40 {
                sandbox.file(format!("{directory}/file-{file}.bin").as_bytes(), 128);
            }
        }
        let index = sandbox.path().join("index");

        let events = session(
            &[
                scan_request("scan-1", &sandbox.bytes(), index.as_os_str().as_bytes()),
                "{\"protocolVersion\":1,\"requestId\":\"cancel-1\",\"operation\":\"cancel\",\"arguments\":{\"cancelRequestId\":\"scan-1\"}}\n"
                    .to_owned(),
            ],
            |events| terminal(events, "scan-1"),
        );

        let complete = events
            .iter()
            .find(|event| event["requestId"] == "scan-1" && event["event"] == "complete")
            .expect("the cancelled scan still emits a final event");
        // The scan either finished before the cancel landed or stopped early.
        // A partial result must say what it missed; a complete one must not
        // claim it was cancelled.
        if complete["result"]["complete"] == false {
            assert!(
                complete["result"]["warnings"]
                    .as_array()
                    .expect("warnings")
                    .iter()
                    .any(|warning| warning["code"] == "cancelled")
            );
        }
        // The index still holds a usable, queryable scan either way.
        let scan_id = complete["result"]["scanId"].as_str().expect("a scan ID");
        let page = responses(&format!(
            "{{\"protocolVersion\":1,\"requestId\":\"query-index-1\",\"operation\":\"query-index\",              \"arguments\":{{\"scanId\":\"{scan_id}\",\"indexDirectory\":\"{}\",              \"sort\":\"allocated\",\"order\":\"descending\",\"limit\":\"5\"}}}}\n",
            crate::base64::encode(index.as_os_str().as_bytes()),
        ));
        assert_eq!(page[0]["event"], "complete");
    }

    /// Feeds `serve` one queued chunk at a time and reports end-of-stream only
    /// once the sender is dropped.
    struct ChannelReader {
        receiver: mpsc::Receiver<Vec<u8>>,
        buffer: Vec<u8>,
        position: usize,
    }

    impl io::Read for ChannelReader {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            while self.position >= self.buffer.len() {
                match self.receiver.recv() {
                    Ok(chunk) => {
                        self.buffer = chunk;
                        self.position = 0;
                    }
                    Err(_) => return Ok(0),
                }
            }
            let count = out.len().min(self.buffer.len() - self.position);
            out[..count].copy_from_slice(&self.buffer[self.position..self.position + count]);
            self.position += count;
            Ok(count)
        }
    }
}
