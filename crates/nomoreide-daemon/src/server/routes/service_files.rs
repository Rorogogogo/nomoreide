//! A file editor scoped to one service's working directory.
//!
//! Four routes — detect, browse, read/write one file, and report whether a
//! running process is using stale configuration. Three refusals here look alike
//! and are not, and the difference is the reference's structure rather than a
//! decision:
//!
//! - a service that is **not registered** throws out of the helper that reads
//!   its `cwd`, and no route catches it, so it escapes as a **500** whose
//!   message says "not found";
//! - a service that **is** registered but has no `cwd` is a handled **400**
//!   whose message says "has no working directory";
//! - a path that climbs out of that directory is a **400** from the path check,
//!   with a third wording again.
//!
//! Only the middle one is a status a caller could have guessed.

use crate::server::app::AppState;
use crate::server::body::{parse_query, read_json_object};
use crate::server::errors::{error, method_not_allowed};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use nomoreide_core::config_files::{
    browse_directory, detect_config_files, resolve_config_file, ConfigFileFormat, ConfigFileInfo,
};
use nomoreide_core::env_file::{self, EnvEntry};
use serde_json::{json, Value};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/services/:name/config-files",
            get(config_files).fallback(method_not_allowed),
        )
        .route(
            "/api/services/:name/config-browse",
            get(config_browse).fallback(method_not_allowed),
        )
        // GET *and* PUT on one handler, plus its own 405 for anything else.
        .route(
            "/api/services/:name/config-file",
            get(config_file)
                .put(config_file)
                .fallback(method_not_allowed),
        )
        .route(
            "/api/services/:name/env/runtime",
            get(env_runtime).fallback(method_not_allowed),
        )
}

/// The service's working directory, or the response that stands in for it.
///
/// The two failures are not interchangeable: an unregistered name is a thrown
/// error in the reference and reaches the dispatcher, while a registered
/// service with no `cwd` is handled where it is found.
async fn service_cwd(state: &AppState, name: &str) -> Result<String, Response> {
    let config = state.config_store.load().await.map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to load NoMoreIDE config.",
        )
    })?;
    let Some(service) = config.services.iter().find(|s| s.name == name) else {
        return Err(error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Service \"{name}\" not found."),
        ));
    };
    service.cwd.clone().ok_or_else(|| {
        error(
            StatusCode::BAD_REQUEST,
            &format!("Service \"{name}\" has no working directory."),
        )
    })
}

async fn config_files(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    let cwd = match service_cwd(&state, &name).await {
        Ok(cwd) => cwd,
        Err(response) => return response,
    };
    let files = detect_config_files(&cwd).await;
    Json(json!({ "ok": true, "cwd": cwd, "files": files })).into_response()
}

async fn config_browse(
    State(state): State<AppState>,
    Path(name): Path<String>,
    uri: Uri,
) -> Response {
    let cwd = match service_cwd(&state, &name).await {
        Ok(cwd) => cwd,
        Err(response) => return response,
    };
    // A blank `path` is not a path: it means the root, the same as sending none.
    let requested = parse_query(&uri)
        .remove("path")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    match browse_directory(&cwd, requested.as_deref()).await {
        Ok(result) => {
            let mut value = serde_json::to_value(result).unwrap_or_else(|_| json!({}));
            if let Value::Object(map) = &mut value {
                map.insert("ok".to_string(), Value::Bool(true));
            }
            Json(value).into_response()
        }
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

/// The payload both a read and a write answer with, minus the format-specific
/// half. Kept in one place because a PUT answers with exactly what a following
/// GET would return.
fn file_envelope(file: &ConfigFileInfo, exists: bool) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    map.insert("ok".to_string(), Value::Bool(true));
    map.insert("exists".to_string(), Value::Bool(exists));
    map.insert(
        "format".to_string(),
        serde_json::to_value(file.format).unwrap_or(Value::Null),
    );
    map.insert("path".to_string(), Value::String(file.path.clone()));
    map.insert(
        "relativePath".to_string(),
        Value::String(file.relative_path.clone()),
    );
    map
}

fn env_entries(lines: &[env_file::EnvLine]) -> Value {
    Value::Array(
        env_file::entries(lines)
            .into_iter()
            .map(|entry| {
                json!({
                    "key": entry.key,
                    "value": entry.value,
                    "secret": env_file::looks_secret(&entry.key),
                })
            })
            .collect(),
    )
}

async fn config_file(
    State(state): State<AppState>,
    Path(name): Path<String>,
    method: Method,
    uri: Uri,
    body: Bytes,
) -> Response {
    let cwd = match service_cwd(&state, &name).await {
        Ok(cwd) => cwd,
        Err(response) => return response,
    };
    let Some(requested) = parse_query(&uri)
        .remove("path")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return error(StatusCode::BAD_REQUEST, "path is required");
    };
    let file = match resolve_config_file(&cwd, &requested) {
        Ok(file) => file,
        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason.to_string()),
    };

    if method == Method::GET {
        return read_file(&file).await;
    }
    write_file(&file, &body).await
}

async fn read_file(file: &ConfigFileInfo) -> Response {
    let mut map = file_envelope(file, false);
    if file.format == ConfigFileFormat::Env {
        let lines = env_file::read(&file.path).await.ok().flatten();
        map.insert("exists".to_string(), Value::Bool(lines.is_some()));
        map.insert(
            "entries".to_string(),
            env_entries(&lines.unwrap_or_default()),
        );
        return Json(Value::Object(map)).into_response();
    }
    let content = tokio::fs::read_to_string(&file.path).await.ok();
    map.insert("exists".to_string(), Value::Bool(content.is_some()));
    map.insert(
        "content".to_string(),
        Value::String(content.unwrap_or_default()),
    );
    Json(Value::Object(map)).into_response()
}

/// A write, which is two quite different operations behind one route.
///
/// An `.env` file is **merged**, not replaced: the caller sends entries and the
/// file's comments, blank lines and unreadable lines stay where they were. Any
/// other format is replaced wholesale with the text it was sent, and a JSON
/// file is parsed first so a save cannot leave the file unloadable.
async fn write_file(file: &ConfigFileInfo, body: &Bytes) -> Response {
    let payload = read_json_object(body);
    if file.format == ConfigFileFormat::Env {
        let entries = match parse_env_entries(&payload) {
            Ok(entries) => entries,
            // Unwrapped in the reference, so it escapes as a 500.
            Err(reason) => return error(StatusCode::INTERNAL_SERVER_ERROR, &reason),
        };
        let existing = env_file::read(&file.path).await.ok().flatten();
        let merged = env_file::merge_entries(&existing.unwrap_or_default(), &entries);
        if env_file::write(&file.path, &merged).await.is_err() {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to write the file.",
            );
        }
        let mut map = file_envelope(file, true);
        map.insert("entries".to_string(), env_entries(&merged));
        return Json(Value::Object(map)).into_response();
    }

    let Some(content) = payload.get("content").and_then(Value::as_str) else {
        return error(StatusCode::BAD_REQUEST, "content must be a string");
    };
    if file.format == ConfigFileFormat::Json {
        // The reference wraps its engine's own parse diagnostic, so the message
        // a user reads is V8's. `js_json` reproduces that wording, which is why
        // the check is here rather than in the core module's `validate_json`.
        if let Err(reason) = crate::server::js_json::parse(content) {
            return error(StatusCode::BAD_REQUEST, &format!("Invalid JSON: {reason}"));
        }
    }
    if let Some(parent) = std::path::Path::new(&file.path).parent() {
        if tokio::fs::create_dir_all(parent).await.is_err() {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to write the file.",
            );
        }
    }
    if tokio::fs::write(&file.path, content).await.is_err() {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to write the file.",
        );
    }
    let mut map = file_envelope(file, true);
    map.insert("content".to_string(), Value::String(content.to_string()));
    Json(Value::Object(map)).into_response()
}

/// Entries out of the request body, refusing anything that is not exactly a
/// list of `{key, value}` string pairs.
///
/// Every refusal here is **unwrapped in the reference**, so each one escapes as
/// a 500 rather than the 400 a validation failure normally gets. That is worth
/// keeping rather than tidying: the editor is the only caller, it never sends
/// these shapes, and a 400 would suggest a contract that was thought about.
///
/// A duplicate key is refused too. A merge folds entries into existing lines by
/// key, so two entries naming the same key have no defined result — the file
/// would keep whichever the loop reached last.
fn parse_env_entries(payload: &Value) -> Result<Vec<EnvEntry>, String> {
    // `typeof [] === "object"`, so an array passes this check in the reference
    // and is refused by the *next* one, for not having an `entries` array —
    // a different message. Mirrored rather than tightened.
    //
    // The branch is in fact unreachable: `read_json_object` already turns
    // every body that is neither an object nor an array into `{}`. It is kept
    // so that loosening that reader cannot silently change this route.
    if !(payload.is_object() || payload.is_array()) {
        return Err("entries array is required.".to_string());
    }
    let Some(list) = payload.get("entries").and_then(Value::as_array) else {
        return Err("entries must be an array.".to_string());
    };
    let mut seen: Vec<String> = Vec::new();
    let mut result = Vec::with_capacity(list.len());
    for item in list {
        if !item.is_object() {
            return Err("each entry must be { key, value }.".to_string());
        }
        let key = item.get("key").and_then(Value::as_str);
        let valid = key.is_some_and(is_env_key);
        if !valid {
            let rendered = item
                .get("key")
                .map(|value| value.to_string())
                .unwrap_or_else(|| "undefined".to_string());
            return Err(format!("invalid env key: {rendered}"));
        }
        let key = key.unwrap_or_default().to_string();
        let Some(value) = item.get("value").and_then(Value::as_str) else {
            return Err(format!("value for \"{key}\" must be a string."));
        };
        if seen.contains(&key) {
            return Err(format!("duplicate env key: {key}"));
        }
        seen.push(key.clone());
        result.push(EnvEntry {
            key,
            value: value.to_string(),
        });
    }
    Ok(result)
}

/// `^[A-Za-z_][A-Za-z0-9_.]*$`, by hand.
fn is_env_key(key: &str) -> bool {
    let mut characters = key.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && characters.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

/// Whether a running process is running on configuration that has since been
/// edited.
///
/// A process bakes its environment in at exec time, so an edited `.env` only
/// takes effect on the next launch. Nothing here is stale unless the service is
/// actually running: a stopped service has no old values to be wrong about.
async fn env_runtime(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    let cwd = match service_cwd(&state, &name).await {
        Ok(cwd) => cwd,
        Err(response) => return response,
    };
    let status = state
        .runtime
        .status()
        .into_iter()
        .find(|entry| entry.name == name);
    let running = status.as_ref().is_some_and(|entry| {
        entry.state == nomoreide_daemon_client::protocol::ServiceRuntimeState::Running
    });
    let started_at = status.and_then(|entry| entry.started_at);
    let runtime =
        nomoreide_core::config_files::runtime_env_status(&cwd, running, started_at.as_deref())
            .await;
    Json(json!({ "ok": true, "runtime": runtime })).into_response()
}
