//! SSH servers: the merged list, registration, and the read-only remote views.
//!
//! **Four spellings of one guard.** Every remote call checks the host against
//! the same pattern, and each endpoint surfaces the refusal differently,
//! because in the reference the guard sits inside whichever block that route
//! wraps:
//!
//! | endpoint | an unusable host is |
//! | --- | --- |
//! | `probe` | `400`, its only failure status |
//! | `files`, `file`, `metrics` | `502`, the same as a dead link |
//! | `DELETE /:host` | `400` carrying zod's report, from a different guard |
//!
//! That is reproduced by *where* each handler returns from rather than by
//! classifying the message, so adding a rule to the guard cannot quietly
//! change one endpoint's status.
//!
//! **`setup` is also a host name.** `/api/servers/setup` has one segment, so it
//! matches the `:host` route rather than the setup group — a `GET` on it is
//! that route's 405, not the shell's 404. And `/api/servers/setup/terminal` is
//! two routes at once: `POST` opens a setup terminal, while any other method
//! reaches the server-terminal route with a host of `setup` and gets its 405.
//! The reference arrives there by falling past an exact route into a pattern;
//! this arrives by a static path outranking a parameterised one. Same answers.

use crate::server::app::AppState;
use crate::server::body::{decode_uri_component, read_json_object};
use crate::server::errors::{config_failure, error, method_not_allowed};
use crate::server::routes::query::query_value;
use crate::server::routes::terminal::spawn;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use nomoreide_core::config::SshServerDef;
use nomoreide_core::ssh_servers::{
    check_ssh_host, check_ssh_server, discover_ssh_hosts, host_provider_ssh_targets,
    merge_ssh_servers, probe_ssh_server, read_remote_directory, read_remote_file,
    read_remote_host_metrics, ssh_directory,
};
use nomoreide_core::ssh_setup::{
    inspect_ssh_setup, resolve_ssh_setup_terminal, SshSetupAction, SshSetupTerminal,
};
use nomoreide_core::terminal::TerminalSpawnSpec;
use serde_json::{json, Value};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/servers", get(list).post(register))
        // Exact, so a wrong method falls through to the shell's 404 — there is
        // no pattern with `status` as its third segment to catch it.
        .route("/api/servers/setup/status", get(setup_status))
        // A `POST` is the setup terminal; anything else is the server-terminal
        // route looking at a host called `setup`, which answers 405.
        .route(
            "/api/servers/setup/terminal",
            post(setup_terminal).fallback(method_not_allowed),
        )
        .route(
            "/api/servers/:host",
            delete(remove).fallback(method_not_allowed),
        )
        .route(
            "/api/servers/:host/files",
            get(files).fallback(method_not_allowed),
        )
        .route(
            "/api/servers/:host/file",
            get(file).fallback(method_not_allowed),
        )
        .route(
            "/api/servers/:host/probe",
            post(probe).fallback(method_not_allowed),
        )
        .route(
            "/api/servers/:host/metrics",
            get(metrics).fallback(method_not_allowed),
        )
        .route(
            "/api/servers/:host/terminal",
            post(server_terminal).fallback(method_not_allowed),
        )
}

/// The host out of the path, decoded the way `decodeURIComponent` decodes.
///
/// Read from the raw URI rather than through an extractor because a broken
/// escape has to *throw* — the reference's route decodes without a catch, so
/// the failure escapes to the dispatcher as a 500 rather than becoming a
/// refusal that mentions the host.
#[allow(clippy::result_large_err)]
fn host_of(uri: &Uri, trailing: Option<&str>) -> Result<String, Response> {
    let rest = uri.path().strip_prefix("/api/servers/").unwrap_or_default();
    let raw = match trailing {
        Some(suffix) => rest.strip_suffix(suffix).unwrap_or(rest),
        None => rest,
    };
    decode_uri_component(raw.trim_end_matches('/'))
        .ok_or_else(|| error(StatusCode::INTERNAL_SERVER_ERROR, "URI malformed"))
}

/// Saved rows, `~/.ssh/config` aliases, and every connected host provider's
/// machines, merged into one list.
async fn servers(state: &AppState) -> Result<Vec<Value>, Response> {
    let config = state
        .config_store
        .load()
        .await
        .map_err(|failure| config_failure(&failure))?;
    let discovered = discover_ssh_hosts(&ssh_directory().join("config")).await;
    Ok(merge_ssh_servers(
        &config.ssh_servers,
        &discovered,
        &host_provider_ssh_targets(&state.config_store, &config).await,
    ))
}

async fn list(State(state): State<AppState>) -> Response {
    match servers(&state).await {
        Ok(servers) => Json(json!({ "ok": true, "servers": servers })).into_response(),
        Err(response) => response,
    }
}

/// A field the route reads as a string, where blank counts as absent.
///
/// The route tests `.trim()` to decide presence but keeps the **untrimmed**
/// value; the schema trims it afterwards. Both halves have to stay where they
/// are: collapsing them into one trim here would store `"  ok  "` as `"ok"`
/// *and* accept `"   "` as a name.
fn optional_text(body: &Value, key: &str) -> Option<String> {
    body.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

async fn register(State(state): State<AppState>, body: Bytes) -> Response {
    let payload = read_json_object(&body);
    let definition = SshServerDef {
        // Anything that is not a string is the empty host, which the schema
        // then refuses for being empty rather than for being the wrong type.
        host: payload
            .get("host")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        name: optional_text(&payload, "name"),
        environment: optional_text(&payload, "environment"),
    };
    let checked = match check_ssh_server(&definition) {
        Ok(checked) => checked,
        Err(report) => return error(StatusCode::BAD_REQUEST, &report),
    };
    match state.config_store.register_ssh_server(checked).await {
        Ok(config) => Json(json!({ "ok": true, "servers": config.ssh_servers })).into_response(),
        Err(failure) => error(StatusCode::BAD_REQUEST, &failure.to_string()),
    }
}

async fn remove(State(state): State<AppState>, uri: Uri) -> Response {
    let host = match host_of(&uri, None) {
        Ok(host) => host,
        Err(response) => return response,
    };
    // The schema's own guard, which trims first — so a padded host removes the
    // row it names, and an unusable one is a 400 carrying zod's report rather
    // than the prose the remote reads use.
    let target = match check_ssh_host(&host) {
        Ok(target) => target,
        Err(report) => return error(StatusCode::BAD_REQUEST, &report),
    };
    match state.config_store.remove_ssh_server(&target).await {
        Ok(config) => Json(json!({ "ok": true, "servers": config.ssh_servers })).into_response(),
        Err(failure) => error(StatusCode::BAD_REQUEST, &failure.to_string()),
    }
}

async fn setup_status() -> Response {
    let status =
        inspect_ssh_setup(&ssh_directory(), &std::env::var("PATH").unwrap_or_default()).await;
    Json(json!({ "ok": true, "setup": status })).into_response()
}

/// `ssh-keygen` or `ssh-copy-id`, in a terminal.
///
/// Both prompt — for a passphrase, for a password — so neither can run in the
/// background. The action is checked before the destination, and an unknown one
/// is refused rather than defaulted, because either branch spawns a program.
async fn setup_terminal(State(state): State<AppState>, body: Bytes) -> Response {
    let payload = read_json_object(&body);
    let Some(action) = payload
        .get("action")
        .and_then(Value::as_str)
        .and_then(SshSetupAction::parse)
    else {
        return error(StatusCode::BAD_REQUEST, "Unknown SSH setup action.");
    };
    let destination = payload.get("host").and_then(Value::as_str);
    let SshSetupTerminal { shell, args, label } =
        match resolve_ssh_setup_terminal(action, destination) {
            Ok(terminal) => terminal,
            Err(reason) => return error(StatusCode::BAD_REQUEST, &reason),
        };
    spawn(
        &state,
        TerminalSpawnSpec {
            id: state.next_session_id(),
            service_name: None,
            cwd: state.workspace_cwd().await,
            shell: shell.into(),
            args,
            env: Vec::new(),
            label: Some(label),
            kind: Some("shell".to_string()),
            provider: None,
        },
    )
}

/// An `ssh` session on one server, under an id chosen from the host.
///
/// `ssh:<host>` rather than a generated id, so reopening the tab reattaches to
/// the session already there instead of dialling a second time.
async fn server_terminal(State(state): State<AppState>, uri: Uri) -> Response {
    let host = match host_of(&uri, Some("/terminal")) {
        Ok(host) => host,
        Err(response) => return response,
    };
    let servers = match servers(&state).await {
        Ok(servers) => servers,
        Err(response) => return response,
    };
    let Some(server) = servers
        .iter()
        .find(|server| server.get("host").and_then(Value::as_str) == Some(host.as_str()))
    else {
        // Only a host the list knows can be opened: the id is stable, so a
        // typo would otherwise leave a permanent tab dialling nowhere.
        return error(
            StatusCode::NOT_FOUND,
            &format!("Unknown SSH server: {host}"),
        );
    };
    let label = server
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(host.as_str())
        .to_string();
    spawn(
        &state,
        TerminalSpawnSpec {
            id: format!("ssh:{host}"),
            service_name: None,
            cwd: state.workspace_cwd().await,
            shell: "ssh".into(),
            args: vec!["-t".to_string(), host.clone()],
            env: Vec::new(),
            label: Some(label),
            kind: Some("shell".to_string()),
            provider: None,
        },
    )
}

/// A remote read that failed. Everything here — an unusable host, a path the
/// guard refuses, a dead link, a malformed answer — is the same 502: from the
/// browser's side they are all "the far end did not give us this".
fn unreachable(reason: String) -> Response {
    error(StatusCode::BAD_GATEWAY, &reason)
}

async fn files(uri: Uri) -> Response {
    let host = match host_of(&uri, Some("/files")) {
        Ok(host) => host,
        Err(response) => return response,
    };
    // `|| "."`, so a blank `path` is the login directory rather than an empty
    // one the guard would refuse.
    let path = query_value(&uri, "path")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| ".".to_string());
    let hidden = query_value(&uri, "hidden").as_deref() == Some("1");
    match read_remote_directory(&host, &path, hidden).await {
        Ok(directory) => Json(json!({ "ok": true, "directory": directory })).into_response(),
        Err(reason) => unreachable(reason),
    }
}

async fn file(uri: Uri) -> Response {
    let host = match host_of(&uri, Some("/file")) {
        Ok(host) => host,
        Err(response) => return response,
    };
    // No default here, and the refusal is a 400 rather than the 502 the read
    // failures use — nothing was asked for, so nothing was attempted.
    let Some(path) = query_value(&uri, "path").filter(|value| !value.is_empty()) else {
        return error(StatusCode::BAD_REQUEST, "path is required");
    };
    match read_remote_file(&host, &path).await {
        Ok(file) => Json(json!({ "ok": true, "file": file })).into_response(),
        Err(reason) => unreachable(reason),
    }
}

/// Is it there? A machine that is not reachable is a 200 saying so.
async fn probe(uri: Uri) -> Response {
    let host = match host_of(&uri, Some("/probe")) {
        Ok(host) => host,
        Err(response) => return response,
    };
    match probe_ssh_server(&host).await {
        Ok(probe) => Json(json!({ "ok": true, "probe": probe })).into_response(),
        // The host guard is the only thing that reaches here, and it is a
        // refusal of the request rather than a report about the machine.
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason),
    }
}

async fn metrics(uri: Uri) -> Response {
    let host = match host_of(&uri, Some("/metrics")) {
        Ok(host) => host,
        Err(response) => return response,
    };
    match read_remote_host_metrics(&host).await {
        Ok(metrics) => Json(json!({ "ok": true, "metrics": metrics })).into_response(),
        Err(reason) => unreachable(reason),
    }
}
