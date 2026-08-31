//! Read-mostly Docker introspection: whatever is on this machine, registered as
//! a nomoreide service or not.
//!
//! The Rust half of `src/core/docker.ts`, `docker-resources.ts`,
//! `docker-stats.ts` and `docker-inspect.ts`. Every invocation goes through
//! [`exec_docker`] so the no-shell-interpolation guarantee lives in one place:
//! a container id and a path are always **argv elements**, never text spliced
//! into a command. That is the difference from the SSH reads, which have no
//! argv on the far end and have to escape.
//!
//! **Nothing here removes anything.** Pruning an image and deleting a volume
//! are destructive, and this module is the read side — the same split
//! `git_manager` keeps from `git_actions`. `start`, `stop` and `restart` are
//! here because they are recoverable and the container list is useless without
//! them.

use crate::exec_file::{exec_file, ExecOptions};
use crate::js_json;
use crate::js_number;
use crate::locale;
use crate::read_only_files::{
    assert_read_only_path, parse_read_only_directory, parse_read_only_file, FILE_PREVIEW_BYTES,
    FILE_READ_TIMEOUT_MS, READ_DIRECTORY_SCRIPT, READ_FILE_SCRIPT,
};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::OnceLock;
use std::time::Duration;

/// `inspect` and `logs` can be large; the reference raises Node's 1 MB default
/// for exactly that reason and the limit is part of when a read fails.
const MAX_BUFFER: usize = 32 * 1024 * 1024;
/// `execFile`'s default is no timeout, so most of these wait as long as Docker
/// does. Only the reads and the Desktop probes set one.
const NO_TIMEOUT: Duration = Duration::from_secs(60 * 60);

/// Every `docker` invocation in this feature.
pub async fn exec_docker(args: &[String]) -> Result<Vec<u8>, String> {
    let mut argv = vec!["docker".to_string()];
    argv.extend_from_slice(args);
    let output = exec_file(
        &argv,
        &ExecOptions {
            timeout: NO_TIMEOUT,
            max_buffer: MAX_BUFFER,
            cwd: None,
        },
    )
    .await?;
    Ok(output.stdout)
}

async fn exec_docker_text(args: &[String]) -> Result<String, String> {
    exec_docker(args)
        .await
        .map(|stdout| String::from_utf8_lossy(&stdout).into_owned())
}

fn argv(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| part.to_string()).collect()
}

// ---------------------------------------------------------------------------
// Is Docker there at all?
// ---------------------------------------------------------------------------

/// The page's empty state, and the two things it can offer to do about it.
///
/// `available` is about the *daemon*; `canStart` is about whether Docker
/// Desktop is installed. They are independent — the CLI can answer while
/// Desktop is missing, and Desktop can be installed while the daemon is down —
/// so both are reported and neither is inferred from the other.
pub async fn docker_status() -> Value {
    let can_start = docker_desktop_installed().await;
    let install_url = if can_start { None } else { install_url() };

    let mut status = Map::new();
    match exec_docker_text(&argv(&["version", "--format", "{{.Server.Version}}"])).await {
        Ok(stdout) => {
            status.insert("available".into(), Value::Bool(true));
            status.insert("canStart".into(), Value::Bool(can_start));
            if let Some(url) = install_url {
                status.insert("installUrl".into(), Value::String(url));
            }
            status.insert("version".into(), Value::String(stdout.trim().to_string()));
        }
        Err(failure) => {
            status.insert("available".into(), Value::Bool(false));
            status.insert("canStart".into(), Value::Bool(can_start));
            if let Some(url) = install_url {
                status.insert("installUrl".into(), Value::String(url));
            }
            status.insert("error".into(), Value::String(failure));
        }
    }
    Value::Object(status)
}

/// A fixed, platform-owned launch command — never derived from request input.
///
/// macOS only, and the `None` is load-bearing: the alternative is guessing at a
/// Linux service manager, and being wrong there means telling someone their
/// Docker failed to start when nothing tried.
fn start_command() -> Option<Vec<String>> {
    if cfg!(target_os = "macos") {
        return Some(argv(&["open", "-a", "Docker"]));
    }
    None
}

fn lookup_command() -> Option<Vec<String>> {
    if cfg!(target_os = "macos") {
        return Some(argv(&["open", "-Ra", "Docker"]));
    }
    None
}

fn install_url() -> Option<String> {
    if cfg!(target_os = "macos") {
        return Some("https://docs.docker.com/desktop/setup/install/mac-install/".to_string());
    }
    None
}

pub async fn docker_desktop_installed() -> bool {
    let Some(command) = lookup_command() else {
        return false;
    };
    exec_file(
        &command,
        &ExecOptions {
            timeout: Duration::from_millis(5_000),
            max_buffer: MAX_BUFFER,
            cwd: None,
        },
    )
    .await
    .is_ok()
}

/// Two refusals, and they are not the same one: not installed, and installed on
/// a platform with no launch command. Only the first can happen on macOS.
pub async fn start_docker_desktop() -> Result<(), String> {
    if !docker_desktop_installed().await {
        return Err("Docker Desktop is not installed.".to_string());
    }
    let Some(command) = start_command() else {
        return Err(
            "Starting Docker automatically is currently supported on macOS only.".to_string(),
        );
    };
    exec_file(
        &command,
        &ExecOptions {
            timeout: Duration::from_millis(10_000),
            max_buffer: MAX_BUFFER,
            cwd: None,
        },
    )
    .await
    .map(|_| ())
}

// ---------------------------------------------------------------------------
// The list reads
// ---------------------------------------------------------------------------

/// One JSON object per line, parsed leniently.
///
/// A line that will not parse, or that the mapper rejects, is **skipped**. One
/// unreadable row must not blank a view — the list is a diagnostic, and a
/// diagnostic that disappears when something is odd is worse than one with a
/// gap in it.
fn parse_json_lines(
    stdout: &str,
    map: impl Fn(&Map<String, Value>) -> Option<Value>,
) -> Vec<Value> {
    let mut rows = Vec::new();
    for line in stdout.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(Value::Object(raw)) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(mapped) = map(&raw) {
            rows.push(mapped);
        }
    }
    rows
}

/// A field that has to be a string. Anything else — a number, a null, an array
/// — reads as absent rather than as its own rendering.
fn read_string(raw: &Map<String, Value>, key: &str) -> String {
    raw.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

pub async fn list_containers() -> Result<Vec<Value>, String> {
    let stdout = exec_docker_text(&argv(&["ps", "-a", "--format", "{{json .}}"])).await?;
    Ok(parse_ps_lines(&stdout))
}

pub fn parse_ps_lines(stdout: &str) -> Vec<Value> {
    parse_json_lines(stdout, |raw| {
        let id = read_string(raw, "ID");
        if id.is_empty() {
            return None;
        }
        let labels = parse_labels(&read_string(raw, "Labels"));
        let name = read_string(raw, "Names");
        let state = read_string(raw, "State");

        let mut row = Map::new();
        row.insert("id".into(), Value::String(id.clone()));
        // A blank name is falsy, so the id stands in for it.
        row.insert(
            "name".into(),
            Value::String(if name.is_empty() { id } else { name }),
        );
        row.insert("image".into(), Value::String(read_string(raw, "Image")));
        row.insert(
            "state".into(),
            Value::String(if state.is_empty() {
                "unknown".to_string()
            } else {
                state
            }),
        );
        row.insert("status".into(), Value::String(read_string(raw, "Status")));
        row.insert("ports".into(), Value::String(read_string(raw, "Ports")));
        // Absent rather than blank: a container with no creation time is not a
        // container created at the empty string.
        let created = read_string(raw, "CreatedAt");
        if raw.get("CreatedAt").and_then(Value::as_str).is_some() {
            row.insert("createdAt".into(), Value::String(created));
        }
        if let Some(project) = labels.get("com.docker.compose.project") {
            row.insert("project".into(), project.clone());
        }
        if let Some(service) = labels.get("com.docker.compose.service") {
            row.insert("service".into(), service.clone());
        }
        Some(Value::Object(row))
    })
}

/// `docker ps`'s `Labels` is one flat `key=value,key=value` string.
///
/// A pair with no `=` is skipped, and so is one whose key is blank — but a
/// blank *value* is kept, because `trailing=` is a label that is set to nothing
/// rather than a label that is not set.
fn parse_labels(raw: &str) -> Map<String, Value> {
    let mut labels = Map::new();
    for pair in raw.split(',') {
        let Some(separator) = pair.find('=') else {
            continue;
        };
        let key = pair[..separator].trim();
        if key.is_empty() {
            continue;
        }
        labels.insert(
            key.to_string(),
            Value::String(pair[separator + 1..].trim().to_string()),
        );
    }
    labels
}

pub async fn list_stats() -> Result<Vec<Value>, String> {
    let stdout =
        exec_docker_text(&argv(&["stats", "--no-stream", "--format", "{{json .}}"])).await?;
    Ok(parse_stats_lines(&stdout))
}

pub fn parse_stats_lines(stdout: &str) -> Vec<Value> {
    parse_json_lines(stdout, |raw| {
        // `stats` keys rows by `ID`, but older spellings use `Container`.
        let mut id = read_string(raw, "ID");
        if id.is_empty() {
            id = read_string(raw, "Container");
        }
        if id.is_empty() {
            return None;
        }
        Some(json!({
            "id": id,
            "cpuPercent": parse_percent(&read_string(raw, "CPUPerc")),
            "memoryPercent": parse_percent(&read_string(raw, "MemPerc")),
            "memoryUsage": read_string(raw, "MemUsage"),
            "netIo": read_string(raw, "NetIO"),
            "blockIo": read_string(raw, "BlockIO"),
        }))
    })
}

/// `"2.43%"`, or `"--"` when Docker has no sample.
///
/// Null rather than zero for the no-sample case: a stopped container using no
/// CPU and a container nobody measured are different facts, and a chart that
/// draws the second as the first is lying.
fn parse_percent(value: &str) -> Value {
    // `parseFloat`, which reads a leading number and ignores the rest — so the
    // `%` does not need removing for it to work, only for `--` to fail.
    let trimmed = value.replace('%', "");
    let text = trimmed.trim();
    let end = text
        .char_indices()
        .position(|(index, character)| {
            !(character.is_ascii_digit()
                || character == '.'
                || (index == 0 && (character == '-' || character == '+')))
        })
        .unwrap_or(text.len());
    let parsed = js_number::parse(&text[..end]);
    if text[..end].is_empty() || !parsed.is_finite() {
        return Value::Null;
    }
    js_number::value(parsed)
}

pub async fn list_images() -> Result<Vec<Value>, String> {
    let stdout = exec_docker_text(&argv(&["images", "--format", "{{json .}}"])).await?;
    Ok(parse_image_lines(&stdout))
}

pub fn parse_image_lines(stdout: &str) -> Vec<Value> {
    parse_json_lines(stdout, |raw| {
        let id = read_string(raw, "ID");
        if id.is_empty() {
            return None;
        }
        let repository = read_string(raw, "Repository");
        let tag = read_string(raw, "Tag");
        Some(json!({
            "id": id,
            "repository": repository,
            "tag": tag,
            "size": read_string(raw, "Size"),
            "createdSince": read_string(raw, "CreatedSince"),
            // Either half being `<none>` is enough — a rebuild leaves layers
            // that have lost one or the other.
            "dangling": repository == "<none>" || tag == "<none>",
        }))
    })
}

pub async fn list_volumes() -> Result<Vec<Value>, String> {
    let stdout = exec_docker_text(&argv(&["volume", "ls", "--format", "{{json .}}"])).await?;
    Ok(parse_volume_lines(&stdout))
}

pub fn parse_volume_lines(stdout: &str) -> Vec<Value> {
    parse_json_lines(stdout, |raw| {
        let name = read_string(raw, "Name");
        if name.is_empty() {
            return None;
        }
        Some(json!({
            "name": name,
            "driver": read_string(raw, "Driver"),
            "mountpoint": read_string(raw, "Mountpoint"),
            "scope": read_string(raw, "Scope"),
        }))
    })
}

pub async fn list_networks() -> Result<Vec<Value>, String> {
    let stdout = exec_docker_text(&argv(&["network", "ls", "--format", "{{json .}}"])).await?;
    Ok(parse_network_lines(&stdout))
}

pub fn parse_network_lines(stdout: &str) -> Vec<Value> {
    parse_json_lines(stdout, |raw| {
        let id = read_string(raw, "ID");
        if id.is_empty() {
            return None;
        }
        Some(json!({
            "id": id,
            "name": read_string(raw, "Name"),
            "driver": read_string(raw, "Driver"),
            "scope": read_string(raw, "Scope"),
        }))
    })
}

// ---------------------------------------------------------------------------
// One container
// ---------------------------------------------------------------------------

/// Ids and names are alphanumeric plus `_.-`, and may not start with a dash.
///
/// Not for the shell's sake — nothing here reaches a shell — but for
/// `docker`'s: a leading `-` would be read as an option, which is how a
/// container named `-v` becomes a mount.
pub fn validate_container_id(id: &str) -> Result<(), String> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern =
        PATTERN.get_or_init(|| Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$").expect("valid pattern"));
    if pattern.is_match(id) {
        return Ok(());
    }
    Err(format!("Invalid container id: \"{id}\""))
}

pub async fn container_action(id: &str, action: &str) -> Result<(), String> {
    validate_container_id(id)?;
    exec_docker(&argv(&[action, id])).await.map(|_| ())
}

/// At least one line, at most two thousand.
///
/// `Math.trunc(tail) || 200` — so a tail that truncates to zero falls back to
/// the default rather than to one, and only then is the result clamped.
pub fn clamp_tail(tail: f64) -> i64 {
    let truncated = if tail.is_finite() { tail.trunc() } else { 0.0 } as i64;
    let chosen = if truncated == 0 { 200 } else { truncated };
    chosen.clamp(1, 2000)
}

pub async fn read_container_logs(id: &str, tail: Option<f64>) -> Result<String, String> {
    validate_container_id(id)?;
    let clamped = clamp_tail(tail.unwrap_or(200.0));
    let mut command = vec!["docker".to_string()];
    command.extend(argv(&["logs", "--tail"]));
    command.push(clamped.to_string());
    command.extend(argv(&["--timestamps", id]));
    let output = exec_file(
        &command,
        &ExecOptions {
            timeout: NO_TIMEOUT,
            max_buffer: MAX_BUFFER,
            cwd: None,
        },
    )
    .await?;
    Ok(merge_timestamped_log_lines(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    ))
}

/// Two streams, one chronology.
///
/// `docker logs` writes a container's stdout and stderr separately, so they
/// arrive unordered relative to each other. `--timestamps` prefixes every line
/// with an RFC3339 time, which makes a lexicographic sort of the combined lines
/// a chronological one.
pub fn merge_timestamped_log_lines(stdout: &str, stderr: &str) -> String {
    let mut lines: Vec<&str> = stdout
        .split('\n')
        .chain(stderr.split('\n'))
        .filter(|line| !line.is_empty())
        .collect();
    lines.sort_by(|left, right| locale::compare(left, right));
    lines.join("\n")
}

fn read_argv(id: &str, script: &str, path: &str) -> Vec<String> {
    vec![
        "exec".to_string(),
        id.to_string(),
        "sh".to_string(),
        "-c".to_string(),
        script.to_string(),
        "nomoreide".to_string(),
        path.to_string(),
    ]
}

async fn exec_read(args: &[String], max_buffer: usize) -> Result<Vec<u8>, String> {
    let mut command = vec!["docker".to_string()];
    command.extend_from_slice(args);
    let output = exec_file(
        &command,
        &ExecOptions {
            timeout: Duration::from_millis(FILE_READ_TIMEOUT_MS),
            max_buffer,
            cwd: None,
        },
    )
    .await?;
    Ok(output.stdout)
}

/// A read-only listing inside a container.
///
/// The path is argv element seven, not text inside a command, so it needs no
/// escaping and a quote in it stays a quote.
pub async fn read_container_directory(
    id: &str,
    path: &str,
    include_hidden: bool,
) -> Result<Value, String> {
    validate_container_id(id)?;
    assert_read_only_path(path, false)?;
    let stdout = exec_read(&read_argv(id, READ_DIRECTORY_SCRIPT, path), 4 * 1024 * 1024).await?;
    Ok(with_container(
        id,
        parse_read_only_directory(&stdout, include_hidden)?,
    ))
}

pub async fn read_container_file(id: &str, path: &str) -> Result<Value, String> {
    validate_container_id(id)?;
    assert_read_only_path(path, true)?;
    let stdout = exec_read(
        &read_argv(id, READ_FILE_SCRIPT, path),
        FILE_PREVIEW_BYTES + 64 * 1024,
    )
    .await?;
    Ok(with_container(id, parse_read_only_file(path, &stdout)?))
}

/// `{ containerId, ...rest }` — the id leads, ahead of the shared parser's own
/// fields.
fn with_container(id: &str, rest: Value) -> Value {
    let mut merged = Map::new();
    merged.insert("containerId".into(), Value::String(id.to_string()));
    if let Value::Object(fields) = rest {
        for (key, value) in fields {
            merged.insert(key, value);
        }
    }
    Value::Object(merged)
}

// ---------------------------------------------------------------------------
// The detail panel
// ---------------------------------------------------------------------------

/// Env values are masked when the key *contains* one of these.
///
/// A substring match, so `MONKEY` is masked because it holds `key`. Wider than
/// it needs to be, and deliberately so: this is a local dashboard, but the same
/// daemon port is what MCP agents talk to, and a container password should not
/// land in an agent transcript because somebody opened a panel. Over-masking
/// costs a person one `docker inspect`; under-masking cannot be undone.
fn secret_key() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)(pass|secret|token|key|credential|auth)").expect("valid pattern")
    })
}

const MASK: &str = "••••••••";

pub async fn inspect_container(id: &str) -> Result<Value, String> {
    validate_container_id(id)?;
    let stdout = exec_docker_text(&argv(&["inspect", id])).await?;
    // The parser's own diagnostic, worded V8's way — a container whose inspect
    // output is not JSON is a Docker bug worth seeing in full.
    let parsed = js_json::parse(&stdout)?;
    let raw = match &parsed {
        Value::Array(entries) => entries.first().cloned().unwrap_or(Value::Null),
        other => other.clone(),
    };
    let Value::Object(document) = raw else {
        return Err(format!("No inspect output for container \"{id}\""));
    };
    Ok(map_inspect_document(&document))
}

fn as_record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn as_string(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// A `Vec<String>` of only the entries that *were* strings. Docker will not mix
/// types here, but the document is untrusted input and one number in `Cmd`
/// should not become the string `7` in a command line.
fn as_string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// The ~200-key inspect document, down to what the panel renders.
///
/// Picked field by field rather than passed through: the raw document is both
/// noise and a disclosure surface, and a panel that shows everything is one
/// that shows the next thing Docker adds without anyone deciding to.
pub fn map_inspect_document(raw: &Map<String, Value>) -> Value {
    let empty = Map::new();
    let config = as_record(raw.get("Config")).unwrap_or(&empty);
    let state = as_record(raw.get("State")).unwrap_or(&empty);
    let network = as_record(raw.get("NetworkSettings")).unwrap_or(&empty);

    let mut command_parts = vec![as_string(config.get("Entrypoint"))];
    command_parts.extend(as_string_array(config.get("Cmd")));
    command_parts.retain(|part| !part.is_empty());

    json!({
        "id": as_string(raw.get("Id")),
        // Docker prefixes container names with a slash; nobody wants to read it.
        "name": as_string(raw.get("Name")).strip_prefix('/').map(str::to_string)
            .unwrap_or_else(|| as_string(raw.get("Name"))),
        "image": as_string(config.get("Image")),
        "command": command_parts.join(" "),
        "created": as_string(raw.get("Created")),
        "state": as_string(state.get("Status")),
        "startedAt": as_string(state.get("StartedAt")),
        "restartCount": raw.get("RestartCount").and_then(Value::as_f64)
            .map_or(Value::from(0), js_number::value),
        "env": parse_env_list(&as_string_array(config.get("Env"))),
        "mounts": parse_mounts(raw.get("Mounts")),
        "ports": parse_port_bindings(network.get("Ports")),
        "networks": as_record(network.get("Networks"))
            .map(|networks| networks.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default(),
        "labels": parse_label_map(config.get("Labels")),
    })
}

pub fn parse_env_list(entries: &[String]) -> Vec<Value> {
    entries
        .iter()
        .map(|entry| {
            let (key, value) = match entry.find('=') {
                // No `=` at all: the whole thing is a key with no value.
                None => (entry.as_str(), ""),
                Some(separator) => (&entry[..separator], &entry[separator + 1..]),
            };
            let secret = secret_key().is_match(key) && !value.is_empty();
            json!({
                "key": key,
                "value": if secret { MASK } else { value },
                "secret": secret,
            })
        })
        .collect()
}

fn parse_mounts(raw: Option<&Value>) -> Vec<Value> {
    raw.and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_object)
                .map(|mount| {
                    // A named volume reports `Name`; a bind mount reports
                    // `Source`. One column, whichever it has.
                    let name = as_string(mount.get("Name"));
                    let source = if name.is_empty() {
                        as_string(mount.get("Source"))
                    } else {
                        name
                    };
                    json!({
                        "type": as_string(mount.get("Type")),
                        "source": source,
                        "destination": as_string(mount.get("Destination")),
                        // `RW: false` is read-only. An *absent* RW is not — the
                        // test is against the literal false, not falsiness.
                        "readOnly": mount.get("RW") == Some(&Value::Bool(false)),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `NetworkSettings.Ports` maps `"5432/tcp"` to a list of host bindings, to an
/// empty list, or to null.
///
/// An exposed port with nothing bound still gets a row, with a blank host port
/// — the panel's job is to show what the container exposes, and dropping the
/// unbound ones would hide most of them.
fn parse_port_bindings(raw: Option<&Value>) -> Vec<Value> {
    let Some(ports) = raw.and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut bindings = Vec::new();
    for (container_port, host_list) in ports {
        let hosts = host_list.as_array().filter(|hosts| !hosts.is_empty());
        let Some(hosts) = hosts else {
            bindings.push(json!({ "containerPort": container_port, "hostPort": "" }));
            continue;
        };
        for host in hosts.iter().filter_map(Value::as_object) {
            let ip = as_string(host.get("HostIp"));
            let port = as_string(host.get("HostPort"));
            bindings.push(json!({
                "containerPort": container_port,
                "hostPort": if ip.is_empty() { port } else { format!("{ip}:{port}") },
            }));
        }
    }
    bindings
}

/// String values only. A label whose value is not a string is dropped rather
/// than rendered, because there is nothing sensible to render.
fn parse_label_map(raw: Option<&Value>) -> Map<String, Value> {
    let mut labels = Map::new();
    if let Some(entries) = raw.and_then(Value::as_object) {
        for (key, value) in entries {
            if let Some(text) = value.as_str() {
                labels.insert(key.clone(), Value::String(text.to_string()));
            }
        }
    }
    labels
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_name_or_state_falls_back() {
        let rows = parse_ps_lines(
            r#"{"ID":"abc","Names":"","State":"","Status":"Paused","Ports":"","Labels":""}"#,
        );
        assert_eq!(rows[0]["name"], "abc");
        assert_eq!(rows[0]["state"], "unknown");
    }

    #[test]
    fn a_row_with_no_id_and_a_line_that_is_not_json_are_both_skipped() {
        let rows = parse_ps_lines(
            "{\"Names\":\"orphan\"}\n{ not json\n   \n{\"ID\":\"abc\",\"Names\":\"web\"}\n",
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], "web");
    }

    #[test]
    fn compose_labels_become_project_and_service() {
        let rows = parse_ps_lines(
            r#"{"ID":"abc","Labels":"com.docker.compose.project=shop,bare,=novalue,trailing="}"#,
        );
        assert_eq!(rows[0]["project"], "shop");
        assert!(
            rows[0].get("service").is_none(),
            "a label that is not there is omitted, not blank"
        );
    }

    #[test]
    fn a_percentage_docker_could_not_sample_is_null_rather_than_zero() {
        assert_eq!(parse_percent("2.43%"), 2.43);
        assert_eq!(parse_percent("11.20%"), 11.2);
        assert_eq!(parse_percent("0.00%"), 0);
        assert_eq!(parse_percent("--"), Value::Null);
        assert_eq!(parse_percent(""), Value::Null);
    }

    #[test]
    fn an_image_is_dangling_when_either_half_is_none() {
        let rows = parse_image_lines(
            "{\"ID\":\"a\",\"Repository\":\"nginx\",\"Tag\":\"1.27\"}\n\
             {\"ID\":\"b\",\"Repository\":\"<none>\",\"Tag\":\"<none>\"}\n\
             {\"ID\":\"c\",\"Repository\":\"app\",\"Tag\":\"<none>\"}\n\
             {\"ID\":\"d\",\"Repository\":\"<none>\",\"Tag\":\"latest\"}\n",
        );
        let dangling: Vec<bool> = rows
            .iter()
            .map(|row| row["dangling"].as_bool().unwrap())
            .collect();
        assert_eq!(dangling, [false, true, true, true]);
    }

    #[test]
    fn a_tail_that_truncates_to_zero_falls_back_to_the_default() {
        assert_eq!(clamp_tail(200.0), 200);
        assert_eq!(clamp_tail(50.0), 50);
        // `Math.trunc(0.5)` is 0, which is falsy, so this is the default —
        // not the floor of 1.
        assert_eq!(clamp_tail(0.5), 200);
        assert_eq!(clamp_tail(0.0), 200);
        assert_eq!(clamp_tail(1.9), 1);
        assert_eq!(clamp_tail(5000.0), 2000);
        assert_eq!(clamp_tail(-5.0), 1);
    }

    #[test]
    fn the_two_streams_merge_into_one_chronology() {
        let merged = merge_timestamped_log_lines(
            "2026-01-01T10:00:02Z out second\n2026-01-01T10:00:00Z out first\n\n",
            "2026-01-01T10:00:01Z err early\n",
        );
        assert_eq!(
            merged,
            "2026-01-01T10:00:00Z out first\n\
             2026-01-01T10:00:01Z err early\n\
             2026-01-01T10:00:02Z out second"
        );
    }

    #[test]
    fn an_id_that_could_be_an_option_is_refused() {
        assert!(validate_container_id("abc123456789").is_ok());
        assert!(validate_container_id("web_1.service-a").is_ok());
        assert_eq!(
            validate_container_id("-rm").unwrap_err(),
            "Invalid container id: \"-rm\""
        );
        assert!(validate_container_id("abc; rm").is_err());
        assert!(validate_container_id("").is_err());
    }

    #[test]
    fn a_key_that_merely_contains_key_is_masked() {
        let env = parse_env_list(&[
            "PATH=/usr/local/sbin".to_string(),
            "DB_PASSWORD=hunter2".to_string(),
            // Contains "key". The reference masks it, so this does.
            "MONKEY=banana".to_string(),
            "EMPTY_PASSWORD=".to_string(),
            "NOEQUALS".to_string(),
        ]);
        assert_eq!(env[0]["secret"], false);
        assert_eq!(env[1]["value"], MASK);
        assert_eq!(env[2]["value"], MASK);
        // A value with nothing in it has nothing to hide.
        assert_eq!(env[3]["secret"], false);
        assert_eq!(env[3]["value"], "");
        assert_eq!(env[4]["key"], "NOEQUALS");
        assert_eq!(env[4]["value"], "");
    }

    #[test]
    fn an_exposed_port_with_nothing_bound_still_gets_a_row() {
        let ports = json!({
            "80/tcp": [{ "HostIp": "0.0.0.0", "HostPort": "8080" }, { "HostIp": "", "HostPort": "9090" }],
            "443/tcp": null,
            "9999/tcp": [],
        });
        let bindings = parse_port_bindings(Some(&ports));
        assert_eq!(bindings.len(), 4);
        assert_eq!(bindings[0]["hostPort"], "0.0.0.0:8080");
        // No host ip, so no colon prefix.
        assert_eq!(bindings[1]["hostPort"], "9090");
        assert_eq!(bindings[2]["hostPort"], "");
        assert_eq!(bindings[3]["hostPort"], "");
    }

    #[test]
    fn a_mount_reports_its_name_before_its_source() {
        let mounts = json!([
            { "Type": "volume", "Name": "shop_db", "Source": "/var/lib/x", "Destination": "/data", "RW": true },
            { "Type": "bind", "Source": "/host/conf", "Destination": "/etc/conf", "RW": false },
            "not a mount",
        ]);
        let parsed = parse_mounts(Some(&mounts));
        assert_eq!(parsed.len(), 2, "a non-object entry is dropped");
        assert_eq!(parsed[0]["source"], "shop_db");
        assert_eq!(parsed[0]["readOnly"], false);
        assert_eq!(parsed[1]["source"], "/host/conf");
        assert_eq!(parsed[1]["readOnly"], true);
    }

    #[test]
    fn a_name_loses_its_leading_slash_and_a_command_joins() {
        let document = json!({
            "Id": "abc",
            "Name": "/web",
            "RestartCount": 3,
            "Config": {
                "Entrypoint": "/entrypoint.sh",
                "Cmd": ["nginx", "-g", "daemon off;", 7],
                "Labels": { "ok": "yes", "broken": 5 },
            },
            "NetworkSettings": { "Networks": { "bridge": {}, "shop_default": {} } },
        });
        let detail = map_inspect_document(document.as_object().unwrap());
        assert_eq!(detail["name"], "web");
        // The number in Cmd is dropped rather than stringified.
        assert_eq!(detail["command"], "/entrypoint.sh nginx -g daemon off;");
        assert_eq!(detail["restartCount"], 3);
        assert_eq!(detail["networks"], json!(["bridge", "shop_default"]));
        assert_eq!(detail["labels"], json!({ "ok": "yes" }));
    }
}
