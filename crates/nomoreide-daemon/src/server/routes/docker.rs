//! Docker: what is on this machine, and the recoverable things to do about it.
//!
//! **One failure status.** Every read here answers 500 when the CLI refuses,
//! and so does a path the read-only guard rejects before any process starts —
//! the SSH surface calls the same refusals 502, and these two must not be
//! unified. The single exception is `file` with no `path`, which is a 400
//! because nothing was asked for.
//!
//! **The action alternation is in the path.** `start|stop|restart` are three
//! routes, not one route that validates an action, so `/pause` matches nothing
//! and reaches the shell's 404. The reference has the same alternation inside
//! its pattern, which makes its own "Unknown action" branch unreachable; that
//! branch is not reproduced, because reproducing it would mean matching a wider
//! path and answering 400 where the reference answers 404.

use crate::server::app::AppState;
use crate::server::body::decode_uri_component;
use crate::server::errors::{error, method_not_allowed};
use crate::server::routes::query::query_value;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use nomoreide_core::docker;
use nomoreide_core::js_number;
use serde_json::{json, Value};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        // Exact routes, so a wrong method falls through to the shell's 404.
        .route("/api/docker/status", get(status))
        .route("/api/docker/start", post(start))
        .route("/api/docker/containers", get(containers))
        .route("/api/docker/stats", get(stats))
        .route("/api/docker/images", get(images))
        .route("/api/docker/volumes", get(volumes))
        .route("/api/docker/networks", get(networks))
        .route(
            "/api/docker/containers/:id/files",
            get(files).fallback(method_not_allowed),
        )
        .route(
            "/api/docker/containers/:id/file",
            get(file).fallback(method_not_allowed),
        )
        .route(
            "/api/docker/containers/:id/inspect",
            get(inspect).fallback(method_not_allowed),
        )
        .route(
            "/api/docker/containers/:id/logs",
            get(logs).fallback(method_not_allowed),
        )
        .route(
            "/api/docker/containers/:id/start",
            post(action).fallback(method_not_allowed),
        )
        .route(
            "/api/docker/containers/:id/stop",
            post(action).fallback(method_not_allowed),
        )
        .route(
            "/api/docker/containers/:id/restart",
            post(action).fallback(method_not_allowed),
        )
}

/// The container id out of the path, decoded the way `decodeURIComponent`
/// decodes — a broken escape throws rather than becoming a refusal that quotes
/// a half-decoded id.
#[allow(clippy::result_large_err)]
fn id_of(uri: &Uri, trailing: &str) -> Result<String, Response> {
    let rest = uri
        .path()
        .strip_prefix("/api/docker/containers/")
        .unwrap_or_default();
    let raw = rest.strip_suffix(trailing).unwrap_or(rest);
    decode_uri_component(raw.trim_end_matches('/'))
        .ok_or_else(|| error(StatusCode::INTERNAL_SERVER_ERROR, "URI malformed"))
}

/// Whatever went wrong — the CLI, the guard, the parser — is a 500 here.
fn failed(reason: String) -> Response {
    error(StatusCode::INTERNAL_SERVER_ERROR, &reason)
}

fn envelope(field: &str, value: Value) -> Response {
    Json(json!({ "ok": true, field: value })).into_response()
}

/// `status` never fails: an unreachable daemon is part of the answer, and the
/// page needs somewhere to render "Docker is not running" that is not an error.
async fn status() -> Response {
    envelope("status", docker::docker_status().await)
}

/// 202, not 200: the launch was *asked for*. Docker Desktop takes tens of
/// seconds to come up, and the page polls `status` to find out whether it did.
async fn start() -> Response {
    match docker::start_docker_desktop().await {
        Ok(()) => (StatusCode::ACCEPTED, Json(json!({ "ok": true }))).into_response(),
        Err(reason) => failed(reason),
    }
}

async fn containers() -> Response {
    match docker::list_containers().await {
        Ok(rows) => envelope("containers", Value::Array(rows)),
        Err(reason) => failed(reason),
    }
}

async fn stats() -> Response {
    match docker::list_stats().await {
        Ok(rows) => envelope("stats", Value::Array(rows)),
        Err(reason) => failed(reason),
    }
}

async fn images() -> Response {
    match docker::list_images().await {
        Ok(rows) => envelope("images", Value::Array(rows)),
        Err(reason) => failed(reason),
    }
}

async fn volumes() -> Response {
    match docker::list_volumes().await {
        Ok(rows) => envelope("volumes", Value::Array(rows)),
        Err(reason) => failed(reason),
    }
}

async fn networks() -> Response {
    match docker::list_networks().await {
        Ok(rows) => envelope("networks", Value::Array(rows)),
        Err(reason) => failed(reason),
    }
}

async fn files(uri: Uri) -> Response {
    let id = match id_of(&uri, "/files") {
        Ok(id) => id,
        Err(response) => return response,
    };
    // `|| "."`, so a blank path is the container's working directory rather
    // than an empty one the guard would refuse.
    let path = query_value(&uri, "path")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| ".".to_string());
    let hidden = query_value(&uri, "hidden").as_deref() == Some("1");
    match docker::read_container_directory(&id, &path, hidden).await {
        Ok(directory) => envelope("directory", directory),
        Err(reason) => failed(reason),
    }
}

async fn file(uri: Uri) -> Response {
    let id = match id_of(&uri, "/file") {
        Ok(id) => id,
        Err(response) => return response,
    };
    // The only 400 on this surface: no path was asked for, so nothing was read.
    let Some(path) = query_value(&uri, "path").filter(|value| !value.is_empty()) else {
        return error(StatusCode::BAD_REQUEST, "path is required");
    };
    match docker::read_container_file(&id, &path).await {
        Ok(file) => envelope("file", file),
        Err(reason) => failed(reason),
    }
}

async fn inspect(uri: Uri) -> Response {
    let id = match id_of(&uri, "/inspect") {
        Ok(id) => id,
        Err(response) => return response,
    };
    match docker::inspect_container(&id).await {
        Ok(detail) => envelope("detail", detail),
        Err(reason) => failed(reason),
    }
}

async fn logs(uri: Uri) -> Response {
    let id = match id_of(&uri, "/logs") {
        Ok(id) => id,
        Err(response) => return response,
    };
    // `Number(searchParams.get("tail"))`: absent is null, which is zero, which
    // fails the `> 0` test — so absent, blank, zero and negative all reach the
    // default by the same route, and only a positive number is passed through.
    let tail = js_number::parse(&query_value(&uri, "tail").unwrap_or_default());
    let requested = if tail.is_finite() && tail > 0.0 {
        Some(tail)
    } else {
        None
    };
    match docker::read_container_logs(&id, requested).await {
        Ok(logs) => envelope("logs", Value::String(logs)),
        Err(reason) => failed(reason),
    }
}

/// The action is the path's own last segment, so there is nothing to validate.
async fn action(uri: Uri) -> Response {
    let path = uri.path();
    let Some(verb) = path
        .rsplit('/')
        .next()
        .filter(|verb| matches!(*verb, "start" | "stop" | "restart"))
    else {
        // Unreachable through the router, which only routes the three.
        return error(StatusCode::NOT_FOUND, "Not found");
    };
    let id = match id_of(&uri, &format!("/{verb}")) {
        Ok(id) => id,
        Err(response) => return response,
    };
    match docker::container_action(&id, verb).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(reason) => failed(reason),
    }
}
