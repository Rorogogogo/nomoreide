//! Git writes that stay local: the index, a commit, a tracked file's contents,
//! and `fetch`.
//!
//! Separate from the reads not because the reference separates them — its
//! `git-routes.ts` holds all 36 in one list — but because the split is the
//! project's own safety boundary, and a file named `writes` is harder to add a
//! read to by accident. Everything here is still reversible and local:
//! anything that reaches a remote or rewrites history lives in
//! `nomoreide-actions`, not beside these.

use super::{parse_form, read_json_object, resolve_repo_cwd, string_field};
use crate::server::app::AppState;
use crate::server::errors::error;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{post, put};
use axum::{Json, Router};
use nomoreide_core::git_manager::GitManager;
use serde::Serialize;
use serde_json::Value;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/git/fetch", post(fetch))
        .route("/api/git/file", put(write_file))
        .route("/api/git/commit", post(commit))
        .route("/api/git/stage", post(stage))
        .route("/api/git/unstage", post(unstage))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputEnvelope {
    ok: bool,
    output: String,
}

/// `git fetch --prune`, against the selected repository.
///
/// **No error branch, on purpose.** The reference route has no try/catch, so a
/// failed fetch — no remote, no network — leaves the dispatcher to answer, and
/// the dispatcher answers 500. Catching it here to return a tidier 400 would
/// diverge on every offline machine.
async fn fetch(State(state): State<AppState>) -> Response {
    let cwd = state.workspace_cwd().await;
    match GitManager::fetch(&cwd).await {
        Ok(output) => Json(OutputEnvelope { ok: true, output }).into_response(),
        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    }
}

#[derive(Serialize)]
struct OkEnvelope {
    ok: bool,
}

/// The editor's save. Both fields are checked before the repository is
/// touched, and in the reference's order: `path` first, then `content` — a
/// request missing both is told about `path`.
async fn write_file(State(state): State<AppState>, body: Bytes) -> Response {
    let body = read_json_object(&body);
    let path = string_field(&body, "path")
        .map(str::trim)
        .unwrap_or_default();
    if path.is_empty() {
        return error(StatusCode::BAD_REQUEST, "path is required");
    }
    // Absent and non-string are the same answer: the reference reads
    // `typeof body.content === "string" ? … : null` and reports the null.
    let Some(content) = string_field(&body, "content") else {
        return error(StatusCode::BAD_REQUEST, "content is required");
    };
    let cwd = state.workspace_cwd().await;
    match GitManager::write_tracked_file(&cwd, path, content).await {
        Ok(()) => Json(OkEnvelope { ok: true }).into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitEnvelope {
    ok: bool,
    output: String,
    /// Who the commit was actually stamped as, or `null` when the machine's
    /// own git identity governed. The UI shows this back rather than assuming.
    author: Option<nomoreide_core::config::GithubIdentityDef>,
}

/// Commit the index.
///
/// **Form-encoded, not JSON** — the one write here that is, because the
/// dashboard posts it from a form. The commit is stamped with the GitHub
/// account selected for *this* repository, so a commit's author matches the
/// account that will open the pull request; with no account selected the
/// machine's identity governs and `author` comes back null.
async fn commit(State(state): State<AppState>, body: Bytes) -> Response {
    let form = parse_form(&body);
    let repo = form.get("repo").map(String::as_str);
    let (cwd, repository) = match resolve_repo_cwd(&state, repo).await {
        Ok(resolved) => resolved,
        Err(response) => return response,
    };
    let Some(message) = form
        .get("message")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return error(StatusCode::BAD_REQUEST, "message is required");
    };

    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason.to_string()),
    };
    let identity = nomoreide_core::git_identity::resolve_identity_state(
        &state.config_store,
        &config,
        repository.as_ref(),
        &cwd,
    )
    .await;

    match GitManager::commit(&cwd, message, identity.selected.as_ref()).await {
        Ok(output) => Json(CommitEnvelope {
            ok: true,
            output,
            author: identity.selected,
        })
        .into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

async fn stage(State(state): State<AppState>, body: Bytes) -> Response {
    index_move(state, &body, true).await
}

async fn unstage(State(state): State<AppState>, body: Bytes) -> Response {
    index_move(state, &body, false).await
}

/// Stage and unstage differ only in which git command runs: same body, same
/// repository resolution, same refusal when no path was named.
async fn index_move(state: AppState, body: &Bytes, staging: bool) -> Response {
    let body = read_json_object(body);
    let (cwd, _repository) = match resolve_repo_cwd(&state, string_field(&body, "repo")).await {
        Ok(resolved) => resolved,
        Err(response) => return response,
    };
    // Non-strings are dropped rather than rejected, and an absent `paths` is an
    // empty list — which the core layer then refuses, because staging nothing
    // would otherwise reach git as "stage everything".
    let paths: Vec<String> = body
        .get("paths")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let result = if staging {
        GitManager::stage(&cwd, &paths).await
    } else {
        GitManager::unstage(&cwd, &paths).await
    };
    match result {
        Ok(output) => Json(OutputEnvelope { ok: true, output }).into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}
