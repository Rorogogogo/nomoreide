//! What the agents have spent: the current reading, and the history of it.
//!
//! Both routes are exact, so a wrong method falls through to the SPA shell's
//! 404 rather than answering 405.
//!
//! **The working directory is part of the answer.** Claude Code keys its
//! per-project totals by absolute path, so `/api/agent/usage` reports the
//! directory the daemon was started in — not the selected repository, which is
//! a different thing that a user can change without restarting anything.

use crate::server::app::AppState;
use crate::server::routes::query::query_value;
use axum::extract::State;
use axum::http::Uri;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use nomoreide_core::usage_info::build_usage_info;
use serde_json::json;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/agent/usage", get(usage))
        .route("/api/agent/usage/history", get(history))
}

pub(crate) fn daemon_cwd() -> String {
    std::env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default()
}

async fn usage() -> Response {
    Json(json!({ "ok": true, "usage": build_usage_info(&daemon_cwd()).await })).into_response()
}

/// `since` is read once and used for both halves, because the summary is a
/// summary *of* the entries — computing them over different windows would put
/// a total on the page that the rows below it do not add up to.
async fn history(State(state): State<AppState>, uri: Uri) -> Response {
    let since = query_value(&uri, "since");
    let entries = state.usage_history.list(since.as_deref()).await;
    let summary = state.usage_history.summary(since.as_deref()).await;
    Json(json!({ "ok": true, "entries": entries, "summary": summary })).into_response()
}
