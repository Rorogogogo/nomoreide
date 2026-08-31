//! Saved log sources: a file, a remote file, or a command that someone reads on
//! demand.
//!
//! Nothing here is supervised. A log source is how a UAT or PROD log — written
//! by something this machine never launched — is read into the same pane as a
//! managed service's output, so every read is one-shot: spawn, collect, exit.
//!
//! A source carries either a `kind` or a `driver`, and the driver wins. With a
//! driver the query is pushed down to `journalctl` or `docker logs`, which can
//! filter by time and (for journald) by text and severity on the host. Without
//! one the whole tail comes back and the filtering happens here.
//!
//! Failures are returned rather than raised past the caller: the route answers
//! a failed read with `200 { ok: false, error }` because a log pane renders the
//! reason in place of the lines.

use std::collections::HashMap;
use std::time::Duration;

use regex::{Regex, RegexBuilder};
use serde::Serialize;

use crate::config::LogSourceDef;

const DEFAULT_LINES: u32 = 500;
const MAX_LINES: u32 = 5_000;
/// 8 MB, matching the reference's `maxBuffer`. A read that produces more is a
/// failure rather than a truncation.
const MAX_BUFFER: usize = 8 * 1024 * 1024;
const READ_TIMEOUT: Duration = Duration::from_millis(15_000);

/// The read-time query, off the URL. Every field is optional and an unreadable
/// one is dropped rather than refused.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LogQuery {
    pub since: Option<String>,
    pub until: Option<String>,
    pub grep: Option<String>,
    /// Only ever `warn` or `error`; anything else is no filter at all.
    pub level: Option<String>,
    pub cursor: Option<String>,
    pub before: Option<String>,
    pub lines: Option<f64>,
}

/// One line, in the shape the log pane consumes.
///
/// `timestamp` is a string rather than a time because a file tail has no
/// timestamps at all and sends `""` — the pane renders the line without one
/// rather than inventing the read time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LogSourceEntry {
    pub service: String,
    pub stream: String,
    pub text: String,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

fn error_pattern() -> &'static Regex {
    static CELL: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        RegexBuilder::new(r"\b(error|fatal|exception|panic|traceback|fail(?:ed|ure)?)\b")
            .case_insensitive(true)
            .build()
            .expect("static pattern")
    })
}

fn warn_pattern() -> &'static Regex {
    static CELL: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        RegexBuilder::new(r"\b(warn|warning|deprecated)\b")
            .case_insensitive(true)
            .build()
            .expect("static pattern")
    })
}

/// Reads the query off already-parsed search params.
///
/// `lines` goes through `Number()` in the reference, so a blank or unreadable
/// value is not an error — it is simply not a positive number, and the default
/// applies. A fractional value survives to `clamp_lines`, which floors it.
pub fn parse_log_query(params: &HashMap<String, String>) -> LogQuery {
    let text = |key: &str| params.get(key).filter(|value| !value.is_empty()).cloned();
    let lines = params
        .get("lines")
        .map(|raw| js_number(raw))
        .filter(|value| value.is_finite() && *value > 0.0);
    LogQuery {
        since: text("since"),
        until: text("until"),
        grep: text("grep"),
        level: params
            .get("level")
            .filter(|value| *value == "warn" || *value == "error")
            .cloned(),
        cursor: text("cursor"),
        before: text("before"),
        lines,
    }
}

/// `Number(text)`: a blank string is zero, anything unreadable is NaN.
fn js_number(raw: &str) -> f64 {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

fn clamp_lines(lines: Option<f64>) -> u32 {
    let Some(lines) = lines else {
        return DEFAULT_LINES;
    };
    if !lines.is_finite() || lines <= 0.0 {
        return DEFAULT_LINES;
    }
    (lines.floor() as u32).min(MAX_LINES)
}

/// Reads a slice of a log source.
pub async fn read_log_source(
    source: &LogSourceDef,
    query: &LogQuery,
) -> Result<Vec<LogSourceEntry>, String> {
    let count = clamp_lines(query.lines);

    match source.driver.as_deref() {
        Some("journald") => {
            let Some(unit) = non_empty(&source.unit) else {
                return Err("journald log source is missing a unit.".to_string());
            };
            let argv = build_journald_args(unit, query, count);
            let (stdout, _) = run_invocation(&argv, source.host.as_deref()).await?;
            let mut entries = parse_journald_json(&source.name, &stdout);
            if let Some(before) = &query.before {
                // `--reverse` came back newest-first and includes the boundary
                // cursor. Put it back in order and drop that boundary entry.
                entries.reverse();
                entries.retain(|entry| entry.cursor.as_deref() != Some(before.as_str()));
            }
            Ok(entries)
        }
        Some("docker") => {
            let Some(container) = non_empty(&source.container) else {
                return Err("docker log source is missing a container.".to_string());
            };
            let argv = build_docker_args(container, query, count);
            let (stdout, stderr) = run_invocation(&argv, source.host.as_deref()).await?;
            // `docker logs` has no text or severity filter, so both happen here.
            let mut entries = to_entries(&source.name, &stdout, "stdout");
            entries.extend(to_entries(&source.name, &stderr, "stderr"));
            Ok(tail(apply_client_filters(entries, query), count))
        }
        _ => read_by_kind(source, query, count).await,
    }
}

async fn read_by_kind(
    source: &LogSourceDef,
    query: &LogQuery,
    count: u32,
) -> Result<Vec<LogSourceEntry>, String> {
    match source.kind.as_str() {
        "file" => {
            let Some(path) = non_empty(&source.path) else {
                return Err("File log source is missing a path.".to_string());
            };
            let entries = tail_local_file(&source.name, path, count).await?;
            Ok(apply_client_filters(entries, query))
        }
        "ssh" => {
            let (Some(host), Some(path)) = (non_empty(&source.host), non_empty(&source.path))
            else {
                return Err("SSH log source is missing host or path.".to_string());
            };
            let argv = [
                "ssh".to_string(),
                host.to_string(),
                "tail".to_string(),
                "-n".to_string(),
                count.to_string(),
                path.to_string(),
            ];
            let (stdout, _) = exec_file(&argv, None).await?;
            Ok(apply_client_filters(
                to_entries(&source.name, &stdout, "stdout"),
                query,
            ))
        }
        _ => {
            let Some(command) = non_empty(&source.command) else {
                return Err("Command log source is missing a command.".to_string());
            };
            let argv = ["sh".to_string(), "-c".to_string(), command.to_string()];
            let (stdout, stderr) = exec_file(&argv, source.cwd.as_deref()).await?;
            let mut entries = to_entries(&source.name, &stdout, "stdout");
            entries.extend(to_entries(&source.name, &stderr, "stderr"));
            Ok(tail(apply_client_filters(entries, query), count))
        }
    }
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|text| !text.is_empty())
}

fn tail(entries: Vec<LogSourceEntry>, count: u32) -> Vec<LogSourceEntry> {
    let count = count as usize;
    if entries.len() <= count {
        return entries;
    }
    entries[entries.len() - count..].to_vec()
}

/// The `journalctl` argv for a unit and a query. JSON output carries real
/// timestamps, a priority, and a cursor, so severity is read rather than
/// guessed.
pub fn build_journald_args(unit: &str, query: &LogQuery, count: u32) -> Vec<String> {
    let mut args: Vec<String> = ["journalctl", "-u", unit, "--no-pager", "-o", "json"]
        .iter()
        .map(|value| value.to_string())
        .collect();
    fn push(args: &mut Vec<String>, flag: &str, value: &str) {
        args.push(flag.to_string());
        args.push(value.to_string());
    }
    if let Some(since) = &query.since {
        push(&mut args, "--since", since);
    }
    if let Some(until) = &query.until {
        push(&mut args, "--until", until);
    }
    if let Some(grep) = &query.grep {
        push(&mut args, "--grep", grep);
    }
    match query.level.as_deref() {
        Some("error") => push(&mut args, "-p", "err"),
        Some("warn") => push(&mut args, "-p", "warning"),
        _ => {}
    }
    if let Some(before) = &query.before {
        // Page older: start at the cursor and walk backwards.
        push(&mut args, "--cursor", before);
        args.push("--reverse".to_string());
        push(&mut args, "-n", &count.to_string());
    } else if let Some(cursor) = &query.cursor {
        // Page newer: everything after the cursor.
        push(&mut args, "--after-cursor", cursor);
        push(&mut args, "-n", &count.to_string());
    } else {
        push(&mut args, "-n", &count.to_string());
    }
    args
}

/// The `docker logs` argv for a container and a query — a time window only.
pub fn build_docker_args(container: &str, query: &LogQuery, count: u32) -> Vec<String> {
    let mut args: Vec<String> = ["docker", "logs", "--tail"]
        .iter()
        .map(|value| value.to_string())
        .collect();
    args.push(count.to_string());
    args.push("--timestamps".to_string());
    if let Some(since) = &query.since {
        args.push("--since".to_string());
        args.push(since.clone());
    }
    if let Some(until) = &query.until {
        args.push("--until".to_string());
        args.push(until.clone());
    }
    args.push(container.to_string());
    args
}

/// Runs an argv locally, or over ssh when the source names a host. For ssh the
/// argv is escaped and joined into one remote command, so a value with spaces
/// (`--since "1 hour ago"`) survives the remote shell.
async fn run_invocation(argv: &[String], host: Option<&str>) -> Result<(String, String), String> {
    match host.filter(|value| !value.is_empty()) {
        Some(host) => {
            let remote = argv
                .iter()
                .map(|value| shell_escape(value))
                .collect::<Vec<_>>()
                .join(" ");
            exec_file(&["ssh".to_string(), host.to_string(), remote], None).await
        }
        None => exec_file(argv, None).await,
    }
}

fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// `execFile`, with this module's own budgets.
///
/// The wording of a failure is the shared runner's, because it is Node's and
/// every surface that quotes one quotes the same sentence.
async fn exec_file(argv: &[String], cwd: Option<&str>) -> Result<(String, String), String> {
    let output = crate::exec_file::exec_file(
        argv,
        &crate::exec_file::ExecOptions {
            timeout: READ_TIMEOUT,
            max_buffer: MAX_BUFFER,
            cwd,
        },
    )
    .await?;
    Ok((
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    ))
}

/// Parses `journalctl -o json` lines into entries with real timestamps.
fn parse_journald_json(service: &str, stdout: &str) -> Vec<LogSourceEntry> {
    let mut entries = Vec::new();
    for line in stdout.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        // The occasional non-JSON line is tolerated rather than fatal.
        let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let text = decode_journald_message(record.get("MESSAGE"));
        let priority = record.get("PRIORITY").and_then(json_number);
        // syslog priority 0-3 is err/crit/alert/emerg, which renders red.
        let stream = match priority {
            Some(value) if value <= 3.0 => "stderr",
            _ => "stdout",
        };
        let micros = record.get("__REALTIME_TIMESTAMP").and_then(json_number);
        let timestamp = micros
            .and_then(|value| chrono::DateTime::from_timestamp_micros(value as i64))
            .map(|value| value.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
            .unwrap_or_default();
        let cursor = record
            .get("__CURSOR")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        entries.push(LogSourceEntry {
            service: service.to_string(),
            stream: stream.to_string(),
            text,
            timestamp,
            cursor,
        });
    }
    entries
}

/// `Number(value)` over a JSON field, which is how the reference reads both of
/// journald's numeric fields — they arrive as strings.
fn json_number(value: &serde_json::Value) -> Option<f64> {
    match value {
        serde_json::Value::Number(number) => number.as_f64(),
        serde_json::Value::String(text) => Some(js_number(text)),
        _ => None,
    }
}

/// journald's `MESSAGE` is usually a string, but a byte array for a payload
/// that is not valid UTF-8.
fn decode_journald_message(message: Option<&serde_json::Value>) -> String {
    match message {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Array(bytes)) => bytes
            .iter()
            .filter_map(|byte| byte.as_u64())
            .filter_map(|byte| char::from_u32(byte as u32))
            .collect(),
        None | Some(serde_json::Value::Null) => String::new(),
        Some(other) => other.to_string(),
    }
}

/// Applies `grep` and `level` to entries that were fetched whole.
pub fn apply_client_filters(entries: Vec<LogSourceEntry>, query: &LogQuery) -> Vec<LogSourceEntry> {
    let mut result = entries;
    if let Some(term) = &query.grep {
        let matcher = compile_grep(term);
        result.retain(|entry| matcher.is_match(&entry.text));
    }
    match query.level.as_deref() {
        Some("error") => {
            result.retain(|entry| entry.stream == "stderr" || error_pattern().is_match(&entry.text))
        }
        Some("warn") => result.retain(|entry| {
            entry.stream == "stderr"
                || error_pattern().is_match(&entry.text)
                || warn_pattern().is_match(&entry.text)
        }),
        _ => {}
    }
    result
}

/// The term is a regex, falling back to a literal match when it does not
/// compile.
///
/// The fallback is the reference's, but the set of terms that reach it is not
/// quite: a lookbehind compiles in V8 and not here, so a pattern using one is
/// matched literally where the reference would match it as a regex. Recorded
/// rather than worked around — reproducing V8's regex engine is not a route
/// port.
fn compile_grep(term: &str) -> Regex {
    RegexBuilder::new(term)
        .case_insensitive(true)
        .build()
        .unwrap_or_else(|_| {
            RegexBuilder::new(&regex::escape(term))
                .case_insensitive(true)
                .build()
                .expect("an escaped term always compiles")
        })
}

async fn tail_local_file(
    name: &str,
    path: &str,
    count: u32,
) -> Result<Vec<LogSourceEntry>, String> {
    let contents = match tokio::fs::read(path).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
        Err(error) => {
            return Err(match error.kind() {
                std::io::ErrorKind::NotFound => format!("File not found: {path}"),
                std::io::ErrorKind::PermissionDenied => format!("Permission denied: {path}"),
                _ => error.to_string(),
            })
        }
    };
    Ok(tail(to_entries(name, &contents, "stdout"), count))
}

/// Splits captured output into entries.
///
/// One trailing newline is dropped — it terminates the last line rather than
/// starting an empty one — and everything else is kept, blank lines included.
/// A file or ssh tail arrives as a single stream, so a line that looks like an
/// error is re-flagged as stderr; that is what makes it render red and survive
/// an "errors only" filter.
fn to_entries(service: &str, output: &str, default_stream: &str) -> Vec<LogSourceEntry> {
    let text = output.strip_suffix('\n').unwrap_or(output);
    if text.is_empty() {
        return Vec::new();
    }
    text.split('\n')
        .map(|line| LogSourceEntry {
            service: service.to_string(),
            stream: if default_stream == "stdout" && error_pattern().is_match(line) {
                "stderr".to_string()
            } else {
                default_stream.to_string()
            },
            text: line.to_string(),
            timestamp: String::new(),
            cursor: None,
        })
        .collect()
}
