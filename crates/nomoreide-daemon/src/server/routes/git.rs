//! Git search: find a file by name, find a string inside the files.
//!
//! The first `/api/git/*` endpoints the native daemon serves. The rest of the
//! git surface still answers from the TypeScript daemon until the dashboard
//! moves across, so this module is deliberately narrow — it owns the two
//! searches and nothing else, and the reads beside them will join it here
//! rather than anywhere new.
//!
//! Both are `GET`, like every other git read: they change nothing, and a
//! repeated query is meant to be a repeated question.

use crate::server::app::AppState;
use crate::server::errors::error;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use nomoreide_core::git_manager::{
    ContentSearchOptions, ContentSearchResult, FileNameMatch, GitManager,
};
use serde::{Deserialize, Serialize};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/git/search/files", get(search_files))
        .route("/api/git/search/content", get(search_content))
}

/// How many paths the file palette shows before it stops listing.
const DEFAULT_FILE_LIMIT: usize = 50;
const MAX_FILE_LIMIT: usize = 500;

/// How many content hits one search returns. The ceiling is what stops a query
/// like `e` from turning a repository into a response body.
const DEFAULT_CONTENT_LIMIT: usize = 500;
const MAX_CONTENT_LIMIT: usize = 2_000;

/// Every parameter arrives as a string and is read leniently, the way the rest
/// of the daemon reads a query: unparsable is not a refusal, it is the default.
/// A search box sends whatever the user has typed so far, and answering "400"
/// to a half-typed limit would be a worse experience than answering the
/// question they were actually asking.
#[derive(Deserialize)]
struct FileQuery {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    limit: Option<String>,
}

#[derive(Deserialize)]
struct ContentQuery {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    regex: Option<String>,
    #[serde(default)]
    case: Option<String>,
    #[serde(default)]
    word: Option<String>,
    #[serde(default)]
    include: Option<String>,
    #[serde(default)]
    limit: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileSearchEnvelope {
    ok: bool,
    files: Vec<FileNameMatch>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContentSearchEnvelope {
    ok: bool,
    #[serde(flatten)]
    result: ContentSearchResult,
}

async fn search_files(State(state): State<AppState>, Query(query): Query<FileQuery>) -> Response {
    let cwd = state.workspace_cwd().await;
    let limit = clamp(query.limit, DEFAULT_FILE_LIMIT, MAX_FILE_LIMIT);
    match GitManager::search_files(&cwd, &query.q.unwrap_or_default(), limit).await {
        Ok(files) => Json(FileSearchEnvelope { ok: true, files }).into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

async fn search_content(
    State(state): State<AppState>,
    Query(query): Query<ContentQuery>,
) -> Response {
    let needle = query.q.unwrap_or_default();
    // Told apart from a failed search on purpose: an empty box is the panel's
    // resting state, and the UI shows nothing rather than an error for it.
    if needle.trim().is_empty() {
        return Json(ContentSearchEnvelope {
            ok: true,
            result: ContentSearchResult {
                files: Vec::new(),
                total_matches: 0,
                truncated: false,
            },
        })
        .into_response();
    }

    let options = ContentSearchOptions {
        regex: flag(query.regex),
        case_sensitive: flag(query.case),
        whole_word: flag(query.word),
        include: query.include.unwrap_or_default(),
        limit: clamp(query.limit, DEFAULT_CONTENT_LIMIT, MAX_CONTENT_LIMIT),
    };

    let cwd = state.workspace_cwd().await;
    match GitManager::search_content(&cwd, &needle, &options).await {
        // A malformed regex reaches here, and it is the user's own typing
        // rather than a fault — 400 with the message the regex engine wrote, so
        // the panel can put it under the input.
        Ok(result) => Json(ContentSearchEnvelope { ok: true, result }).into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

/// A toggle is on when it is present and says so. Anything else is off, so an
/// absent parameter and a stale `regex=false` mean the same thing.
fn flag(value: Option<String>) -> bool {
    matches!(value.as_deref(), Some("1" | "true"))
}

/// Read a limit the way the timeline and the error inbox read theirs: missing,
/// unparsable, or not positive falls back to the default, and nobody can ask
/// for more than the ceiling.
fn clamp(value: Option<String>, default: usize, max: usize) -> usize {
    value
        .and_then(|limit| limit.parse::<usize>().ok())
        .filter(|limit| *limit > 0)
        .map_or(default, |limit| limit.min(max))
}
