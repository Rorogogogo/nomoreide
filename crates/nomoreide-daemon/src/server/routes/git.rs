//! Read-safe Git: search, status, history, and file/worktree listing.
//!
//! Everything here answers for the *selected* repository (`AppState`'s own
//! notion of "the current one"), the same scope the dashboard's single-repo
//! views use today. The multi-repo board (`overview`, and `diff`/`identity`
//! with a `?repo=` naming a *different* registered repository) is not here
//! yet — it needs its own repository lookup, not just a cwd, and is a
//! deliberately separate increment.
//!
//! `push`, `pull`, `merge`, `rebase`, and staging live behind `nomoreide-actions`
//! and are not part of this module — see the crate's own docs for why that is a
//! crate boundary, not a naming convention.

use crate::server::app::AppState;
use crate::server::errors::error;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
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
        .route("/api/git/status", get(status))
        .route("/api/git/files", get(files))
        .route("/api/git/file-sizes", get(file_sizes))
        .route("/api/git/file", get(file))
        .route("/api/git/commit", get(commit_diff))
        .route("/api/git/commit/files", get(commit_files))
        .route("/api/git/branches", get(branches))
}
// `/api/git/graph` and `/api/git/worktrees` are deliberately not registered
// yet — see the note at the end of this file.

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusEnvelope {
    ok: bool,
    status: nomoreide_core::git_manager::GitStatus,
}

async fn status(State(state): State<AppState>) -> Response {
    let cwd = state.workspace_cwd().await;
    match GitManager::status(&cwd).await {
        Ok(status) => Json(StatusEnvelope { ok: true, status }).into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FilesEnvelope {
    ok: bool,
    files: Vec<String>,
}

async fn files(State(state): State<AppState>) -> Response {
    let cwd = state.workspace_cwd().await;
    match GitManager::list_tracked_files(&cwd).await {
        Ok(files) => Json(FilesEnvelope { ok: true, files }).into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileSizesEnvelope {
    ok: bool,
    files: Vec<nomoreide_core::git_manager::FileSizeRank>,
}

async fn file_sizes(State(state): State<AppState>) -> Response {
    let cwd = state.workspace_cwd().await;
    match GitManager::rank_files_by_size(&cwd).await {
        Ok(files) => Json(FileSizesEnvelope { ok: true, files }).into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

#[derive(Deserialize)]
struct PathQuery {
    #[serde(default)]
    path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEnvelope {
    ok: bool,
    content: String,
    truncated: bool,
    binary: bool,
    size: u64,
}

async fn file(State(state): State<AppState>, Query(query): Query<PathQuery>) -> Response {
    let path = query.path.unwrap_or_default();
    let path = path.trim();
    if path.is_empty() {
        return error(StatusCode::BAD_REQUEST, "path is required");
    }
    let cwd = state.workspace_cwd().await;
    match GitManager::read_tracked_file(&cwd, path).await {
        Ok(file) => Json(FileEnvelope {
            ok: true,
            content: file.content,
            truncated: file.truncated,
            binary: file.binary,
            size: file.size,
        })
        .into_response(),
        // The reference answers every failure here with 404 (unlike the other
        // routes' 400): a file this route can't produce reads the same whether
        // it never existed or was refused for climbing outside the repo.
        Err(reason) => error(StatusCode::NOT_FOUND, &reason.to_string()),
    }
}

#[derive(Deserialize)]
struct CommitQuery {
    #[serde(default)]
    hash: Option<String>,
    #[serde(default)]
    file: Option<String>,
}

/// Plain text, matching the reference's `sendText` — a diff is not JSON data,
/// it is a document the client renders as one.
fn text_response(body: String) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    (StatusCode::OK, headers, body).into_response()
}

async fn commit_diff(State(state): State<AppState>, Query(query): Query<CommitQuery>) -> Response {
    let Some(hash) = query.hash.as_deref().map(str::trim).filter(|hash| !hash.is_empty()) else {
        return error(StatusCode::BAD_REQUEST, "hash is required");
    };
    let file = query.file.as_deref().map(str::trim).filter(|file| !file.is_empty());
    let cwd = state.workspace_cwd().await;
    match GitManager::commit_diff(&cwd, hash, file).await {
        Ok(diff) => text_response(diff),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitFilesEnvelope {
    ok: bool,
    files: Vec<nomoreide_core::git_manager::GitFileStatus>,
}

async fn commit_files(State(state): State<AppState>, Query(query): Query<CommitQuery>) -> Response {
    let Some(hash) = query.hash.as_deref().map(str::trim).filter(|hash| !hash.is_empty()) else {
        return error(StatusCode::BAD_REQUEST, "hash is required");
    };
    let cwd = state.workspace_cwd().await;
    match GitManager::commit_files(&cwd, hash).await {
        Ok(files) => Json(CommitFilesEnvelope { ok: true, files }).into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchesEnvelope {
    ok: bool,
    branches: Vec<nomoreide_core::git_manager::GitBranch>,
}

async fn branches(State(state): State<AppState>) -> Response {
    let cwd = state.workspace_cwd().await;
    match GitManager::branches(&cwd).await {
        Ok(branches) => Json(BranchesEnvelope { ok: true, branches }).into_response(),
        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    }
}

// `/api/git/graph` is not served yet: the reference computes a git-graph
// *layout* (lane/edge assignment for the visual DAG, `git-graph-layout.ts`,
// 126 lines) on top of the raw log, not just the flat commit list
// `GitManager::graph` already returns for other callers. Porting the layout
// algorithm is its own increment.
//
// `/api/git/worktrees` is not served yet either: the reference route uses
// `GitWorktreeManager`, which reports `createdAt`, `primary`, and `dirty`
// per worktree — none of which `GitManager::worktrees` (built for the
// simpler `nomoreide_git_worktrees` MCP tool) computes. Serving the plain
// shape would look plausible and be silently wrong on every field the
// dashboard's worktree cards actually render.
