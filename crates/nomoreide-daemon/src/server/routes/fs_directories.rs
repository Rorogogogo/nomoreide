//! The directory picker's one endpoint.
//!
//! `path` falls back to the daemon's own working directory when it is absent or
//! blank — not to the selected repository, which is what most routes here mean
//! by "cwd". The picker is a filesystem browser, so it starts where the daemon
//! was launched.
//!
//! `files` is compared to the literal string `"1"`, so `files=true` and
//! `files=0` both leave files out. A failed read is not handled at all: it
//! escapes to the dispatcher as a 500 carrying the message, because the
//! reference has no answer for a directory that is not there.

use crate::server::app::AppState;
use crate::server::body::parse_query;
use crate::server::errors::error;
use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use nomoreide_core::directories::list_directories;

pub(crate) fn routes() -> Router<AppState> {
    Router::new().route("/api/fs/directories", get(browse))
}

async fn browse(State(state): State<AppState>, uri: Uri) -> Response {
    let _ = &state;
    let query = parse_query(&uri);
    let cwd = std::env::current_dir()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let requested = query
        .get("path")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(&cwd);
    let include_files = query.get("files").map(String::as_str) == Some("1");

    match list_directories(requested, &cwd, include_files).await {
        Ok(listing) => Json(listing).into_response(),
        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason),
    }
}
