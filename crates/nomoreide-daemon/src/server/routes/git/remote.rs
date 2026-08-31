//! Git writes that reach a remote or rewrite history: `push`, `pull`, `merge`,
//! `rebase`, and "get me back to a clean default branch".
//!
//! These call `nomoreide-actions` rather than `GitManager`, which is the whole
//! point of that crate: the read-safe manager cannot express them, so no route
//! can reach them by accident. All five are form-encoded, and all five scope to
//! a named `repo` the same way the local writes do.

use super::{parse_form, resolve_repo_cwd};
use crate::server::app::AppState;
use crate::server::errors::error;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use nomoreide_actions::git::{GitActions, PushCredential};
use nomoreide_core::git_manager::GitManager;
use serde::Serialize;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/git/push", post(push))
        .route("/api/git/pull", post(pull))
        .route("/api/git/merge", post(merge))
        .route("/api/git/rebase", post(rebase))
        .route("/api/git/default-branch/pull", post(pull_default))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputEnvelope {
    ok: bool,
    output: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PushEnvelope {
    ok: bool,
    #[serde(flatten)]
    result: nomoreide_actions::git::GitPushResult,
    /// The account the push authenticated as. Absent — not null — when the
    /// machine's own credential helper answered, because the reference spreads
    /// an `undefined` here and `JSON.stringify` drops the key entirely.
    #[serde(skip_serializing_if = "Option::is_none")]
    pushed_as: Option<String>,
}

/// Push the current branch, as the account selected for *this* repository
/// rather than whichever one the machine's credential helper answers with.
///
/// `remote` only decides anything on a branch with no upstream: once one is
/// set, `git push` follows it and the field is inert. That is the reference's
/// behaviour, not an oversight here.
///
/// The credential is declined for SSH remotes and unselected repositories, and
/// those keep the machine's existing behaviour — which is why the remote's URL
/// is read first: it is what decides whether a stored token even applies.
async fn push(State(state): State<AppState>, body: Bytes) -> Response {
    let form = parse_form(&body);
    let (cwd, repository) =
        match resolve_repo_cwd(&state, form.get("repo").map(String::as_str)).await {
            Ok(resolved) => resolved,
            Err(response) => return response,
        };
    let remote = form
        .get("remote")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason.to_string()),
    };
    let remote_url = GitManager::remote_url(&cwd, remote.unwrap_or("origin"))
        .await
        .unwrap_or_default();
    let credential = nomoreide_core::git_identity::resolve_push_credential(
        &config,
        repository.as_ref(),
        remote_url.as_deref(),
    )
    .await;

    let push_credential = credential.as_ref().map(|(token, login)| PushCredential {
        token,
        username: login.as_deref(),
    });
    match GitActions::new(cwd).push(remote, push_credential).await {
        Ok(result) => Json(PushEnvelope {
            ok: true,
            result,
            pushed_as: credential.and_then(|(_, login)| login),
        })
        .into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

/// Fast-forward only — a pull that cannot silently create a merge commit.
async fn pull(State(state): State<AppState>, body: Bytes) -> Response {
    let form = parse_form(&body);
    let (cwd, _repository) =
        match resolve_repo_cwd(&state, form.get("repo").map(String::as_str)).await {
            Ok(resolved) => resolved,
            Err(response) => return response,
        };
    match GitActions::new(cwd).pull().await {
        Ok(output) => Json(OutputEnvelope { ok: true, output }).into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

async fn merge(State(state): State<AppState>, body: Bytes) -> Response {
    integrate(state, &body, Integration::Merge).await
}

async fn rebase(State(state): State<AppState>, body: Bytes) -> Response {
    integrate(state, &body, Integration::Rebase).await
}

enum Integration {
    Merge,
    Rebase,
}

/// Merge and rebase take the same body and answer the same shape; each aborts
/// its own operation on failure, down in `GitActions`, so a refused integration
/// never leaves the repository mid-conflict.
///
/// The blank-branch check below is deliberately redundant: `valid_branch_ref`
/// refuses an empty name with the *same* wording, so removing this one is
/// invisible to the parity gate. It stays because the reference checks at the
/// route too, and because a route that reads a required field should say so
/// where the field is read.
async fn integrate(state: AppState, body: &Bytes, kind: Integration) -> Response {
    let form = parse_form(body);
    let (cwd, _repository) =
        match resolve_repo_cwd(&state, form.get("repo").map(String::as_str)).await {
            Ok(resolved) => resolved,
            Err(response) => return response,
        };
    let Some(branch) = form
        .get("branch")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return error(StatusCode::BAD_REQUEST, "branch is required");
    };
    let actions = GitActions::new(cwd);
    let result = match kind {
        Integration::Merge => actions.merge(branch).await,
        Integration::Rebase => actions.rebase(branch).await,
    };
    match result {
        Ok(output) => Json(OutputEnvelope { ok: true, output }).into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PullDefaultEnvelope {
    ok: bool,
    #[serde(flatten)]
    result: nomoreide_actions::git::PullDefaultResult,
}

/// Check out the remote's default branch and fast-forward it.
///
/// Always the *selected* repository: unlike its neighbours this route reads no
/// body at all in the reference, so a `repo` field would be ignored rather
/// than honoured, and accepting one here would be a divergence dressed as a
/// convenience.
async fn pull_default(State(state): State<AppState>) -> Response {
    let cwd = state.workspace_cwd().await;
    match GitActions::new(cwd).pull_default(None).await {
        Ok(result) => Json(PullDefaultEnvelope { ok: true, result }).into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}
