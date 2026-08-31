//! Working-tree checkpoints: taking them, reading them, and putting one back.
//!
//! **Every failure here is a 400.** Each route wraps its work in one catch and
//! answers with the message, so a sha that is not a snapshot, a git command
//! that failed, and a repository that is not a repository are the same status.
//! The two guards in front of that — a wrong method, and a sha that is not
//! hexadecimal — are 405 and 400 respectively, and they run *before* the
//! repository is even resolved.
//!
//! **The sha is checked as it arrived, not as it decodes.** These are pattern
//! routes in the reference and its patterns hand the handler the raw segment,
//! so `%61bcd` is not `abcd` — it fails the hexadecimal test and is refused.
//! Mirrored, because a route that decoded first would accept shas this one
//! rejects.
//!
//! **`restore` is the destructive one**, and it is the reason the sha guard
//! matters: `SnapshotManager::find` refuses anything outside the snapshot
//! namespace, so no caller reaches an arbitrary commit through this route.

use crate::server::app::AppState;
use crate::server::body::{parse_query, read_json_object};
use crate::server::errors::{error, method_not_allowed};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use nomoreide_core::snapshot_manager::{SnapshotManager, DEFAULT_KEEP};
use serde_json::{json, Value};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/snapshots", get(list).post(create))
        .route(
            "/api/snapshots/:sha",
            axum::routing::delete(remove)
                .patch(rename)
                .fallback(method_not_allowed),
        )
        .route(
            "/api/snapshots/:sha/files",
            get(changed_files).fallback(method_not_allowed),
        )
        .route(
            "/api/snapshots/:sha/diff",
            get(diff).fallback(method_not_allowed),
        )
        .route(
            "/api/snapshots/:sha/restore",
            post(restore).fallback(method_not_allowed),
        )
}

/// What a label becomes when the caller sent nothing usable.
const DEFAULT_LABEL: &str = "manual snapshot";

/// The reference's `/^[0-9a-f]{4,40}$/i`.
fn valid_sha(sha: &str) -> bool {
    (4..=40).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit())
}

/// The `:sha` segment exactly as the request spelled it.
fn sha_from(uri: &Uri) -> Option<String> {
    let path = uri.path().strip_prefix("/api/snapshots/")?;
    let segment = path.split('/').next()?;
    (!segment.is_empty()).then(|| segment.to_string())
}

/// The sha guard, shared by every route that names one. Reports the *reason*
/// rather than a built response, so the refusal is one small value rather than
/// a whole `Response` sitting in every one of these routes' `Result`s.
fn checked_sha(uri: &Uri) -> Result<String, &'static str> {
    match sha_from(uri) {
        Some(sha) if valid_sha(&sha) => Ok(sha),
        _ => Err("Invalid snapshot sha"),
    }
}

async fn manager_for(state: &AppState) -> SnapshotManager {
    SnapshotManager::new(state.workspace_cwd().await)
}

async fn list(State(state): State<AppState>) -> Response {
    match manager_for(&state).await.list().await {
        Ok(snapshots) => Json(json!({ "ok": true, "snapshots": snapshots })).into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

/// Take a snapshot, then prune. The prune is part of taking one rather than a
/// separate chore: the ref namespace is only ever grown from here.
async fn create(State(state): State<AppState>, body: Bytes) -> Response {
    let payload = read_json_object(&body);
    let label = payload
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .unwrap_or(DEFAULT_LABEL)
        .to_string();
    let manager = manager_for(&state).await;
    let snapshot = match manager.snapshot(&label).await {
        Ok(snapshot) => snapshot,
        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason.to_string()),
    };
    // A prune that fails fails the request, even though the snapshot was
    // already taken — the reference has both inside one try.
    if let Err(reason) = manager.prune(DEFAULT_KEEP).await {
        return error(StatusCode::BAD_REQUEST, &reason.to_string());
    }
    Json(json!({ "ok": true, "snapshot": snapshot })).into_response()
}

async fn remove(State(state): State<AppState>, uri: Uri) -> Response {
    let sha = match checked_sha(&uri) {
        Ok(sha) => sha,
        Err(reason) => return error(StatusCode::BAD_REQUEST, reason),
    };
    match manager_for(&state).await.delete(&sha).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

async fn rename(State(state): State<AppState>, uri: Uri, body: Bytes) -> Response {
    let sha = match checked_sha(&uri) {
        Ok(sha) => sha,
        Err(reason) => return error(StatusCode::BAD_REQUEST, reason),
    };
    // Read **after** the sha is judged and **before** the repository is
    // resolved, and a blank label is refused rather than defaulted — unlike
    // taking a snapshot, where a blank one means "call it something".
    let payload = read_json_object(&body);
    let label = payload
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if label.is_empty() {
        return error(StatusCode::BAD_REQUEST, "A label is required");
    }
    match manager_for(&state).await.rename(&sha, &label).await {
        Ok(snapshot) => Json(json!({ "ok": true, "snapshot": snapshot })).into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

async fn changed_files(State(state): State<AppState>, uri: Uri) -> Response {
    let sha = match checked_sha(&uri) {
        Ok(sha) => sha,
        Err(reason) => return error(StatusCode::BAD_REQUEST, reason),
    };
    match manager_for(&state).await.changed_files(&sha).await {
        Ok(files) => Json(json!({ "ok": true, "files": files })).into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

/// The patch, as text. The only route in this module whose success is not JSON
/// — a diff is read by a viewer, and wrapping it in a string field would mean
/// escaping every newline in it.
async fn diff(State(state): State<AppState>, uri: Uri) -> Response {
    let sha = match checked_sha(&uri) {
        Ok(sha) => sha,
        Err(reason) => return error(StatusCode::BAD_REQUEST, reason),
    };
    let query = parse_query(&uri);
    let path = query
        .get("path")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    match manager_for(&state).await.diff(&sha, path).await {
        Ok(patch) => (
            [(
                axum::http::header::CONTENT_TYPE,
                "text/plain; charset=utf-8",
            )],
            patch,
        )
            .into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

async fn restore(State(state): State<AppState>, uri: Uri) -> Response {
    let sha = match checked_sha(&uri) {
        Ok(sha) => sha,
        Err(reason) => return error(StatusCode::BAD_REQUEST, reason),
    };
    match manager_for(&state).await.restore(&sha).await {
        // Spread into the envelope rather than nested under a key, which is how
        // the reference answers it.
        Ok(result) => {
            let mut envelope = json!({ "ok": true });
            if let (Some(object), Ok(Value::Object(fields))) =
                (envelope.as_object_mut(), serde_json::to_value(&result))
            {
                object.extend(fields);
            }
            Json(envelope).into_response()
        }
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}
