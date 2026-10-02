//! Versioned JSON-lines boundary for the filesystem helper.
//!
//! Reads are `hello`, `probe`, `scan`, `query-index`, `hash-candidates`, and
//! `journal-reconcile`; mutations are `trash`, `erase`, `empty-trash`, and
//! `restore`. Every operation this build does not implement is refused by name
//! rather than ignored, so a client can tell "not here yet" from "never".
//!
//! Anything that reads content or changes a file runs on its own thread so
//! that `cancel` can be read and acted on while it is still working. Every event goes out through one lock, so two
//! requests can never interleave halfway through a line, and each request's
//! event IDs are monotonic from 1.

use crate::actions::{self, TrashRequest};
use crate::duplicates;
use crate::guard::Fingerprint;
use crate::index::{IndexLimits, IndexWriter};
use crate::journal::{self, Journal};
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
const SUPPORTED_OPERATIONS: [&str; 12] = [
    "hello",
    "probe",
    "cancel",
    "scan",
    "query-index",
    "hash-candidates",
    "trash",
    "erase",
    "empty-trash",
    "restore",
    "dedup-hardlink",
    "journal-reconcile",
];
const PLANNED_OPERATIONS: [&str; 6] = [
    "inspect",
    "copy-move",
    "compress",
    "manager-begin",
    "manager-append",
    "manager-finish",
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
struct FingerprintArguments {
    device: String,
    inode: String,
    mount_id: String,
    kind: String,
    apparent_bytes: String,
    modified_nanoseconds: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetArguments {
    path: String,
    expected: FingerprintArguments,
    #[serde(default)]
    reviewed_bytes: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrashArguments {
    plan_id: String,
    journal_directory: String,
    home_trash_directory: String,
    targets: Vec<TargetArguments>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EraseArguments {
    plan_id: String,
    journal_directory: String,
    targets: Vec<TargetArguments>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreArguments {
    journal_directory: String,
    journal_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DedupHardlinkArguments {
    plan_id: String,
    journal_directory: String,
    keep: TargetArguments,
    targets: Vec<TargetArguments>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EmptyTrashArguments {
    plan_id: String,
    journal_directory: String,
    home_trash_directory: String,
    trash_directories: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JournalArguments {
    journal_directory: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<String>,
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
    #[serde(default)]
    max_child_entries: Option<String>,
    #[serde(default)]
    broken: Option<bool>,
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
    #[serde(default)]
    include_owner_totals: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HashCandidatesArguments {
    scan_id: String,
    index_directory: String,
    #[serde(default)]
    under_path: Option<String>,
    #[serde(default)]
    minimum_bytes: Option<String>,
    #[serde(default)]
    maximum_groups: Option<u32>,
    #[serde(default)]
    maximum_files_per_group: Option<u32>,
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
        "trash" => trash(server, responder, request.arguments),
        "erase" => erase(server, responder, request.arguments),
        "empty-trash" => empty_trash(server, responder, request.arguments),
        "dedup-hardlink" => dedup_hardlink(server, responder, request.arguments),
        "restore" => restore(server, responder, request.arguments),
        "journal-reconcile" => journal_reconcile(&responder, request.arguments),
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
        "hash-candidates" => hash_candidates(server, responder, request.arguments),
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
                    // Absent rather than zero when the walk never entered the
                    // directory: an unreadable directory is not an empty one.
                    if let Some(children) = row.child_entries {
                        entry.insert("childEntries".to_owned(), children.to_string().into());
                    }
                    entry.insert("broken".to_owned(), row.broken.into());
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
    if let Some(totals) = page.owner_totals {
        result.insert(
            "ownerTotals".to_owned(),
            Value::Array(
                totals
                    .iter()
                    .map(|total| {
                        json!({
                            "ownerId": total.owner_id.to_string(),
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

/// Move every reviewed target to Trash.
///
/// It runs on its own thread for the same reason a scan does: a person who
/// changes their mind halfway through a long list has to be able to say so,
/// and `cancel` can only be read while this is still going.
/// Find the groups of identical files in one scan.
///
/// This reads content, which a query of the index does not, so it runs on its
/// own thread and answers `cancel` like a scan does. It opens every file it
/// reads with the same containment a mutation uses and changes nothing.
fn hash_candidates(server: &Arc<Server>, responder: Responder, arguments: Map<String, Value>) {
    let arguments: HashCandidatesArguments = match decode(arguments) {
        Ok(arguments) => arguments,
        Err(message) => return fail(&responder, "invalid-arguments", &message),
    };

    let index_directory = match decode_path(&arguments.index_directory) {
        Ok(path) => PathBuf::from(OsStr::from_bytes(&path)),
        Err(message) => return fail(&responder, "invalid-arguments", &message),
    };
    let minimum_bytes = match arguments.minimum_bytes.as_deref() {
        None => 1,
        Some(value) => match parse_u64(Some(value)) {
            Some(parsed) => parsed,
            None => {
                return fail(
                    &responder,
                    "invalid-arguments",
                    "minimumBytes must be a decimal string",
                );
            }
        },
    };
    let under_path = match arguments.under_path.as_deref() {
        None => None,
        Some(encoded) => match decode_path(encoded) {
            Ok(path) => Some(path),
            Err(message) => return fail(&responder, "invalid-arguments", &message),
        },
    };

    if let Err(message) = require_containment() {
        return fail(&responder, "unsupported-kernel", &message);
    }

    let connection = match crate::index::open(&index_directory) {
        Ok(connection) => connection,
        Err(error) => {
            return fail(
                &responder,
                "internal-error",
                &format!("The index could not be opened: {error}"),
            );
        }
    };
    match crate::index::scan_exists(&connection, &arguments.scan_id) {
        Ok(true) => {}
        Ok(false) => {
            return fail(
                &responder,
                "unknown-request",
                "That scan is not in the index. It may have been pruned; run a new scan.",
            );
        }
        Err(error) => {
            return fail(
                &responder,
                "internal-error",
                &format!("The index could not be read: {error}"),
            );
        }
    }

    let under = match under_path {
        None => None,
        Some(path) => match crate::index::subtree_range(&connection, &arguments.scan_id, &path) {
            // A path the scan never saw is refused by name; no groups would
            // read as "there are no duplicates under there".
            Ok(None) => {
                return fail(
                    &responder,
                    "invalid-arguments",
                    "That path is not in this scan. Scan it before searching it.",
                );
            }
            Ok(range) => range,
            Err(error) => {
                return fail(
                    &responder,
                    "internal-error",
                    &format!("The subtree could not be resolved: {error}"),
                );
            }
        },
    };
    drop(connection);

    let request = duplicates::Request {
        scan_id: arguments.scan_id,
        under,
        minimum_bytes,
        maximum_groups: arguments.maximum_groups.unwrap_or(duplicates::MAX_GROUPS),
        maximum_files_per_group: arguments
            .maximum_files_per_group
            .unwrap_or(duplicates::MAX_FILES_PER_GROUP),
    };

    spawn_cancellable(
        server,
        responder,
        "hash-candidates",
        SEARCH_ABANDONED,
        move |responder, cancelled| {
            // The connection is opened on the worker thread: a rusqlite
            // connection belongs to the thread that made it.
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
            match duplicates::find(&connection, &request, cancelled) {
                Ok(report) => {
                    responder.emit("complete", json!({ "result": duplicate_result(&report) }))
                }
                Err(error) => fail(
                    responder,
                    "internal-error",
                    &format!("The duplicate search failed: {error}"),
                ),
            }
        },
    );
}

fn duplicate_result(report: &duplicates::Report) -> Value {
    json!({
        "groups": report
            .groups
            .iter()
            .map(|group| json!({
                "apparentBytes": group.apparent_bytes.to_string(),
                "digest": crate::content::hex(&group.digest),
                "files": group
                    .files
                    .iter()
                    .map(|file| json!({
                        "path": crate::base64::encode(&file.path),
                        "device": file.device.to_string(),
                        "inode": file.inode.to_string(),
                        "apparentBytes": file.apparent_bytes.to_string(),
                        "modifiedNanoseconds": file.modified_nanoseconds.to_string(),
                        "ownerId": file.owner_id.to_string(),
                        "groupId": file.group_id.to_string(),
                        "permissions": file.permissions,
                    }))
                    .collect::<Vec<Value>>(),
            }))
            .collect::<Vec<Value>>(),
        "complete": report.complete,
        "warnings": report.warnings,
        "candidatesRead": report.candidates_read.to_string(),
        "filesHashed": report.files_hashed.to_string(),
    })
}

fn trash(server: &Arc<Server>, responder: Responder, arguments: Map<String, Value>) {
    let arguments: TrashArguments = match decode(arguments) {
        Ok(arguments) => arguments,
        Err(message) => return fail(&responder, "invalid-arguments", &message),
    };
    let request = match trash_request(&arguments) {
        Ok(request) => request,
        Err(message) => return fail(&responder, "invalid-arguments", &message),
    };

    if let Err(message) = require_containment() {
        return fail(&responder, "unsupported-kernel", &message);
    }

    spawn_cancellable(
        server,
        responder,
        "trash",
        ACTION_ABANDONED,
        move |responder, cancelled| {
            report_action(
                responder,
                actions::run_trash(&request, &mut reporter(responder), cancelled),
            );
        },
    );
}

/// Replace every reviewed duplicate with a link to one kept file.
fn dedup_hardlink(server: &Arc<Server>, responder: Responder, arguments: Map<String, Value>) {
    let arguments: DedupHardlinkArguments = match decode(arguments) {
        Ok(arguments) => arguments,
        Err(message) => return fail(&responder, "invalid-arguments", &message),
    };
    let request = match dedup_hardlink_request(&arguments) {
        Ok(request) => request,
        Err(message) => return fail(&responder, "invalid-arguments", &message),
    };
    if let Err(message) = require_containment() {
        return fail(&responder, "unsupported-kernel", &message);
    }
    spawn_cancellable(
        server,
        responder,
        "dedup-hardlink",
        ACTION_ABANDONED,
        move |responder, cancelled| {
            report_action(
                responder,
                actions::run_dedup_hardlink(&request, &mut reporter(responder), cancelled),
            );
        },
    );
}

/// Remove every reviewed target permanently.
fn erase(server: &Arc<Server>, responder: Responder, arguments: Map<String, Value>) {
    let arguments: EraseArguments = match decode(arguments) {
        Ok(arguments) => arguments,
        Err(message) => return fail(&responder, "invalid-arguments", &message),
    };
    let request = match erase_request(&arguments) {
        Ok(request) => request,
        Err(message) => return fail(&responder, "invalid-arguments", &message),
    };
    if let Err(message) = require_containment() {
        return fail(&responder, "unsupported-kernel", &message);
    }
    spawn_cancellable(
        server,
        responder,
        "erase",
        ACTION_ABANDONED,
        move |responder, cancelled| {
            report_action(
                responder,
                actions::run_erase(&request, &mut reporter(responder), cancelled),
            );
        },
    );
}

/// Empty every directory that really is a Trash.
fn empty_trash(server: &Arc<Server>, responder: Responder, arguments: Map<String, Value>) {
    let arguments: EmptyTrashArguments = match decode(arguments) {
        Ok(arguments) => arguments,
        Err(message) => return fail(&responder, "invalid-arguments", &message),
    };
    let request = match empty_trash_request(&arguments) {
        Ok(request) => request,
        Err(message) => return fail(&responder, "invalid-arguments", &message),
    };
    if let Err(message) = require_containment() {
        return fail(&responder, "unsupported-kernel", &message);
    }
    spawn_cancellable(
        server,
        responder,
        "empty-trash",
        ACTION_ABANDONED,
        move |responder, cancelled| {
            report_action(
                responder,
                actions::run_empty_trash(&request, &mut reporter(responder), cancelled),
            );
        },
    );
}

/// Put back what a Trash move moved.
fn restore(server: &Arc<Server>, responder: Responder, arguments: Map<String, Value>) {
    let arguments: RestoreArguments = match decode(arguments) {
        Ok(arguments) => arguments,
        Err(message) => return fail(&responder, "invalid-arguments", &message),
    };
    let journal_directory = match decoded_directory(&arguments.journal_directory) {
        Ok(directory) => directory,
        Err(message) => return fail(&responder, "invalid-arguments", &message),
    };
    if !valid_request_id(&arguments.journal_id) {
        return fail(
            &responder,
            "invalid-arguments",
            "journalId must be an ID this journal issued",
        );
    }
    if let Err(message) = require_containment() {
        return fail(&responder, "unsupported-kernel", &message);
    }

    let request = actions::RestoreRequest {
        journal_directory,
        journal_id: arguments.journal_id,
    };
    spawn_cancellable(
        server,
        responder,
        "restore",
        ACTION_ABANDONED,
        move |responder, cancelled| {
            report_action(
                responder,
                actions::run_restore(&request, &mut reporter(responder), cancelled),
            );
        },
    );
}

fn require_containment() -> Result<(), String> {
    crate::sys::openat2_available().map_err(|error| {
        format!(
            "Changing a file needs openat2 containment, which this kernel refused: {error}. \
             There is no unsafe fallback."
        )
    })
}

/// Run one mutation on its own thread, registered for cancellation.
///
/// It runs off the reading thread for the same reason a scan does: somebody who
/// changes their mind halfway through a long list has to be able to say so, and
/// `cancel` can only be read while this is still going.
fn spawn_cancellable<F>(
    server: &Arc<Server>,
    responder: Responder,
    operation: &str,
    abandoned: &'static str,
    work: F,
) where
    F: FnOnce(&Responder, &AtomicBool) + Send + 'static,
{
    let cancelled = Arc::new(AtomicBool::new(false));
    registry(server).insert(responder.request_id.clone(), Arc::clone(&cancelled));
    responder.emit(
        "accepted",
        json!({ "accepted": { "operation": operation, "cancellable": true } }),
    );

    let owned = Arc::clone(server);
    let worker = std::thread::spawn(move || {
        let request_id = responder.request_id.clone();
        // A panicking worker still has to settle its request: a client waits
        // for a terminal event and has no timeout.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            work(&responder, &cancelled);
        }));
        if outcome.is_err() {
            fail(&responder, "internal-error", abandoned);
        }
        registry(&owned).remove(&request_id);
    });
    server.workers.lock().expect("workers").push(worker);
}

/// What a client reads when a worker panicked rather than settling its own
/// request. A mutation's journal is the thing a person needs pointed at.
const ACTION_ABANDONED: &str = "The action failed unexpectedly and was abandoned. The journal holds what it recorded \
     before that point.";

const SEARCH_ABANDONED: &str = "The search failed unexpectedly and was abandoned. Nothing was read beyond that point and \
     no file was changed.";

fn report_action(
    responder: &Responder,
    outcome: Result<actions::ActionSummary, actions::ActionRefusal>,
) {
    match outcome {
        Ok(summary) => responder.emit("complete", json!({ "result": action_result(&summary) })),
        Err(refusal) => fail(responder, refusal.code, &refusal.message),
    }
}

/// Turn each settled item into its own event, so a long action is legible
/// while it runs rather than only once it ends.
fn reporter(responder: &Responder) -> impl FnMut(actions::ItemReport) + '_ {
    |item: actions::ItemReport| {
        let mut body = Map::new();
        body.insert("path".to_owned(), crate::base64::encode(&item.path).into());
        body.insert("outcome".to_owned(), item_outcome(item.outcome).into());
        if let Some(reason) = item.reason {
            body.insert("reason".to_owned(), reason.into());
        }
        if let Some(message) = &item.message {
            body.insert("message".to_owned(), message.clone().into());
        }
        if item.bytes > 0 {
            body.insert("bytesMoved".to_owned(), item.bytes.to_string().into());
        }
        responder.emit("item-result", json!({ "itemResult": Value::Object(body) }));
    }
}

/// The journal's own vocabulary has an `uncertain` and an `in-progress` that no
/// item event ever carries: an event is emitted once the item has settled.
fn item_outcome(outcome: crate::journal::Outcome) -> &'static str {
    match outcome {
        crate::journal::Outcome::Completed => "completed",
        crate::journal::Outcome::Skipped => "skipped",
        _ => "failed",
    }
}

fn action_result(summary: &actions::ActionSummary) -> Value {
    let mut result = Map::new();
    result.insert("journalId".to_owned(), summary.journal_id.clone().into());
    result.insert("state".to_owned(), summary.state.as_str().into());
    result.insert("completed".to_owned(), summary.completed.to_string().into());
    result.insert("skipped".to_owned(), summary.skipped.to_string().into());
    result.insert("failed".to_owned(), summary.failed.to_string().into());
    result.insert(
        "selectedBytes".to_owned(),
        summary.selected_bytes.to_string().into(),
    );
    result.insert(
        "bytesMovedToTrash".to_owned(),
        summary.bytes_moved_to_trash.to_string().into(),
    );
    if let Some(before) = summary.free_bytes_before {
        result.insert("freeBytesBefore".to_owned(), before.to_string().into());
    }
    if let Some(after) = summary.free_bytes_after {
        result.insert("freeBytesAfter".to_owned(), after.to_string().into());
    }
    result.insert("undoAvailable".to_owned(), summary.undo_available.into());
    Value::Object(result)
}

fn trash_request(arguments: &TrashArguments) -> Result<TrashRequest, String> {
    if arguments.targets.is_empty() {
        return Err("A mutation needs at least one target".to_owned());
    }
    let journal_directory = PathBuf::from(OsStr::from_bytes(&decode_path(
        &arguments.journal_directory,
    )?));
    let home_trash_directory = decode_path(&arguments.home_trash_directory)?;
    if home_trash_directory.first() != Some(&b'/') {
        return Err("homeTrashDirectory must be an absolute path".to_owned());
    }

    Ok(TrashRequest {
        plan_id: arguments.plan_id.clone(),
        journal_directory,
        home_trash_directory,
        targets: decoded_targets(&arguments.targets)?,
    })
}

fn erase_request(arguments: &EraseArguments) -> Result<actions::EraseRequest, String> {
    if arguments.targets.is_empty() {
        return Err("A mutation needs at least one target".to_owned());
    }
    Ok(actions::EraseRequest {
        plan_id: arguments.plan_id.clone(),
        journal_directory: decoded_directory(&arguments.journal_directory)?,
        targets: decoded_targets(&arguments.targets)?,
    })
}

fn dedup_hardlink_request(
    arguments: &DedupHardlinkArguments,
) -> Result<actions::DedupHardlinkRequest, String> {
    if arguments.targets.is_empty() {
        return Err("A mutation needs at least one target".to_owned());
    }
    let keep = decoded_targets(std::slice::from_ref(&arguments.keep))?
        .pop()
        .expect("one target in, one target out");
    if arguments
        .targets
        .iter()
        .any(|target| target.path == arguments.keep.path)
    {
        return Err(
            "The file being kept cannot also be one of the files being replaced".to_owned(),
        );
    }
    Ok(actions::DedupHardlinkRequest {
        plan_id: arguments.plan_id.clone(),
        journal_directory: decoded_directory(&arguments.journal_directory)?,
        keep,
        targets: decoded_targets(&arguments.targets)?,
    })
}

fn empty_trash_request(
    arguments: &EmptyTrashArguments,
) -> Result<actions::EmptyTrashRequest, String> {
    if arguments.trash_directories.is_empty() {
        return Err("Emptying Trash needs at least one directory".to_owned());
    }
    let mut directories = Vec::with_capacity(arguments.trash_directories.len());
    for encoded in &arguments.trash_directories {
        let path = decode_path(encoded)?;
        if path.first() != Some(&b'/') {
            return Err("A Trash directory must be an absolute path".to_owned());
        }
        directories.push(path);
    }
    let home_trash_directory = decode_path(&arguments.home_trash_directory)?;
    if home_trash_directory.first() != Some(&b'/') {
        return Err("homeTrashDirectory must be an absolute path".to_owned());
    }
    Ok(actions::EmptyTrashRequest {
        plan_id: arguments.plan_id.clone(),
        journal_directory: decoded_directory(&arguments.journal_directory)?,
        home_trash_directory,
        trash_directories: directories,
    })
}

fn decoded_directory(encoded: &str) -> Result<PathBuf, String> {
    Ok(PathBuf::from(OsStr::from_bytes(&decode_path(encoded)?)))
}

fn decoded_targets(arguments: &[TargetArguments]) -> Result<Vec<actions::Target>, String> {
    let mut targets = Vec::with_capacity(arguments.len());
    for target in arguments {
        targets.push(actions::Target {
            path: decode_path(&target.path)?,
            expected: fingerprint(&target.expected)?,
            reviewed_bytes: optional_u64(target.reviewed_bytes.as_deref(), "reviewedBytes")?
                .unwrap_or(0),
        });
    }
    Ok(targets)
}

fn fingerprint(arguments: &FingerprintArguments) -> Result<Fingerprint, String> {
    let number = |value: &str, field: &str| {
        parse_u64(Some(value)).ok_or_else(|| format!("{field} must be a decimal integer"))
    };
    Ok(Fingerprint {
        device: number(&arguments.device, "device")?,
        inode: number(&arguments.inode, "inode")?,
        mount_id: number(&arguments.mount_id, "mountId")?,
        kind: match arguments.kind.as_str() {
            "file" => EntryKind::File,
            "directory" => EntryKind::Directory,
            "symlink" => EntryKind::Symlink,
            other => return Err(format!("A reviewed target cannot be of kind '{other}'")),
        },
        apparent_bytes: number(&arguments.apparent_bytes, "apparentBytes")?,
        modified_nanoseconds: number(&arguments.modified_nanoseconds, "modifiedNanoseconds")?,
    })
}

/// Resolve every record an interrupted run left behind, then answer with a
/// page of history.
///
/// Reconciling and listing are one operation on purpose: `docs/safety.md`
/// requires unfinished records to be resolved before undo is offered or an
/// action is called complete, and a caller that could list without reconciling
/// would be reading a history that still claims an abandoned action is running.
fn journal_reconcile(responder: &Responder, arguments: Map<String, Value>) {
    let arguments: JournalArguments = match decode(arguments) {
        Ok(arguments) => arguments,
        Err(message) => return fail(responder, "invalid-arguments", &message),
    };
    let directory = match decode_path(&arguments.journal_directory) {
        Ok(path) => PathBuf::from(OsStr::from_bytes(&path)),
        Err(message) => return fail(responder, "invalid-arguments", &message),
    };
    let limit = match optional_u64(arguments.limit.as_deref(), "limit") {
        Ok(limit) => limit.unwrap_or(50).min(u64::from(journal::MAX_LIMIT)) as u32,
        Err(message) => return fail(responder, "invalid-arguments", &message),
    };

    let journal = match Journal::open(&directory) {
        Ok(journal) => journal,
        Err(error) => {
            return fail(
                responder,
                "journal-write-failed",
                &format!("The action journal could not be opened: {error}"),
            );
        }
    };
    let reconciled = match journal.reconcile() {
        Ok(count) => count,
        Err(error) => {
            return fail(
                responder,
                "journal-write-failed",
                &format!("Interrupted records could not be resolved: {error}"),
            );
        }
    };
    let page = match journal.page(arguments.cursor.as_deref(), limit) {
        Ok(page) => page,
        Err(error) => {
            return fail(
                responder,
                "invalid-arguments",
                &format!("The journal could not be read: {error}"),
            );
        }
    };

    let mut result = Map::new();
    result.insert("reconciled".to_owned(), reconciled.to_string().into());
    result.insert(
        "records".to_owned(),
        Value::Array(page.records.iter().map(journal_record).collect()),
    );
    if let Some(cursor) = page.next_cursor {
        result.insert("nextCursor".to_owned(), cursor.into());
    }
    responder.emit("complete", json!({ "result": Value::Object(result) }));
}

pub fn journal_record(record: &journal::ActionRecord) -> Value {
    let mut object = Map::new();
    object.insert("id".to_owned(), record.id.clone().into());
    object.insert("planId".to_owned(), record.plan_id.clone().into());
    object.insert("operation".to_owned(), record.operation.clone().into());
    object.insert(
        "startedAtMilliseconds".to_owned(),
        record.started_at_milliseconds.to_string().into(),
    );
    if let Some(finished) = record.finished_at_milliseconds {
        object.insert(
            "finishedAtMilliseconds".to_owned(),
            finished.to_string().into(),
        );
    }
    object.insert("state".to_owned(), record.state.as_str().into());
    object.insert("completed".to_owned(), record.completed.to_string().into());
    object.insert("skipped".to_owned(), record.skipped.to_string().into());
    object.insert("failed".to_owned(), record.failed.to_string().into());
    object.insert(
        "selectedBytes".to_owned(),
        record.selected_bytes.to_string().into(),
    );
    object.insert(
        "bytesMovedToTrash".to_owned(),
        record.trashed_bytes.to_string().into(),
    );
    if let Some(before) = record.free_bytes_before {
        object.insert("freeBytesBefore".to_owned(), before.to_string().into());
    }
    if let Some(after) = record.free_bytes_after {
        object.insert("freeBytesAfter".to_owned(), after.to_string().into());
    }
    object.insert(
        "items".to_owned(),
        Value::Array(
            record
                .items
                .iter()
                .map(|item| {
                    let mut entry = Map::new();
                    entry.insert("position".to_owned(), item.position.to_string().into());
                    entry.insert("path".to_owned(), crate::base64::encode(&item.path).into());
                    if let Some(destination) = &item.destination {
                        entry.insert(
                            "destination".to_owned(),
                            crate::base64::encode(destination).into(),
                        );
                    }
                    entry.insert("outcome".to_owned(), item.outcome.as_str().into());
                    if let Some(reason) = &item.reason {
                        entry.insert("message".to_owned(), reason.clone().into());
                    }
                    entry.insert("bytes".to_owned(), item.bytes.to_string().into());
                    Value::Object(entry)
                })
                .collect(),
        ),
    );
    Value::Object(object)
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
            max_child_entries: optional_u64(
                filter.max_child_entries.as_deref(),
                "maxChildEntries",
            )?,
            broken: filter.broken,
        },
        sort,
        order,
        limit: limit.min(u64::from(query::MAX_LIMIT)) as u32,
        cursor: arguments.cursor.clone(),
        include_type_totals: arguments.include_type_totals.unwrap_or(false),
        include_owner_totals: arguments.include_owner_totals.unwrap_or(false),
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

    /// Parse whole lines only.
    ///
    /// `session` reads this buffer while the server thread is still writing to
    /// it, so the last line can be half an event. The real client has the same
    /// rule for the same reason: a message is a message once its newline
    /// arrives, and not before.
    fn parse(bytes: &[u8]) -> Vec<Value> {
        let complete = match bytes.iter().rposition(|byte| *byte == b'\n') {
            Some(last) => &bytes[..=last],
            None => &[][..],
        };
        complete
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
            json!([
                "hello",
                "probe",
                "cancel",
                "scan",
                "query-index",
                "hash-candidates",
                "trash",
                "erase",
                "empty-trash",
                "restore",
                "dedup-hardlink",
                "journal-reconcile"
            ])
        );
    }

    #[test]
    fn hash_candidates_answers_with_the_groups_it_found() {
        let sandbox = Sandbox::new("protocol-duplicates");
        sandbox.directory(b"index");
        std::fs::write(sandbox.path().join("a"), vec![5u8; 200_000]).unwrap();
        std::fs::write(sandbox.path().join("b"), vec![5u8; 200_000]).unwrap();
        std::fs::write(sandbox.path().join("c"), vec![6u8; 200_000]).unwrap();
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

        let events = session(
            &[format!(
                "{{\"protocolVersion\":1,\"requestId\":\"dup-1\",\
                  \"operation\":\"hash-candidates\",\
                  \"arguments\":{{\"scanId\":\"{scan_id}\",\"indexDirectory\":\"{}\"}}}}\n",
                crate::base64::encode(index_bytes),
            )],
            |events| terminal(events, "dup-1"),
        );

        let complete = events
            .iter()
            .find(|event| event["event"] == "complete")
            .expect("the search completes");
        assert_eq!(complete["result"]["complete"], true);
        let groups = complete["result"]["groups"].as_array().expect("groups");
        assert_eq!(groups.len(), 1, "only a and b hold the same bytes");
        assert_eq!(groups[0]["apparentBytes"], "200000");
        assert_eq!(groups[0]["files"].as_array().unwrap().len(), 2);
        assert_eq!(
            groups[0]["digest"].as_str().expect("a digest").len(),
            64,
            "a digest reads as hexadecimal, not as an array of numbers",
        );
        // Paths are base64 bytes on the wire, never display text.
        assert!(
            !groups[0]["files"][0]["path"]
                .as_str()
                .unwrap()
                .contains('/')
        );
    }

    #[test]
    fn journal_reconcile_answers_with_a_page_of_history() {
        let sandbox = crate::testing::Sandbox::new("protocol-journal");
        let directory = sandbox.directory(b"state");
        let output = responses(&format!(
            "{{\"protocolVersion\":1,\"requestId\":\"journal-1\",\
               \"operation\":\"journal-reconcile\",\
               \"arguments\":{{\"journalDirectory\":\"{}\"}}}}\n",
            crate::base64::encode(directory.as_os_str().as_bytes()),
        ));
        assert_eq!(output.len(), 1);
        assert_eq!(output[0]["event"], "complete");
        assert_eq!(output[0]["result"]["reconciled"], "0");
        assert_eq!(output[0]["result"]["records"], json!([]));
    }

    #[test]
    fn mutating_operation_is_explicitly_unsupported() {
        let output = responses(
            "{\"protocolVersion\":1,\"requestId\":\"compress-1\",\"operation\":\"compress\",\"arguments\":{}}\n",
        );
        assert_eq!(output[0]["event"], "error");
        assert_eq!(output[0]["requestId"], "compress-1");
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

    // --- Trash -------------------------------------------------------------

    /// The fingerprint a reviewed plan would have recorded for a live path.
    fn fingerprint(path: &[u8]) -> String {
        let parent = crate::guard::resolve_parent(path).expect("the path resolves");
        let live = crate::sys::metadata_at(parent.descriptor(), &parent.name).expect("it is there");
        format!(
            "{{\"device\":\"{}\",\"inode\":\"{}\",\"mountId\":\"{}\",\"kind\":\"{}\",\
              \"apparentBytes\":\"{}\",\"modifiedNanoseconds\":\"{}\"}}",
            live.device,
            live.inode,
            live.mount_id,
            live.kind.as_str(),
            live.apparent_bytes,
            live.modified_nanoseconds,
        )
    }

    fn target(path: &[u8], reviewed_bytes: u64) -> String {
        format!(
            "{{\"path\":\"{}\",\"expected\":{},\"reviewedBytes\":\"{reviewed_bytes}\"}}",
            crate::base64::encode(path),
            fingerprint(path),
        )
    }

    /// A `trash` request whose targets are already fingerprinted.
    fn trash_request(id: &str, sandbox: &Sandbox, targets: &[String]) -> String {
        let mut trash = sandbox.bytes();
        trash.extend_from_slice(b"/trash-home");
        let mut state = sandbox.bytes();
        state.extend_from_slice(b"/state");
        format!(
            "{{\"protocolVersion\":1,\"requestId\":\"{id}\",\"operation\":\"trash\",\
               \"arguments\":{{\"planId\":\"plan-0123456789abcd\",\
               \"journalDirectory\":\"{}\",\"homeTrashDirectory\":\"{}\",\
               \"targets\":[{}]}}}}\n",
            crate::base64::encode(&state),
            crate::base64::encode(&trash),
            targets.join(","),
        )
    }

    fn run_trash(id: &str, sandbox: &Sandbox, targets: &[String]) -> Vec<Value> {
        let request = trash_request(id, sandbox, targets);
        session(&[request], |events| terminal(events, id))
    }

    fn completion<'a>(events: &'a [Value], id: &str) -> &'a Value {
        events
            .iter()
            .find(|event| event["requestId"] == id && event["event"] == "complete")
            .unwrap_or_else(|| panic!("no completion for {id}: {events:?}"))
    }

    fn item_results<'a>(events: &'a [Value], id: &str) -> Vec<&'a Value> {
        events
            .iter()
            .filter(|event| event["requestId"] == id && event["event"] == "item-result")
            .collect()
    }

    #[test]
    fn a_reviewed_file_and_directory_move_into_trash_with_their_metadata() {
        let sandbox = Sandbox::new("trash-move");
        sandbox.directory(b"work");
        sandbox.file(b"work/keep.log", 2048);
        sandbox.directory(b"work/cache");
        sandbox.file(b"work/cache/blob", 1024);

        let mut file = sandbox.bytes();
        file.extend_from_slice(b"/work/keep.log");
        let mut directory = sandbox.bytes();
        directory.extend_from_slice(b"/work/cache");

        let events = run_trash(
            "trash-1",
            &sandbox,
            &[target(&file, 2048), target(&directory, 5120)],
        );
        let result = &completion(&events, "trash-1")["result"];

        assert!(!sandbox.path().join("work/keep.log").exists());
        assert!(!sandbox.path().join("work/cache").exists());
        assert!(sandbox.path().join("trash-home/files/keep.log").exists());
        assert!(sandbox.path().join("trash-home/files/cache/blob").exists());

        let info =
            std::fs::read_to_string(sandbox.path().join("trash-home/info/keep.log.trashinfo"))
                .expect("the metadata was written");
        assert!(info.starts_with("[Trash Info]\n"), "{info}");
        assert!(
            info.contains(&format!("Path={}", crate::actions::percent_encode(&file))),
            "{info}"
        );
        assert!(info.contains("DeletionDate="), "{info}");

        assert_eq!(result["completed"], "2");
        assert_eq!(result["skipped"], "0");
        assert_eq!(result["failed"], "0");
        assert_eq!(result["state"], "complete");
        assert_eq!(result["undoAvailable"], true);
        assert_eq!(result["selectedBytes"], "7168");
        assert_eq!(result["bytesMovedToTrash"], "7168");
        assert_eq!(item_results(&events, "trash-1").len(), 2);
    }

    #[test]
    fn moving_to_trash_reports_what_it_moved_apart_from_what_the_filesystem_shows() {
        let sandbox = Sandbox::new("trash-space");
        sandbox.directory(b"work");
        sandbox.file(b"work/big.bin", 256 * 1024);

        let mut file = sandbox.bytes();
        file.extend_from_slice(b"/work/big.bin");
        let events = run_trash("trash-2", &sandbox, &[target(&file, 262_144)]);
        let result = &completion(&events, "trash-2")["result"];

        assert_eq!(result["bytesMovedToTrash"], "262144");
        let before: u64 = result["freeBytesBefore"].as_str().unwrap().parse().unwrap();
        let after: u64 = result["freeBytesAfter"].as_str().unwrap().parse().unwrap();
        // Same filesystem, so the rename gave nothing back. The two numbers are
        // reported separately precisely so this is visible rather than implied.
        assert!(
            after.abs_diff(before) < 262_144,
            "a Trash move on one filesystem frees nothing: {before} -> {after}"
        );
    }

    #[test]
    fn a_second_file_of_the_same_name_lands_beside_the_first() {
        let sandbox = Sandbox::new("trash-collision");
        sandbox.directory(b"one");
        sandbox.directory(b"two");
        sandbox.file(b"one/notes.txt", 16);
        sandbox.file(b"two/notes.txt", 32);

        let mut first = sandbox.bytes();
        first.extend_from_slice(b"/one/notes.txt");
        run_trash("trash-3", &sandbox, &[target(&first, 16)]);

        let mut second = sandbox.bytes();
        second.extend_from_slice(b"/two/notes.txt");
        let events = run_trash("trash-4", &sandbox, &[target(&second, 32)]);
        assert_eq!(completion(&events, "trash-4")["result"]["completed"], "1");

        let files = sandbox.path().join("trash-home/files");
        let names: Vec<String> = std::fs::read_dir(&files)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 2, "both files are in Trash: {names:?}");
        assert_eq!(
            std::fs::metadata(files.join("notes.txt")).unwrap().len(),
            16,
            "the first file was not overwritten"
        );
    }

    #[test]
    fn a_target_that_changed_since_review_is_skipped_rather_than_trashed() {
        let sandbox = Sandbox::new("trash-changed");
        sandbox.directory(b"work");
        let path = sandbox.file(b"work/data.bin", 512);

        let mut file = sandbox.bytes();
        file.extend_from_slice(b"/work/data.bin");
        let reviewed = target(&file, 512);

        std::fs::write(&path, vec![b'y'; 4096]).unwrap();

        let events = run_trash("trash-5", &sandbox, &[reviewed]);
        let result = &completion(&events, "trash-5")["result"];
        assert_eq!(result["skipped"], "1");
        assert_eq!(result["completed"], "0");
        assert_eq!(result["state"], "partial");
        assert!(path.exists(), "a changed target is left alone");

        let item = item_results(&events, "trash-5")[0];
        assert_eq!(item["itemResult"]["outcome"], "skipped");
        assert_eq!(item["itemResult"]["reason"], "changed-target");
    }

    #[test]
    fn a_protected_root_is_refused_whatever_the_plan_says() {
        let sandbox = Sandbox::new("trash-protected");
        let fake = format!(
            "{{\"path\":\"{}\",\"expected\":{{\"device\":\"1\",\"inode\":\"2\",\"mountId\":\"3\",\
               \"kind\":\"file\",\"apparentBytes\":\"4\",\"modifiedNanoseconds\":\"5\"}}}}",
            crate::base64::encode(b"/etc/passwd"),
        );
        let events = run_trash("trash-6", &sandbox, &[fake]);
        let result = &completion(&events, "trash-6")["result"];
        assert_eq!(result["failed"], "1");
        assert_eq!(result["completed"], "0");
        assert!(std::path::Path::new("/etc/passwd").exists());

        let item = item_results(&events, "trash-6")[0];
        assert_eq!(item["itemResult"]["reason"], "protected-path");
    }

    #[test]
    fn every_trashed_item_leaves_a_journal_record_behind() {
        let sandbox = Sandbox::new("trash-journal");
        sandbox.directory(b"work");
        sandbox.file(b"work/one.bin", 64);
        let mut file = sandbox.bytes();
        file.extend_from_slice(b"/work/one.bin");

        let events = run_trash("trash-7", &sandbox, &[target(&file, 64)]);
        let journal_id = completion(&events, "trash-7")["result"]["journalId"]
            .as_str()
            .expect("a completed action names its journal record")
            .to_owned();

        let mut state = sandbox.bytes();
        state.extend_from_slice(b"/state");
        let page = responses(&format!(
            "{{\"protocolVersion\":1,\"requestId\":\"journal-9\",\
               \"operation\":\"journal-reconcile\",\
               \"arguments\":{{\"journalDirectory\":\"{}\"}}}}\n",
            crate::base64::encode(&state),
        ));
        let records = page[0]["result"]["records"].as_array().unwrap();
        let record = records
            .iter()
            .find(|record| record["id"] == journal_id.as_str())
            .expect("the action is in the journal");
        assert_eq!(record["operation"], "trash");
        assert_eq!(record["state"], "complete");
        assert_eq!(record["items"].as_array().unwrap().len(), 1);
        assert_eq!(record["items"][0]["outcome"], "completed");
        assert!(record["items"][0]["destination"].is_string());
    }

    // --- Replacing a duplicate with a hardlink ------------------------------

    fn hardlink_request(id: &str, sandbox: &Sandbox, keep: &[u8], targets: &[String]) -> String {
        let mut state = sandbox.bytes();
        state.extend_from_slice(b"/state");
        format!(
            "{{\"protocolVersion\":1,\"requestId\":\"{id}\",\"operation\":\"dedup-hardlink\",\
               \"arguments\":{{\"planId\":\"plan-0123456789abcd\",\
               \"journalDirectory\":\"{}\",\"keep\":{},\"targets\":[{}]}}}}\n",
            crate::base64::encode(&state),
            target(keep, 0),
            targets.join(","),
        )
    }

    fn run_hardlink(id: &str, sandbox: &Sandbox, keep: &[u8], targets: &[String]) -> Vec<Value> {
        session(&[hardlink_request(id, sandbox, keep, targets)], |events| {
            terminal(events, id)
        })
    }

    /// Two paths and whether they are the same inode now.
    fn same_inode(left: &std::path::Path, right: &std::path::Path) -> bool {
        use std::os::unix::fs::MetadataExt;
        let left = std::fs::metadata(left).expect("left exists");
        let right = std::fs::metadata(right).expect("right exists");
        left.dev() == right.dev() && left.ino() == right.ino()
    }

    fn link_count(path: &std::path::Path) -> u64 {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(path).expect("the file exists").nlink()
    }

    #[test]
    fn a_duplicate_is_replaced_by_a_link_to_the_file_being_kept() {
        let sandbox = Sandbox::new("hardlink-happy");
        sandbox.directory(b"state");
        let content = vec![9u8; 100_000];
        std::fs::write(sandbox.path().join("keep.bin"), &content).unwrap();
        std::fs::write(sandbox.path().join("copy.bin"), &content).unwrap();

        let mut keep = sandbox.bytes();
        keep.extend_from_slice(b"/keep.bin");
        let mut copy = sandbox.bytes();
        copy.extend_from_slice(b"/copy.bin");

        let events = run_hardlink("link-1", &sandbox, &keep, &[target(&copy, 100_000)]);
        let result = &completion(&events, "link-1")["result"];

        assert_eq!(result["state"], "complete");
        assert_eq!(result["completed"], "1");
        assert_eq!(
            result["bytesMovedToTrash"], "0",
            "nothing went to Trash, so nothing can be put back",
        );
        assert_eq!(result["undoAvailable"], false);

        let keep_path = sandbox.path().join("keep.bin");
        let copy_path = sandbox.path().join("copy.bin");
        assert!(
            same_inode(&keep_path, &copy_path),
            "both names reach one inode"
        );
        assert_eq!(link_count(&keep_path), 2);
        assert_eq!(
            std::fs::read(&copy_path).unwrap(),
            content,
            "the bytes under the replaced name are the bytes that were there",
        );
    }

    #[test]
    fn a_file_whose_bytes_differ_is_refused_however_the_sizes_match() {
        let sandbox = Sandbox::new("hardlink-different");
        sandbox.directory(b"state");
        let mut other = vec![9u8; 100_000];
        other[50_000] = 1;
        std::fs::write(sandbox.path().join("keep.bin"), vec![9u8; 100_000]).unwrap();
        std::fs::write(sandbox.path().join("copy.bin"), &other).unwrap();

        let mut keep = sandbox.bytes();
        keep.extend_from_slice(b"/keep.bin");
        let mut copy = sandbox.bytes();
        copy.extend_from_slice(b"/copy.bin");

        let events = run_hardlink("link-2", &sandbox, &keep, &[target(&copy, 100_000)]);
        let items = item_results(&events, "link-2");

        assert_eq!(items[0]["itemResult"]["outcome"], "failed");
        assert_eq!(items[0]["itemResult"]["reason"], "content-changed");
        assert_eq!(
            std::fs::read(sandbox.path().join("copy.bin")).unwrap(),
            other,
            "the file nobody proved identical is untouched",
        );
        assert!(!same_inode(
            &sandbox.path().join("keep.bin"),
            &sandbox.path().join("copy.bin"),
        ));
    }

    #[test]
    fn a_file_with_different_permissions_is_refused_rather_than_silently_regraded() {
        let sandbox = Sandbox::new("hardlink-mode");
        sandbox.directory(b"state");
        let content = vec![3u8; 50_000];
        std::fs::write(sandbox.path().join("keep.bin"), &content).unwrap();
        std::fs::write(sandbox.path().join("copy.bin"), &content).unwrap();
        sandbox.chmod(b"copy.bin", 0o600);
        sandbox.chmod(b"keep.bin", 0o644);

        let mut keep = sandbox.bytes();
        keep.extend_from_slice(b"/keep.bin");
        let mut copy = sandbox.bytes();
        copy.extend_from_slice(b"/copy.bin");

        let events = run_hardlink("link-3", &sandbox, &keep, &[target(&copy, 50_000)]);
        let items = item_results(&events, "link-3");

        assert_eq!(items[0]["itemResult"]["outcome"], "failed");
        assert_eq!(items[0]["itemResult"]["reason"], "metadata-incompatible");
        assert!(!same_inode(
            &sandbox.path().join("keep.bin"),
            &sandbox.path().join("copy.bin"),
        ));
    }

    #[test]
    fn a_name_that_already_reaches_the_kept_inode_is_skipped_and_frees_nothing() {
        let sandbox = Sandbox::new("hardlink-already");
        sandbox.directory(b"state");
        std::fs::write(sandbox.path().join("keep.bin"), vec![4u8; 20_000]).unwrap();
        sandbox.hardlink(b"keep.bin", b"copy.bin");

        let mut keep = sandbox.bytes();
        keep.extend_from_slice(b"/keep.bin");
        let mut copy = sandbox.bytes();
        copy.extend_from_slice(b"/copy.bin");

        let events = run_hardlink("link-4", &sandbox, &keep, &[target(&copy, 20_000)]);
        let items = item_results(&events, "link-4");
        let result = &completion(&events, "link-4")["result"];

        assert_eq!(items[0]["itemResult"]["outcome"], "skipped");
        assert_eq!(items[0]["itemResult"]["reason"], "already-linked");
        assert_eq!(result["completed"], "0");
        assert_eq!(result["skipped"], "1");
        assert_eq!(link_count(&sandbox.path().join("keep.bin")), 2);
    }

    #[test]
    fn a_changed_file_is_skipped_rather_than_replaced() {
        let sandbox = Sandbox::new("hardlink-changed");
        sandbox.directory(b"state");
        let content = vec![5u8; 30_000];
        std::fs::write(sandbox.path().join("keep.bin"), &content).unwrap();
        std::fs::write(sandbox.path().join("copy.bin"), &content).unwrap();

        let mut keep = sandbox.bytes();
        keep.extend_from_slice(b"/keep.bin");
        let mut copy = sandbox.bytes();
        copy.extend_from_slice(b"/copy.bin");
        let reviewed = target(&copy, 30_000);

        // The plan was reviewed; then the file changed under it.
        std::fs::write(sandbox.path().join("copy.bin"), vec![6u8; 30_000]).unwrap();

        let events = run_hardlink("link-5", &sandbox, &keep, &[reviewed]);
        let items = item_results(&events, "link-5");

        assert_eq!(items[0]["itemResult"]["outcome"], "skipped");
        assert_eq!(items[0]["itemResult"]["reason"], "changed-target");
        assert_eq!(
            std::fs::read(sandbox.path().join("copy.bin")).unwrap(),
            vec![6u8; 30_000]
        );
    }

    #[test]
    fn a_kept_file_that_changed_since_review_refuses_the_whole_request() {
        let sandbox = Sandbox::new("hardlink-keep-changed");
        sandbox.directory(b"state");
        let content = vec![7u8; 10_000];
        std::fs::write(sandbox.path().join("keep.bin"), &content).unwrap();
        std::fs::write(sandbox.path().join("copy.bin"), &content).unwrap();

        let mut keep = sandbox.bytes();
        keep.extend_from_slice(b"/keep.bin");
        let mut copy = sandbox.bytes();
        copy.extend_from_slice(b"/copy.bin");
        let request = hardlink_request("link-6", &sandbox, &keep, &[target(&copy, 10_000)]);

        std::fs::write(sandbox.path().join("keep.bin"), vec![8u8; 10_000]).unwrap();

        let events = session(&[request], |events| terminal(events, "link-6"));
        let error = events
            .iter()
            .find(|event| event["event"] == "error")
            .expect("the request is refused as a whole");

        assert_eq!(error["error"]["code"], "changed-target");
        assert!(!same_inode(
            &sandbox.path().join("keep.bin"),
            &sandbox.path().join("copy.bin"),
        ));
    }

    #[test]
    fn a_protected_target_is_refused_before_anything_is_linked() {
        let sandbox = Sandbox::new("hardlink-protected");
        sandbox.directory(b"state");
        std::fs::write(sandbox.path().join("keep.bin"), vec![1u8; 1000]).unwrap();
        std::fs::write(sandbox.path().join("copy.bin"), vec![1u8; 1000]).unwrap();

        let mut keep = sandbox.bytes();
        keep.extend_from_slice(b"/keep.bin");
        let mut copy = sandbox.bytes();
        copy.extend_from_slice(b"/copy.bin");
        let fingerprinted = target(&copy, 1000);
        let protected = fingerprinted.replace(
            &crate::base64::encode(&copy),
            &crate::base64::encode(b"/etc/passwd"),
        );

        let events = run_hardlink("link-7", &sandbox, &keep, &[protected]);
        let items = item_results(&events, "link-7");

        assert_eq!(items[0]["itemResult"]["outcome"], "failed");
        assert_eq!(items[0]["itemResult"]["reason"], "protected-path");
    }

    #[test]
    fn a_replaced_duplicate_leaves_no_staging_name_behind() {
        let sandbox = Sandbox::new("hardlink-staging");
        sandbox.directory(b"state");
        let content = vec![2u8; 40_000];
        std::fs::write(sandbox.path().join("keep.bin"), &content).unwrap();
        std::fs::write(sandbox.path().join("copy.bin"), &content).unwrap();

        let mut keep = sandbox.bytes();
        keep.extend_from_slice(b"/keep.bin");
        let mut copy = sandbox.bytes();
        copy.extend_from_slice(b"/copy.bin");

        run_hardlink("link-8", &sandbox, &keep, &[target(&copy, 40_000)]);

        let leftovers: Vec<String> = std::fs::read_dir(sandbox.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".disktop-link"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "staging names were left behind: {leftovers:?}"
        );
    }

    // --- Erase and emptying Trash -------------------------------------------

    fn erase_request(id: &str, sandbox: &Sandbox, targets: &[String]) -> String {
        let mut state = sandbox.bytes();
        state.extend_from_slice(b"/state");
        format!(
            "{{\"protocolVersion\":1,\"requestId\":\"{id}\",\"operation\":\"erase\",\
               \"arguments\":{{\"planId\":\"plan-0123456789abcd\",\
               \"journalDirectory\":\"{}\",\"targets\":[{}]}}}}\n",
            crate::base64::encode(&state),
            targets.join(","),
        )
    }

    fn run_erase(id: &str, sandbox: &Sandbox, targets: &[String]) -> Vec<Value> {
        session(&[erase_request(id, sandbox, targets)], |events| {
            terminal(events, id)
        })
    }

    #[test]
    fn erasing_removes_a_file_and_a_whole_directory_tree() {
        let sandbox = Sandbox::new("erase-tree");
        sandbox.directory(b"work");
        sandbox.file(b"work/one.bin", 64);
        sandbox.directory(b"work/tree");
        sandbox.directory(b"work/tree/deep");
        sandbox.file(b"work/tree/deep/leaf", 32);
        sandbox.file(b"work/tree/top", 16);

        let mut file = sandbox.bytes();
        file.extend_from_slice(b"/work/one.bin");
        let mut tree = sandbox.bytes();
        tree.extend_from_slice(b"/work/tree");

        let events = run_erase(
            "erase-1",
            &sandbox,
            &[target(&file, 64), target(&tree, 112)],
        );
        let result = &completion(&events, "erase-1")["result"];

        assert_eq!(result["completed"], "2");
        assert_eq!(result["state"], "complete");
        assert_eq!(result["bytesMovedToTrash"], "0", "nothing went to Trash");
        assert_eq!(result["undoAvailable"], false, "erasing cannot be undone");
        assert!(!sandbox.path().join("work/one.bin").exists());
        assert!(!sandbox.path().join("work/tree").exists());
        assert!(
            sandbox.path().join("work").exists(),
            "only what was named went"
        );
    }

    #[test]
    fn erasing_removes_a_symlink_without_touching_what_it_points_at() {
        let sandbox = Sandbox::new("erase-symlink");
        sandbox.directory(b"work");
        sandbox.file(b"work/real.bin", 16);
        sandbox.directory(b"work/holder");
        sandbox.symlink(b"../real.bin", b"work/holder/alias");

        let mut holder = sandbox.bytes();
        holder.extend_from_slice(b"/work/holder");
        let events = run_erase("erase-2", &sandbox, &[target(&holder, 4096)]);

        assert_eq!(completion(&events, "erase-2")["result"]["completed"], "1");
        assert!(!sandbox.path().join("work/holder").exists());
        assert!(
            sandbox.path().join("work/real.bin").exists(),
            "a link is removed as a link, never followed"
        );
    }

    #[test]
    fn erasing_refuses_a_protected_root_and_skips_a_changed_target() {
        let sandbox = Sandbox::new("erase-refusals");
        sandbox.directory(b"work");
        let path = sandbox.file(b"work/data.bin", 128);
        let mut file = sandbox.bytes();
        file.extend_from_slice(b"/work/data.bin");
        let reviewed = target(&file, 128);
        std::fs::write(&path, vec![b'z'; 4096]).unwrap();

        let protected = format!(
            "{{\"path\":\"{}\",\"expected\":{{\"device\":\"1\",\"inode\":\"2\",\"mountId\":\"3\",\
               \"kind\":\"directory\",\"apparentBytes\":\"4\",\"modifiedNanoseconds\":\"5\"}}}}",
            crate::base64::encode(b"/usr/lib"),
        );

        let events = run_erase("erase-3", &sandbox, &[reviewed, protected]);
        let result = &completion(&events, "erase-3")["result"];
        assert_eq!(result["skipped"], "1");
        assert_eq!(result["failed"], "1");
        assert_eq!(result["completed"], "0");
        assert_eq!(result["state"], "partial");
        assert!(path.exists(), "a changed target is left alone");
        assert!(std::path::Path::new("/usr/lib").exists());
    }

    #[test]
    fn a_directory_something_was_added_to_since_review_is_not_erased() {
        let sandbox = Sandbox::new("erase-addition");
        sandbox.directory(b"work");
        sandbox.directory(b"work/cache");
        sandbox.file(b"work/cache/old", 16);

        let mut directory = sandbox.bytes();
        directory.extend_from_slice(b"/work/cache");
        let reviewed = target(&directory, 4096);

        // Something lands in the reviewed directory after review. Its
        // modification time is what makes that visible.
        sandbox.file(b"work/cache/new", 16);

        let events = run_erase("erase-4", &sandbox, &[reviewed]);
        assert_eq!(completion(&events, "erase-4")["result"]["skipped"], "1");
        assert!(sandbox.path().join("work/cache/new").exists());
        assert!(sandbox.path().join("work/cache/old").exists());
    }

    fn empty_trash_request(id: &str, sandbox: &Sandbox, directories: &[Vec<u8>]) -> String {
        let mut state = sandbox.bytes();
        state.extend_from_slice(b"/state");
        let encoded: Vec<String> = directories
            .iter()
            .map(|directory| format!("\"{}\"", crate::base64::encode(directory)))
            .collect();
        let mut home_trash = sandbox.bytes();
        home_trash.extend_from_slice(b"/trash-home");
        format!(
            "{{\"protocolVersion\":1,\"requestId\":\"{id}\",\"operation\":\"empty-trash\",\
               \"arguments\":{{\"planId\":\"plan-0123456789abcd\",\
               \"journalDirectory\":\"{}\",\"homeTrashDirectory\":\"{}\",\
               \"trashDirectories\":[{}]}}}}\n",
            crate::base64::encode(&state),
            crate::base64::encode(&home_trash),
            encoded.join(","),
        )
    }

    #[test]
    fn emptying_trash_removes_what_is_in_it_and_frees_the_space_the_move_did_not() {
        let sandbox = Sandbox::new("empty-trash");
        sandbox.directory(b"work");
        sandbox.file(b"work/one.bin", 64 * 1024);
        let mut file = sandbox.bytes();
        file.extend_from_slice(b"/work/one.bin");
        run_trash("trash-20", &sandbox, &[target(&file, 65536)]);
        assert!(sandbox.path().join("trash-home/files/one.bin").exists());

        let mut trash = sandbox.bytes();
        trash.extend_from_slice(b"/trash-home");
        let events = session(
            &[empty_trash_request("empty-1", &sandbox, &[trash])],
            |events| terminal(events, "empty-1"),
        );
        let result = &completion(&events, "empty-1")["result"];

        assert_eq!(result["state"], "complete");
        assert_eq!(result["undoAvailable"], false);
        assert!(!sandbox.path().join("trash-home/files/one.bin").exists());
        assert!(
            !sandbox
                .path()
                .join("trash-home/info/one.bin.trashinfo")
                .exists()
        );
        assert!(
            sandbox.path().join("trash-home/files").exists(),
            "the Trash itself stays; only its contents go"
        );
    }

    #[test]
    fn a_directory_that_is_not_a_trash_is_refused_by_empty_trash() {
        let sandbox = Sandbox::new("empty-not-trash");
        sandbox.directory(b"documents");
        sandbox.file(b"documents/thesis.txt", 4096);

        let mut directory = sandbox.bytes();
        directory.extend_from_slice(b"/documents");
        let events = session(
            &[empty_trash_request("empty-2", &sandbox, &[directory])],
            |events| terminal(events, "empty-2"),
        );
        let result = &completion(&events, "empty-2")["result"];
        assert_eq!(result["failed"], "1");
        assert_eq!(result["completed"], "0");
        assert!(sandbox.path().join("documents/thesis.txt").exists());

        let item = item_results(&events, "empty-2")[0];
        assert_eq!(item["itemResult"]["reason"], "protected-path");
    }

    // --- Restore -------------------------------------------------------------

    fn restore_request(id: &str, sandbox: &Sandbox, journal_id: &str) -> String {
        let mut state = sandbox.bytes();
        state.extend_from_slice(b"/state");
        format!(
            "{{\"protocolVersion\":1,\"requestId\":\"{id}\",\"operation\":\"restore\",\
               \"arguments\":{{\"journalDirectory\":\"{}\",\"journalId\":\"{journal_id}\"}}}}\n",
            crate::base64::encode(&state),
        )
    }

    fn run_restore(id: &str, sandbox: &Sandbox, journal_id: &str) -> Vec<Value> {
        session(&[restore_request(id, sandbox, journal_id)], |events| {
            terminal(events, id)
        })
    }

    fn journal_id_of(events: &[Value], request_id: &str) -> String {
        completion(events, request_id)["result"]["journalId"]
            .as_str()
            .expect("a completed action names its journal record")
            .to_owned()
    }

    #[test]
    fn restoring_puts_every_trashed_file_back_where_it_came_from() {
        let sandbox = Sandbox::new("restore-roundtrip");
        sandbox.directory(b"work");
        sandbox.file(b"work/one.bin", 64);
        sandbox.directory(b"work/cache");
        sandbox.file(b"work/cache/blob", 32);

        let mut file = sandbox.bytes();
        file.extend_from_slice(b"/work/one.bin");
        let mut directory = sandbox.bytes();
        directory.extend_from_slice(b"/work/cache");

        let trashed = run_trash(
            "trash-30",
            &sandbox,
            &[target(&file, 64), target(&directory, 4096)],
        );
        let journal_id = journal_id_of(&trashed, "trash-30");
        assert!(!sandbox.path().join("work/one.bin").exists());

        let events = run_restore("restore-1", &sandbox, &journal_id);
        let result = &completion(&events, "restore-1")["result"];

        assert_eq!(result["completed"], "2");
        assert_eq!(result["state"], "complete");
        assert_eq!(
            result["undoAvailable"], false,
            "an undo is not itself undoable"
        );
        assert!(sandbox.path().join("work/one.bin").exists());
        assert!(sandbox.path().join("work/cache/blob").exists());
        assert!(
            !sandbox.path().join("trash-home/files/one.bin").exists(),
            "what came back is no longer in Trash"
        );
        assert!(
            !sandbox
                .path()
                .join("trash-home/info/one.bin.trashinfo")
                .exists(),
            "its metadata goes with it"
        );
    }

    #[test]
    fn restoring_a_name_something_else_now_occupies_leaves_the_new_file_alone() {
        let sandbox = Sandbox::new("restore-collision");
        sandbox.directory(b"work");
        sandbox.file(b"work/notes.txt", 16);
        let mut file = sandbox.bytes();
        file.extend_from_slice(b"/work/notes.txt");

        let trashed = run_trash("trash-31", &sandbox, &[target(&file, 16)]);
        let journal_id = journal_id_of(&trashed, "trash-31");

        // Somebody writes a new file at the original path before the undo.
        sandbox.file(b"work/notes.txt", 999);

        let events = run_restore("restore-2", &sandbox, &journal_id);
        let result = &completion(&events, "restore-2")["result"];
        assert_eq!(result["skipped"], "1");
        assert_eq!(result["completed"], "0");
        assert_eq!(result["state"], "partial");
        assert_eq!(
            std::fs::metadata(sandbox.path().join("work/notes.txt"))
                .unwrap()
                .len(),
            999,
            "the newer file is never overwritten"
        );
        assert!(sandbox.path().join("trash-home/files/notes.txt").exists());

        let item = item_results(&events, "restore-2")[0];
        assert_eq!(item["itemResult"]["reason"], "changed-target");
    }

    #[test]
    fn restoring_the_same_record_twice_finds_nothing_left_to_put_back() {
        let sandbox = Sandbox::new("restore-twice");
        sandbox.directory(b"work");
        sandbox.file(b"work/one.bin", 16);
        let mut file = sandbox.bytes();
        file.extend_from_slice(b"/work/one.bin");

        let trashed = run_trash("trash-32", &sandbox, &[target(&file, 16)]);
        let journal_id = journal_id_of(&trashed, "trash-32");

        run_restore("restore-3", &sandbox, &journal_id);
        let events = run_restore("restore-4", &sandbox, &journal_id);
        let result = &completion(&events, "restore-4")["result"];
        assert_eq!(result["completed"], "0");
        assert_eq!(result["skipped"], "1");
        assert!(sandbox.path().join("work/one.bin").exists());
    }

    #[test]
    fn a_record_that_removed_things_permanently_has_nothing_to_restore() {
        let sandbox = Sandbox::new("restore-erase");
        sandbox.directory(b"work");
        sandbox.file(b"work/gone.bin", 16);
        let mut file = sandbox.bytes();
        file.extend_from_slice(b"/work/gone.bin");

        let erased = run_erase("erase-30", &sandbox, &[target(&file, 16)]);
        let journal_id = journal_id_of(&erased, "erase-30");

        let events = run_restore("restore-5", &sandbox, &journal_id);
        let event = &events
            .iter()
            .find(|event| event["requestId"] == "restore-5" && event["event"] == "error")
            .expect("restoring a permanent removal is refused");
        assert_eq!(event["error"]["code"], "invalid-arguments");
    }

    #[test]
    fn an_unknown_journal_record_is_refused_by_name() {
        let sandbox = Sandbox::new("restore-unknown");
        sandbox.directory(b"state");
        let events = run_restore("restore-6", &sandbox, "act-0-deadbeefdeadbeef");
        let event = &events
            .iter()
            .find(|event| event["requestId"] == "restore-6" && event["event"] == "error")
            .expect("an unknown record is refused");
        assert_eq!(event["error"]["code"], "unknown-request");
    }

    #[test]
    fn an_undo_refuses_a_name_that_now_holds_something_else_entirely() {
        let sandbox = Sandbox::new("restore-identity");
        sandbox.directory(b"work");
        sandbox.file(b"work/notes.txt", 32);
        let mut file = sandbox.bytes();
        file.extend_from_slice(b"/work/notes.txt");

        let trashed = run_trash("trash-40", &sandbox, &[target(&file, 32)]);
        let journal_id = journal_id_of(&trashed, "trash-40");

        // Something else takes the name in Trash: a file manager put the
        // original back by hand, and a different file of the same name landed
        // where it used to be.
        let trashed_path = sandbox.path().join("trash-home/files/notes.txt");
        std::fs::remove_file(&trashed_path).unwrap();
        std::fs::write(&trashed_path, "a completely different file").unwrap();

        let events = run_restore("restore-10", &sandbox, &journal_id);
        let result = &completion(&events, "restore-10")["result"];
        assert_eq!(result["completed"], "0");
        assert_eq!(result["skipped"], "1");
        assert_eq!(
            std::fs::read_to_string(&trashed_path).unwrap(),
            "a completely different file",
            "the stranger in Trash was left exactly where it was",
        );
        assert!(
            !sandbox.path().join("work/notes.txt").exists(),
            "and it was not moved to a path it never came from",
        );

        let item = item_results(&events, "restore-10")[0];
        assert_eq!(item["itemResult"]["reason"], "changed-target");
    }

    #[test]
    fn emptying_refuses_a_directory_that_is_not_one_of_this_users_trashes() {
        let sandbox = Sandbox::new("empty-foreign");
        // The shape of a Trash, in a place no Trash belongs.
        sandbox.directory(b"data/files");
        sandbox.directory(b"data/info");
        sandbox.file(b"data/files/thesis.txt", 4096);

        let mut directory = sandbox.bytes();
        directory.extend_from_slice(b"/data");
        let events = session(
            &[empty_trash_request("empty-10", &sandbox, &[directory])],
            |events| terminal(events, "empty-10"),
        );
        let result = &completion(&events, "empty-10")["result"];
        assert_eq!(result["failed"], "1");
        assert!(sandbox.path().join("data/files/thesis.txt").exists());
        assert_eq!(
            item_results(&events, "empty-10")[0]["itemResult"]["reason"],
            "protected-path"
        );
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
