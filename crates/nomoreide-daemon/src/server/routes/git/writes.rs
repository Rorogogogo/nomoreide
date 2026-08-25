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
        .route("/api/git/branches/switch", post(switch_branch))
        .route("/api/git/branches/delete", post(delete_branch))
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

/// Switch the selected repository to a branch.
///
/// **No error branch, on purpose**, the same as `fetch` above: the reference
/// route has no try/catch, so a name that does not resolve — and a missing
/// `name` — leave the dispatcher to answer 500. `delete` below catches
/// everything and answers 400. The asymmetry is the reference's, and it is why
/// the two live next to each other rather than sharing a helper.
///
/// The repository is always the selected one. `switch` takes no `repo`, so a
/// caller sending one is ignored rather than obeyed.
async fn switch_branch(State(state): State<AppState>, body: Bytes) -> Response {
    let form = parse_form(&body);
    let Ok(name) = required(&form, "name") else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "name is required");
    };
    let cwd = state.workspace_cwd().await;
    match GitManager::switch_branch(&cwd, &name).await {
        Ok(output) => Json(OutputEnvelope { ok: true, output }).into_response(),
        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    }
}

/// Delete a branch, from a named repository or from the selected one.
///
/// `git branch -d`, never `-D`: a branch holding commits that are reachable
/// from nowhere else is refused rather than dropped. Discarding that work needs
/// a surface of its own, and this is not it.
///
/// The repository is resolved **before** the name is read, which is the
/// reference's order and shows: an unknown `repo` with no `name` at all reports
/// the repository, not the missing field.
async fn delete_branch(State(state): State<AppState>, body: Bytes) -> Response {
    let form = parse_form(&body);
    let cwd = match resolve_repo_cwd(&state, form.get("repo").map(String::as_str)).await {
        Ok((cwd, _)) => cwd,
        Err(response) => return response,
    };
    let name = match required(&form, "name") {
        Ok(name) => name,
        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason),
    };
    match GitManager::delete_branch(&cwd, &name).await {
        Ok(output) => Json(OutputEnvelope { ok: true, output }).into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

/// A form field the route cannot proceed without, trimmed, where blank counts
/// as absent.
fn required(form: &std::collections::HashMap<String, String>, key: &str) -> Result<String, String> {
    form.get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{key} is required"))
}
