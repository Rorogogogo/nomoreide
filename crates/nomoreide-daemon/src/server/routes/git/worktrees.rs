//! Creating, selecting, removing, and pruning worktrees.
//!
//! All four answer for the *selected* repository and 404 when there is none —
//! unlike the rest of git, where "no repository selected" falls back to the
//! daemon's own cwd. There is no sensible fallback for "add a worktree to
//! which project", so the reference does not invent one.
//!
//! Removal is the only route in git that consults the rest of the daemon. A
//! worktree with a terminal open inside it, or a running service, is one whose
//! removal would pull the ground out from under something already using it —
//! so those are refused with 409 before git is asked.

use super::{read_json_object, string_field};
use crate::server::app::AppState;
use crate::server::errors::error;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{post, put};
use axum::{Json, Router};
use nomoreide_core::config::{Config, GitRepoDef};
use nomoreide_core::git_manager::{GitManager, GitWorktree};
use nomoreide_daemon_client::protocol::ServiceRuntimeState;
use serde::Serialize;
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/git/worktrees", post(create).delete(remove))
        .route("/api/git/worktrees/active", put(select))
        .route("/api/git/worktrees/prune", post(prune))
}

/// The selected repository, or the 404 every route here answers without one.
async fn selected_repository(state: &AppState) -> Result<(Config, GitRepoDef), Response> {
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
        .cloned()
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "No Git project is selected."))?;
    Ok((config, repository))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeEnvelope {
    ok: bool,
    worktree: GitWorktree,
}

/// Add a worktree and select it in one step.
///
/// **201, and a 422 for every failure** — not the 400 the rest of git answers
/// with. A refused create is nearly always a name git will not accept or a
/// branch already checked out somewhere, which is a request that was
/// understood and could not be honoured.
///
/// The selection happens after git succeeds, so a failed create leaves the
/// previously active worktree alone rather than pointing config at a directory
/// that was never made.
async fn create(State(state): State<AppState>, body: Bytes) -> Response {
    let body = read_json_object(&body);
    let (_config, repository) = match selected_repository(&state).await {
        Ok(resolved) => resolved,
        Err(response) => return response,
    };
    // Absent and non-string collapse to "", which the core layer refuses by
    // name rather than by type — the reference reads it the same way.
    let branch = string_field(&body, "branch").unwrap_or_default();
    // Strictly `true`: any other value, including the string "true", is off.
    let create_branch = body.get("createBranch") == Some(&Value::Bool(true));
    let base_ref = string_field(&body, "baseRef");

    let created = GitManager::create_worktree(
        &repository.path,
        Some(&repository.name),
        branch,
        create_branch,
        base_ref,
    )
    .await;
    let worktree = match created {
        Ok(worktree) => worktree,
        Err(reason) => return error(StatusCode::UNPROCESSABLE_ENTITY, &reason.to_string()),
    };
    if let Err(reason) = state
        .config_store
        .select_git_worktree(&repository.name, &worktree.path)
        .await
    {
        return error(StatusCode::UNPROCESSABLE_ENTITY, &reason.to_string());
    }
    (
        StatusCode::CREATED,
        Json(WorktreeEnvelope { ok: true, worktree }),
    )
        .into_response()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveEnvelope {
    ok: bool,
    active_path: String,
}

/// Point the repository at one of its worktrees.
///
/// Reports back the path *as given*, not as `select_git_worktree` resolved it.
/// The two differ on macOS, where the managed root sits under a symlinked
/// `/var` — and the reference echoes the request, so this does too.
async fn select(State(state): State<AppState>, body: Bytes) -> Response {
    let body = read_json_object(&body);
    let path = string_field(&body, "path").unwrap_or_default();
    let (_config, repository) = match selected_repository(&state).await {
        Ok(resolved) => resolved,
        Err(response) => return response,
    };
    match state
        .config_store
        .select_git_worktree(&repository.name, path)
        .await
    {
        Ok(_) => Json(ActiveEnvelope {
            ok: true,
            active_path: path.to_string(),
        })
        .into_response(),
        Err(reason) => error(StatusCode::UNPROCESSABLE_ENTITY, &reason.to_string()),
    }
}

#[derive(Serialize)]
struct OkEnvelope {
    ok: bool,
}

/// Remove a worktree, after checking nothing is standing in it.
///
/// The three 409s are in the reference's order, and the order is the message:
/// a caller removing the worktree they are working in is told to switch first,
/// before being told about terminals or services they would then have to close
/// anyway.
async fn remove(State(state): State<AppState>, body: Bytes) -> Response {
    let body = read_json_object(&body);
    let path = string_field(&body, "path").unwrap_or_default();
    let (config, repository) = match selected_repository(&state).await {
        Ok(resolved) => resolved,
        Err(response) => return response,
    };

    let active_path = repository
        .active_worktree_path
        .clone()
        .unwrap_or_else(|| repository.path.clone());
    if lexically_resolve(&active_path) == lexically_resolve(path) {
        return error(
            StatusCode::CONFLICT,
            "Switch to another worktree before removing this one.",
        );
    }

    if state
        .terminal
        .list_sessions()
        .iter()
        .any(|session| path_contains(path, &session.cwd))
    {
        return error(
            StatusCode::CONFLICT,
            "Close terminals using this worktree before removing it.",
        );
    }

    let running = state.runtime.status();
    let active_service = config.services.iter().find(|service| {
        service.cwd.as_deref().is_some_and(|cwd| {
            path_contains(path, cwd)
                && running.iter().any(|status| {
                    status.name == service.name && status.state == ServiceRuntimeState::Running
                })
        })
    });
    if let Some(service) = active_service {
        return error(
            StatusCode::CONFLICT,
            &format!(
                "Stop service \"{}\" before removing this worktree.",
                service.name
            ),
        );
    }

    match GitManager::remove_worktree(&repository.path, path).await {
        Ok(()) => Json(OkEnvelope { ok: true }).into_response(),
        Err(reason) => error(StatusCode::UNPROCESSABLE_ENTITY, &reason.to_string()),
    }
}

/// `git worktree prune`: forget worktrees whose directories are gone.
///
/// **No error branch**, matching the reference, which has no try/catch here —
/// a failed prune surfaces as the server's own 500.
async fn prune(State(state): State<AppState>) -> Response {
    let (_config, repository) = match selected_repository(&state).await {
        Ok(resolved) => resolved,
        Err(response) => return response,
    };
    match GitManager::prune_worktrees(&repository.path).await {
        Ok(()) => Json(OkEnvelope { ok: true }).into_response(),
        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    }
}

/// Whether `candidate` is `root` or sits under it.
///
/// Lexical, like the rest of the reference's path comparisons — see the note on
/// `paths_match` in the parent module for why canonicalizing here would be a
/// divergence rather than a fix.
///
/// **The same macOS symlink caveat applies, and it is load-bearing here.** Git
/// reports a managed worktree as `/private/var/…` while a service registered
/// from `$TMPDIR` holds the `/var/…` spelling of the same directory, and this
/// comparison finds no match — so the "stop the service first" guard does not
/// fire for that service. The parity gate reaches the guard by registering the
/// path in the form git reports; it is written down there too, because a gate
/// that silently missed this would look like it was passing.
fn path_contains(root: &str, candidate: &str) -> bool {
    let root = lexically_resolve(root);
    let candidate = lexically_resolve(candidate);
    candidate == root || candidate.starts_with(&root)
}

fn lexically_resolve(path: &str) -> PathBuf {
    let candidate = Path::new(path);
    let absolute = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(candidate)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}
