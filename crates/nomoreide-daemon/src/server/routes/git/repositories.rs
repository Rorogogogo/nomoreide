//! Which repositories NoMoreIDE knows about: registering, cloning, adopting,
//! creating, removing, selecting, and the board's pinned order.
//!
//! Everything here writes config rather than a repository — except `clone` and
//! `create`, which make one first. Those two live in `repo_onboard` and
//! `repo_create` for the same reason `GitActions` exists: they write to disk,
//! so they stay outside the read-safe manager.
//!
//! **Four of these routes have no error branch**, and that is the reference's
//! shape, not an omission: `register`, `remove`, `select`, and `board` let a
//! failure reach the dispatcher. What the dispatcher does with it is the part
//! worth knowing — it answers 400 for a `ConfigValidationError` and 500 for
//! anything else. So a relative path is a 400 while a name that is not
//! registered is a 500, and [`store_failure`] is what keeps that split.
//!
//! The routes that *do* catch answer 422, because a refused clone or create is
//! a request that was understood and could not be honoured. Even there the
//! required-field check often sits *outside* the try — `clone` reads its `url`
//! before the block — so a missing field is still a 500.

use super::{parse_form, read_json_object};
use crate::server::app::AppState;
use crate::server::errors::{config_failure, error};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, post, put};
use axum::{Json, Router};
use nomoreide_core::config::{Config, GitRepoDef};
use serde::Serialize;
use serde_json::Value;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/git/repositories", post(register))
        .route("/api/git/repositories/:name", delete(remove))
        .route("/api/git/clone", post(clone))
        .route("/api/git/adopt", post(adopt))
        .route("/api/git/create", post(create))
        .route("/api/git/select", post(select))
        .route("/api/git/board", put(board))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigEnvelope {
    ok: bool,
    config: Value,
}

fn config_envelope(config: &Config) -> Response {
    Json(ConfigEnvelope {
        ok: true,
        config: config.public_value(),
    })
    .into_response()
}

/// A required form field, or the reference's own refusal for it.
///
/// `requiredFormValue` throws `"<key> is required"`, and on the routes without
/// a try/catch that throw becomes a 500 — so this returns the status the route
/// should use rather than deciding one itself.
fn required(form: &std::collections::HashMap<String, String>, key: &str) -> Result<String, String> {
    form.get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{key} is required"))
}

/// Register a directory that is already a repository.
///
/// No error branch: a name already taken, or a path that is not a worktree,
/// surfaces as a 500. Matching the reference here matters more than the status
/// being the one you would pick.
async fn register(State(state): State<AppState>, body: Bytes) -> Response {
    let form = parse_form(&body);
    let (name, path) = match (required(&form, "name"), required(&form, "path")) {
        (Ok(name), Ok(path)) => (name, path),
        (Err(reason), _) | (_, Err(reason)) => {
            return error(StatusCode::INTERNAL_SERVER_ERROR, &reason)
        }
    };
    match state
        .config_store
        .register_git_repository(repository(name, path))
        .await
    {
        Ok(config) => config_envelope(&config),
        Err(reason) => config_failure(&reason),
    }
}

fn repository(name: String, path: String) -> GitRepoDef {
    GitRepoDef {
        name,
        path,
        active_worktree_path: None,
        github_credential: None,
        provider_projects: None,
        legacy_vercel_project_id: None,
    }
}

/// Forget a repository. The name arrives percent-encoded in the path, since a
/// repository may be named anything the user typed.
async fn remove(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    match state.config_store.remove_git_repository(&name).await {
        Ok(config) => config_envelope(&config),
        Err(reason) => config_failure(&reason),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OnboardedEnvelope {
    ok: bool,
    name: String,
    path: String,
}

/// Clone a remote repository into the managed repos directory, then register
/// it. HTTPS github.com URLs are authenticated with a stored token when there
/// is one, so a private repository works without SSH keys.
async fn clone(State(state): State<AppState>, body: Bytes) -> Response {
    let form = parse_form(&body);
    let url = match required(&form, "url") {
        Ok(url) => url,
        // Read *before* the try block in the reference, so a missing url is a
        // 500 like any uncaught throw — not the 422 the rest of this route uses.
        Err(reason) => return error(StatusCode::INTERNAL_SERVER_ERROR, &reason),
    };
    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(reason) => return error(StatusCode::UNPROCESSABLE_ENTITY, &reason.to_string()),
    };
    let token = state
        .config_store
        .get_github_token(&config, "github.com")
        .map(str::to_string);

    let cloned = nomoreide_core::repo_onboard::clone_repository(&url, None, token.as_deref()).await;
    let cloned = match cloned {
        Ok(cloned) => cloned,
        Err(reason) => return error(StatusCode::UNPROCESSABLE_ENTITY, &reason.to_string()),
    };
    if let Err(reason) = state
        .config_store
        .register_git_repository(repository(cloned.name.clone(), cloned.clone_path.clone()))
        .await
    {
        return error(StatusCode::UNPROCESSABLE_ENTITY, &reason.to_string());
    }
    Json(OnboardedEnvelope {
        ok: true,
        name: cloned.name,
        path: cloned.clone_path,
    })
    .into_response()
}

/// Adopt the repository a path already sits in.
///
/// Resolves to the worktree root first, so a service running from
/// `repo/frontend` registers `repo` rather than the subdirectory.
async fn adopt(State(state): State<AppState>, body: Bytes) -> Response {
    let form = parse_form(&body);
    let from = match required(&form, "path") {
        Ok(path) => path,
        // Outside the try/catch in the reference: this one is a 500.
        Err(reason) => return error(StatusCode::INTERNAL_SERVER_ERROR, &reason),
    };
    let Some(root) = nomoreide_core::repo_match::git_toplevel(&from).await else {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            &format!("Not inside a Git repository: {from}"),
        );
    };
    // The last non-empty segment, so a trailing slash does not name the repo "".
    let name = root
        .split('/')
        .filter(|segment| !segment.is_empty())
        .next_back()
        .unwrap_or(&root)
        .to_string();
    match state
        .config_store
        .register_git_repository(repository(name.clone(), root.clone()))
        .await
    {
        Ok(_) => Json(OnboardedEnvelope {
            ok: true,
            name,
            path: root,
        })
        .into_response(),
        Err(reason) => error(StatusCode::UNPROCESSABLE_ENTITY, &reason.to_string()),
    }
}

/// Make a new project: `mkdir`, `git init`, a README, then register it.
async fn create(State(state): State<AppState>, body: Bytes) -> Response {
    let form = parse_form(&body);
    let name = match required(&form, "name") {
        Ok(name) => name,
        Err(reason) => return error(StatusCode::UNPROCESSABLE_ENTITY, &reason),
    };
    // An empty `parentPath` means "the managed repos dir", not an empty path.
    let parent = form
        .get("parentPath")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    let created = match nomoreide_core::repo_create::create_repository(&name, parent).await {
        Ok(created) => created,
        Err(reason) => return error(StatusCode::UNPROCESSABLE_ENTITY, &reason.to_string()),
    };
    if let Err(reason) = state
        .config_store
        .register_git_repository(repository(created.name.clone(), created.path.clone()))
        .await
    {
        return error(StatusCode::UNPROCESSABLE_ENTITY, &reason.to_string());
    }
    Json(OnboardedEnvelope {
        ok: true,
        name: created.name,
        path: created.path,
    })
    .into_response()
}

/// Choose which repository the unscoped git routes answer for.
async fn select(State(state): State<AppState>, body: Bytes) -> Response {
    let form = parse_form(&body);
    let name = match required(&form, "name") {
        Ok(name) => name,
        Err(reason) => return error(StatusCode::INTERNAL_SERVER_ERROR, &reason),
    };
    match state.config_store.select_git_repository(Some(name)).await {
        Ok(config) => config_envelope(&config),
        Err(reason) => config_failure(&reason),
    }
}

/// Pin the board's column order.
///
/// A missing or non-array `names` is a 400 — the one refusal in this module
/// the reference states outright. Non-string entries are dropped rather than
/// rejected, so a half-built list still saves what it can.
async fn board(State(state): State<AppState>, body: Bytes) -> Response {
    let body = read_json_object(&body);
    let Some(names) = body.get("names").and_then(Value::as_array) else {
        return error(StatusCode::BAD_REQUEST, "names array is required");
    };
    let names: Vec<String> = names
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    match state.config_store.set_git_board_repositories(names).await {
        // The board alone, not the whole config — the one route here that
        // answers with just what it changed.
        Ok(config) => Json(BoardEnvelope {
            ok: true,
            board: config.git_board_repositories.unwrap_or_default(),
        })
        .into_response(),
        Err(reason) => config_failure(&reason),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BoardEnvelope {
    ok: bool,
    board: Vec<String>,
}
