//! Versioned JSON-lines boundary for the filesystem helper.
//!
//! Only handshake and capability probing are implemented in this scaffold.
//! Every other planned operation returns an explicit error; none can mutate
//! files until the reviewed plan, guard, and journal exist.

use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::io::{self, BufRead, Write};

const PROTOCOL_VERSION: u16 = 1;
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const SUPPORTED_OPERATIONS: [&str; 2] = ["hello", "probe"];
const PLANNED_OPERATIONS: [&str; 15] = [
    "scan",
    "query-index",
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

enum InputLine {
    Bytes(Vec<u8>),
    TooLong,
}

pub fn serve<R: BufRead, W: Write>(mut input: R, mut output: W) -> io::Result<()> {
    while let Some(line) = read_line(&mut input)? {
        let response = match line {
            InputLine::Bytes(bytes) => handle_request(&bytes),
            InputLine::TooLong => error(None, "request-too-large", "Request exceeds 1 MiB"),
        };

        serde_json::to_writer(&mut output, &response).map_err(io::Error::other)?;
        output.write_all(b"\n")?;
        output.flush()?;
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

fn handle_request(line: &[u8]) -> Value {
    let request: Request = match serde_json::from_slice(line) {
        Ok(request) => request,
        Err(parse_error) => {
            let request_id = salvage_request_id(line);
            return error(
                request_id.as_deref(),
                "invalid-request",
                &format!("Invalid request: {parse_error}"),
            );
        }
    };

    if !valid_request_id(&request.request_id) {
        return error(
            None,
            "invalid-request-id",
            "requestId must be 1 to 128 ASCII letters, digits, '.', '-', or '_'",
        );
    }

    let request_id = Some(request.request_id.as_str());
    if request.protocol_version != PROTOCOL_VERSION {
        return error(
            request_id,
            "unsupported-protocol-version",
            "The helper supports protocol version 1",
        );
    }

    match request.operation.as_str() {
        "hello" | "probe" if request.arguments.is_empty() => complete(
            &request.request_id,
            json!({
                "helperVersion": env!("CARGO_PKG_VERSION"),
                // Release packaging may inject provenance data. Development
                // builds report null rather than a fabricated checksum.
                "buildChecksum": option_env!("DISKTOP_HELPER_BUILD_CHECKSUM"),
                "platform": std::env::consts::OS,
                "architecture": std::env::consts::ARCH,
                "kernelCapabilities": { "openat2": probe_openat2() },
                "supportedOperations": SUPPORTED_OPERATIONS,
            }),
        ),
        "hello" | "probe" => error(
            request_id,
            "invalid-arguments",
            "hello and probe do not accept arguments",
        ),
        operation if PLANNED_OPERATIONS.contains(&operation) => error(
            request_id,
            "unsupported-operation",
            "This operation is not implemented in this helper build",
        ),
        _ => error(request_id, "unknown-operation", "Unknown helper operation"),
    }
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

fn complete(request_id: &str, result: Value) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "eventId": "1",
        "event": "complete",
        "result": result,
    })
}

fn error(request_id: Option<&str>, code: &str, message: &str) -> Value {
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
    #[repr(C)]
    struct OpenHow {
        flags: u64,
        mode: u64,
        resolve: u64,
    }

    const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
    const RESOLVE_BENEATH: u64 = 0x08;
    let how = OpenHow {
        flags: (libc::O_RDONLY | libc::O_CLOEXEC) as u64,
        mode: 0,
        resolve: RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS,
    };

    // Probe only the required syscall and containment flags. Availability
    // does not imply that scanning or mutation is implemented or safe yet.
    let descriptor = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            libc::AT_FDCWD,
            c".".as_ptr(),
            &how as *const OpenHow,
            std::mem::size_of::<OpenHow>(),
        )
    };

    if descriptor >= 0 {
        unsafe { libc::close(descriptor as libc::c_int) };
        json!({ "available": true, "reason": null })
    } else {
        json!({
            "available": false,
            "reason": format!("openat2 probe failed: {}", io::Error::last_os_error()),
        })
    }
}

#[cfg(not(target_os = "linux"))]
fn probe_openat2() -> Value {
    json!({ "available": false, "reason": "openat2 requires Linux" })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn responses(input: &str) -> Vec<Value> {
        let mut output = Vec::new();
        serve(Cursor::new(input.as_bytes()), &mut output).unwrap();
        output
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect()
    }

    #[test]
    fn handshake_reports_only_implemented_operations() {
        let output = responses(
            "{\"protocolVersion\":1,\"requestId\":\"hello-1\",\"operation\":\"hello\",\"arguments\":{}}\n",
        );
        assert_eq!(output.len(), 1);
        assert_eq!(output[0]["requestId"], "hello-1");
        assert_eq!(output[0]["event"], "complete");
        assert_eq!(
            output[0]["result"]["supportedOperations"],
            json!(["hello", "probe"])
        );
        assert!(output[0]["result"]["kernelCapabilities"]["openat2"]["available"].is_boolean());
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
}
