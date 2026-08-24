//! Read-safe Git: search, status, history, and file/worktree listing.
//!
//! Most routes here answer for the *selected* repository. `diff` and
//! `identity` also take a `?repo=` naming a different registered one, via
//! [`resolve_repo_cwd`] — the multi-repo board scopes those two per column.
//! `overview` is the exception that reads *every* registered repository at
//! once, isolating each one's failure to its own column.
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
        .route("/api/git/overview", get(overview))
        .route("/api/git/files", get(files))
        .route("/api/git/file-sizes", get(file_sizes))
        .route("/api/git/file", get(file))
        .route("/api/git/commit", get(commit_diff))
        .route("/api/git/commit/files", get(commit_files))
        .route("/api/git/branches", get(branches))
        .route("/api/git/identity", get(identity))
        .route("/api/git/diff", get(diff))
        .route("/api/git/graph", get(graph))
        .route("/api/git/worktrees", get(worktrees))
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

/// How many repos the board shows before the user has curated it. Kept below
/// the UI's 5-column cap so the "Add" tile stays visible and nothing is
/// stranded.
const DEFAULT_BOARD_COLUMNS: usize = 4;

/// One board column. Deliberately *not* a `GitStatus`: the reference picks
/// four fields off the status and drops `upstream`, so a column carries less
/// than the single-repo `status` route does.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoOverview {
    name: String,
    /// The worktree actually read — except on failure, where it falls back to
    /// the registered path, since the failure may well be *about* the worktree.
    path: String,
    branch: String,
    ahead: i32,
    behind: i32,
    files: Vec<nomoreide_core::git_manager::GitFileStatus>,
    /// Absent on success. Its presence is what the column renders as broken.
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OverviewEnvelope {
    ok: bool,
    repos: Vec<RepoOverview>,
    board: Vec<String>,
}

/// Every registered repository's status at once, for the multi-repo board.
///
/// Two things make this unlike the other reads. The statuses are read
/// *concurrently* — the reference uses `Promise.all`, and a board of eight
/// repos would otherwise pay eight sequential `git status` walks on every
/// poll. And a repository that fails does not fail the response: it comes back
/// as a column carrying an `error`, because one repo moved out from under the
/// config should not blank the board.
async fn overview(State(state): State<AppState>) -> Response {
    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(reason) => return error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    };

    // Spawned up front and awaited in order, which keeps the fan-out
    // concurrent while the response still lists repos in config order.
    let reads: Vec<_> = config
        .git_repositories
        .iter()
        .map(|repository| {
            let name = repository.name.clone();
            let registered = repository.path.clone();
            let worktree = repository
                .active_worktree_path
                .clone()
                .unwrap_or_else(|| registered.clone());
            tokio::spawn(async move {
                match GitManager::status(&worktree).await {
                    Ok(status) => RepoOverview {
                        name,
                        path: worktree,
                        branch: status.branch,
                        ahead: status.ahead,
                        behind: status.behind,
                        files: status.files,
                        error: None,
                    },
                    Err(reason) => RepoOverview {
                        name,
                        path: registered,
                        branch: String::new(),
                        ahead: 0,
                        behind: 0,
                        files: Vec::new(),
                        error: Some(reason.to_string()),
                    },
                }
            })
        })
        .collect();

    let mut repos = Vec::with_capacity(reads.len());
    for read in reads {
        match read.await {
            Ok(repo) => repos.push(repo),
            // A panicked read has no name to report against, so it cannot
            // become a column; the reference has no equivalent (a throw is
            // already caught per-repo) and this only guards a bug in ours.
            Err(reason) => return error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
        }
    }

    // The effective board: the user's pinned order, or the first few repos
    // when they have never curated one. Either way it is filtered to names
    // that are still registered, so a repo removed since it was pinned drops
    // out rather than rendering an empty column.
    let board: Vec<String> = config
        .git_board_repositories
        .clone()
        .unwrap_or_else(|| {
            config
                .git_repositories
                .iter()
                .take(DEFAULT_BOARD_COLUMNS)
                .map(|repository| repository.name.clone())
                .collect()
        })
        .into_iter()
        .filter(|name| {
            config
                .git_repositories
                .iter()
                .any(|repository| &repository.name == name)
        })
        .collect();

    Json(OverviewEnvelope {
        ok: true,
        repos,
        board,
    })
    .into_response()
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
    let Some(hash) = query
        .hash
        .as_deref()
        .map(str::trim)
        .filter(|hash| !hash.is_empty())
    else {
        return error(StatusCode::BAD_REQUEST, "hash is required");
    };
    let file = query
        .file
        .as_deref()
        .map(str::trim)
        .filter(|file| !file.is_empty());
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
    let Some(hash) = query
        .hash
        .as_deref()
        .map(str::trim)
        .filter(|hash| !hash.is_empty())
    else {
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

#[derive(Deserialize)]
struct RepoQuery {
    #[serde(default)]
    repo: Option<String>,
}

/// One repository's working directory, resolved the way every write-scoped
/// reference route resolves it: a named `?repo=` looks the repository up by
/// name and reports 404 when it isn't registered; its absence falls back to
/// whichever repository is currently selected (via `workspace_cwd`, which may
/// be no repository at all — the daemon's own cwd).
///
/// The two paths deliberately resolve a stale active worktree differently,
/// matching the reference: the *named* path trusts `active_worktree_path`
/// outright (nothing here re-checks it still exists), while the *selected*
/// path goes through `workspace_cwd`, which already carries that same
/// unchecked trust — so the two agree, not by coincidence but because neither
/// one currently re-verifies it.
async fn resolve_repo_cwd(
    state: &AppState,
    repo: Option<&str>,
) -> Result<(String, Option<nomoreide_core::config::GitRepoDef>), Response> {
    let Some(name) = repo.map(str::trim).filter(|name| !name.is_empty()) else {
        let config = state
            .config_store
            .load()
            .await
            .map_err(|reason| error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()))?;
        let repository = config
            .selected_git_repository
            .as_ref()
            .and_then(|selected| {
                config
                    .git_repositories
                    .iter()
                    .find(|repo| &repo.name == selected)
            })
            .or_else(|| config.git_repositories.first())
            .cloned();
        return Ok((state.workspace_cwd().await, repository));
    };
    let config = state
        .config_store
        .load()
        .await
        .map_err(|reason| error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()))?;
    let Some(repository) = config
        .git_repositories
        .iter()
        .find(|repo| repo.name == name)
        .cloned()
    else {
        return Err(error(
            StatusCode::NOT_FOUND,
            &format!("Unknown repository: {name}"),
        ));
    };
    let cwd = repository
        .active_worktree_path
        .clone()
        .unwrap_or_else(|| repository.path.clone());
    Ok((cwd, Some(repository)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentityEnvelope {
    ok: bool,
    #[serde(flatten)]
    identity: nomoreide_core::git_identity::GitIdentityState,
}

/// Who a commit made here would be authored by, and whether that differs from
/// the machine's configured git identity.
async fn identity(State(state): State<AppState>, Query(query): Query<RepoQuery>) -> Response {
    let (cwd, repository) = match resolve_repo_cwd(&state, query.repo.as_deref()).await {
        Ok(resolved) => resolved,
        Err(response) => return response,
    };
    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(reason) => return error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    };
    let identity = nomoreide_core::git_identity::resolve_identity_state(
        &state.config_store,
        &config,
        repository.as_ref(),
        &cwd,
    )
    .await;
    Json(IdentityEnvelope { ok: true, identity }).into_response()
}

#[derive(Deserialize)]
struct DiffQuery {
    #[serde(default)]
    repo: Option<String>,
    #[serde(default)]
    file: Option<String>,
}

/// The working-tree diff for one file, scoped to a named or the selected
/// repository. Which diff a file gets depends on its status pair, so status is
/// read first; a path git does not report falls back to a plain `git diff`,
/// and a path with nothing to show at all is a 404 rather than an empty body.
async fn diff(State(state): State<AppState>, Query(query): Query<DiffQuery>) -> Response {
    let (cwd, _repository) = match resolve_repo_cwd(&state, query.repo.as_deref()).await {
        Ok(resolved) => resolved,
        Err(response) => return response,
    };
    let Some(file) = query
        .file
        .as_deref()
        .map(str::trim)
        .filter(|file| !file.is_empty())
    else {
        return error(StatusCode::BAD_REQUEST, "file is required");
    };

    let status = match GitManager::status(&cwd).await {
        Ok(status) => status,
        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason.to_string()),
    };
    let diff = match status.files.iter().find(|entry| entry.path == file) {
        Some(entry) => GitManager::file_diff_for_status(&cwd, entry).await.ok(),
        // The reference reaches for a plain diff here and treats a failure as
        // "nothing to show" rather than an error, so a path that is simply
        // clean reads the same as one that does not exist.
        None => GitManager::diff(&cwd, Some(file)).await.ok(),
    };
    match diff {
        Some(diff) => text_response(diff),
        None => error(StatusCode::NOT_FOUND, "No changes or file not found."),
    }
}

#[derive(Deserialize)]
struct GraphQuery {
    #[serde(default)]
    limit: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphEnvelope {
    ok: bool,
    commits: Vec<nomoreide_core::git_manager::GitGraphCommit>,
}

/// The graph's own limit, which is not the search endpoints' `clamp`: the
/// reference parses as a float and floors it, so `1.9` is 1, and anything
/// unparsable or non-positive falls back to 200 rather than to a shared
/// default.
fn graph_limit(value: Option<String>) -> usize {
    value
        .and_then(|limit| limit.trim().parse::<f64>().ok())
        .filter(|limit| limit.is_finite() && *limit > 0.0)
        .map_or(200, |limit| (limit.floor() as usize).min(2000))
}

async fn graph(State(state): State<AppState>, Query(query): Query<GraphQuery>) -> Response {
    let limit = graph_limit(query.limit);
    let cwd = state.workspace_cwd().await;
    match GitManager::graph_with_layout(&cwd, limit).await {
        Ok(commits) => Json(GraphEnvelope { ok: true, commits }).into_response(),
        // The reference has no try/catch on this route, so a throw surfaces as
        // the server's own 500 rather than a route-shaped 400.
        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreesEnvelope {
    ok: bool,
    active_path: String,
    worktrees: Vec<nomoreide_core::git_manager::GitWorktree>,
}

/// Worktrees are listed from the repository's *registered* path rather than
/// its active worktree: `git worktree list` answers identically from any of
/// them, and the registered path is the one that always exists. Unlike every
/// other read here, this route 404s when no repository is selected, because
/// there is no sensible cwd fallback for "list this repository's worktrees".
async fn worktrees(State(state): State<AppState>) -> Response {
    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(reason) => return error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    };
    let repository = config
        .selected_git_repository
        .as_ref()
        .and_then(|selected| {
            config
                .git_repositories
                .iter()
                .find(|repo| &repo.name == selected)
        })
        .or_else(|| config.git_repositories.first());
    let Some(repository) = repository.cloned() else {
        return error(StatusCode::NOT_FOUND, "No Git project is selected.");
    };

    match GitManager::worktrees(&repository.path).await {
        Ok(worktrees) => {
            // The configured active worktree may have been removed from disk
            // since it was chosen; when git no longer lists it, the repository
            // root is what is actually active.
            let configured_active = repository
                .active_worktree_path
                .clone()
                .unwrap_or_else(|| repository.path.clone());
            let active_path = if worktrees
                .iter()
                .any(|worktree| paths_match(&worktree.path, &configured_active))
            {
                configured_active
            } else {
                repository.path.clone()
            };
            Json(WorktreesEnvelope {
                ok: true,
                active_path,
                worktrees,
            })
            .into_response()
        }
        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    }
}

/// The reference compares `resolve(a) === resolve(b)`: absolute-ized and
/// lexically normalized, but *not* symlink-resolved.
///
/// **Mirrors a reference bug on purpose.** On macOS `git worktree list`
/// reports `/private/var/...` where a config written from `$TMPDIR` holds the
/// `/var/...` symlink to the same directory, so `resolve` finds no match and
/// the route reports the repository root as active even when a different
/// worktree is configured. Canonicalizing here would fix that — and diverge:
/// the two runtimes would disagree about which worktree is active, which is
/// exactly what the parity gate caught when this did canonicalize. Worth
/// fixing on both sides in one change; not fixable in Rust alone.
fn paths_match(a: &str, b: &str) -> bool {
    lexically_resolve(a) == lexically_resolve(b)
}

/// Node's `path.resolve`: make absolute, then collapse `.` and `..` without
/// touching the filesystem.
fn lexically_resolve(path: &str) -> std::path::PathBuf {
    let candidate = std::path::Path::new(path);
    let absolute = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(candidate)
    };
    let mut out = std::path::PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

// Every read-safe `/api/git/*` route the dashboard uses is now served here.
