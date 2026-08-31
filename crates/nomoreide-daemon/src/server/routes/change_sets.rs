//! Agent change-sets: what a recorded agent session touched, and putting it
//! back.
//!
//! A change-set is a session the MCP recording wrapper wrote, pinned to the
//! snapshot taken before its first tool call. Nothing here writes one — these
//! four routes read the store and hand its sha to a `SnapshotManager`.
//!
//! **The manager is built from the session's own `repoPath`**, not from the
//! selected repository. An agent works where it works, and the dashboard may
//! well have moved on since; restoring into whatever happens to be selected now
//! would put one repository's files into another.
//!
//! **The id is never decoded.** Every other `:id` in this daemon runs through
//! `decodeURIComponent`; these three compare the raw path segment against the
//! stored id. So a session stored as `a%2Fb` is reachable only by sending
//! `a%252Fb`, and one whose id holds a real `/` is not reachable at all. That
//! is the reference's behaviour and it is load-bearing in one direction: an id
//! is matched against a string, never used to build a path, so the usual reason
//! to decode carefully does not apply.

use crate::server::app::AppState;
use crate::server::body::parse_query;
use crate::server::errors::{error, method_not_allowed};
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use nomoreide_core::agent_sessions::{
    default_store_path, find_agent_session, list_agent_sessions, AgentSession,
};
use nomoreide_core::snapshot_manager::SnapshotManager;
use serde_json::{json, Value};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/agent/change-sets", get(list))
        .route(
            "/api/agent/change-sets/:id",
            get(read).fallback(method_not_allowed),
        )
        .route(
            "/api/agent/change-sets/:id/restore",
            post(restore).fallback(method_not_allowed),
        )
        .route(
            "/api/agent/change-sets/:id/diff",
            get(diff).fallback(method_not_allowed),
        )
}

async fn list() -> Response {
    let sessions = sessions().await;
    Json(json!({ "ok": true, "sessions": sessions })).into_response()
}

/// A session and what has changed since its snapshot.
///
/// A session with **no** snapshot is a success carrying an empty file list, not
/// a refusal: it was recorded before a snapshot could be taken, which is a fact
/// about the session rather than a failure to read it. The two sub-routes below
/// take the opposite view, because there is nothing for them to do without one.
async fn read(uri: Uri) -> Response {
    let Some(session) = named(&uri).await else {
        return error(StatusCode::NOT_FOUND, "Unknown session");
    };
    let Some(sha) = session.snapshot_sha.clone() else {
        return Json(json!({ "ok": true, "session": session, "files": [] })).into_response();
    };
    match SnapshotManager::new(session.repo_path.clone())
        .changed_files(&sha)
        .await
    {
        Ok(files) => {
            Json(json!({ "ok": true, "session": session, "files": files })).into_response()
        }
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

async fn restore(uri: Uri) -> Response {
    let Some((session, sha)) = pinned(&uri).await else {
        return error(StatusCode::NOT_FOUND, "Session has no snapshot");
    };
    match SnapshotManager::new(session.repo_path).restore(&sha).await {
        // Spread into the envelope rather than nested under a key, matching the
        // snapshot route this one delegates to.
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

async fn diff(uri: Uri) -> Response {
    let Some((session, sha)) = pinned(&uri).await else {
        return error(StatusCode::NOT_FOUND, "Session has no snapshot");
    };
    let query = parse_query(&uri);
    let path = query
        .get("path")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    match SnapshotManager::new(session.repo_path)
        .diff(&sha, path)
        .await
    {
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

/// A session that has a snapshot to work from.
///
/// **An unknown session and a session with no snapshot are the same answer**,
/// with the same wording. The reference reads `session?.snapshotSha` and cannot
/// tell them apart, and the message it settles on names the snapshot rather
/// than the session — so a caller asking about a session that never existed is
/// told it has no snapshot. Reproduced rather than improved: the dashboard
/// reads the message.
async fn pinned(uri: &Uri) -> Option<(AgentSession, String)> {
    let session = named(uri).await?;
    let sha = session.snapshot_sha.clone()?;
    Some((session, sha))
}

async fn named(uri: &Uri) -> Option<AgentSession> {
    let id = id_from(uri)?;
    tokio::task::spawn_blocking(move || find_agent_session(&default_store_path(), &id))
        .await
        .ok()
        .flatten()
}

async fn sessions() -> Vec<AgentSession> {
    tokio::task::spawn_blocking(|| list_agent_sessions(&default_store_path()))
        .await
        .unwrap_or_default()
}

/// The raw id segment, undecoded on purpose. See the module comment.
fn id_from(uri: &Uri) -> Option<String> {
    uri.path()
        .split('/')
        .nth(4)
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
}
