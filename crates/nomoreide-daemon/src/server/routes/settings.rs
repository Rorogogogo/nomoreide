//! Two settings stores behind five routes.
//!
//! **Global** settings are per machine and live beside the config file.
//! **Project** preferences live in a `nomoreide.config.json` inside a
//! registered repository, so every project route has to be told which
//! repository it means — and told no when it names one that is not registered.
//!
//! That scoping is the security-shaped part. `projectPath` is canonicalised and
//! compared against the canonical path of each registered repository, so a
//! symlink pointing at a registered repo resolves *to* it and is accepted for a
//! read. A **write** additionally requires the path the caller sent to be a
//! direct directory rather than a link, and re-resolves the scope after the
//! body has been read — the body is a delay, and the directory could have been
//! swapped during it. That recheck cannot be atomic (there is no openat here
//! either), so it narrows the window rather than closing it, which is why the
//! link check exists at all.
//!
//! A path merely *inside* a registered repository is refused. The match is
//! exact, not a prefix: a repository grants access to its own root, and to
//! nothing it happens to contain.

use crate::server::app::AppState;
use crate::server::errors::error;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use nomoreide_core::app_settings::AppSettingsStore;
use nomoreide_core::config::{default_preferences, ConfigStore};
use nomoreide_core::zod_report::{report, type_name, ZodIssue};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/settings", get(read_settings))
        .route("/api/settings/global", patch(patch_global))
        .route("/api/settings/project", patch(patch_project))
        .route("/api/settings/global/reset", post(reset_global))
        .route("/api/settings/project/reset", post(reset_project))
}

fn settings_store() -> AppSettingsStore {
    AppSettingsStore::new(nomoreide_core::app_settings::default_settings_path())
}

/// A refusal the caller could have avoided. Every one of these is a 400.
fn refuse(message: &str) -> Response {
    error(StatusCode::BAD_REQUEST, message)
}

struct ProjectScope {
    root: PathBuf,
    store: ConfigStore,
}

/// Resolve `projectPath` to a registered repository, or say why not.
///
/// `Ok(None)` means the caller sent no `projectPath` at all and the route
/// allows that — reads do, writes do not.
async fn project_scope(
    state: &AppState,
    uri: &Uri,
    required: bool,
    for_write: bool,
) -> Result<Option<ProjectScope>, Response> {
    let raw = crate::server::body::parse_query(uri).remove("projectPath");
    let Some(raw) = raw else {
        return if required {
            Err(refuse("projectPath is required."))
        } else {
            Ok(None)
        };
    };
    let requested = raw.trim().to_string();
    if requested.is_empty() {
        return Err(refuse("projectPath must not be empty."));
    }
    let Ok(canonical) = tokio::fs::canonicalize(&requested).await else {
        return Err(refuse(
            "projectPath must be an existing registered repository.",
        ));
    };

    let config = state.config_store.load().await.map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to load NoMoreIDE config.",
        )
    })?;
    for repository in &config.git_repositories {
        let Ok(registered) = tokio::fs::canonicalize(&repository.path).await else {
            continue;
        };
        if registered != canonical {
            continue;
        }
        if for_write {
            require_direct_directory(&requested, &repository.path).await?;
        }
        return Ok(Some(ProjectScope {
            root: canonical.clone(),
            store: ConfigStore::new(canonical.join("nomoreide.config.json")),
        }));
    }
    Err(refuse(
        "projectPath must exactly match a registered repository.",
    ))
}

/// A write insists on the directory itself. A link that resolves to the
/// registered root is enough to *read* through, but not enough to write
/// through: the link can be repointed between the check and the write, and the
/// directory cannot.
async fn require_direct_directory(requested: &str, registered: &str) -> Result<(), Response> {
    let both = tokio::try_join!(
        tokio::fs::symlink_metadata(Path::new(requested)),
        tokio::fs::symlink_metadata(Path::new(registered)),
    );
    match both {
        Ok((left, right)) if left.is_dir() && right.is_dir() => Ok(()),
        _ => Err(refuse(
            "Project writes require an unchanged registered directory.",
        )),
    }
}

/// Re-resolve the scope after the body has been read, and refuse if it moved.
async fn revalidated(
    state: &AppState,
    uri: &Uri,
    expected: &Path,
) -> Result<ProjectScope, Response> {
    let scope = project_scope(state, uri, true, true)
        .await?
        .ok_or_else(|| refuse("projectPath is required."))?;
    if scope.root != expected {
        return Err(refuse("Registered project scope changed."));
    }
    Ok(scope)
}

async fn read_settings(State(state): State<AppState>, uri: Uri) -> Response {
    let scope = match project_scope(&state, &uri, false, false).await {
        Ok(scope) => scope,
        Err(response) => return response,
    };
    let global = match settings_store().load().await {
        Ok(global) => global,
        Err(reason) => return error(StatusCode::INTERNAL_SERVER_ERROR, &reason),
    };
    let project = match scope {
        Some(scope) => match scope.store.preferences().await {
            Ok(project) => project,
            Err(reason) => return error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
        },
        None => default_preferences(),
    };
    Json(json!({ "ok": true, "global": global, "project": project })).into_response()
}

/// The request body, which must be a JSON *object* — and an empty body is an
/// empty object rather than a refusal, because "change nothing" is a request a
/// form can legitimately make.
fn json_object(body: &Bytes) -> Result<Value, &'static str> {
    let raw = String::from_utf8_lossy(body);
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(json!({}));
    }
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Err("Request body must be valid JSON.");
    };
    if !value.is_object() {
        return Err("Request body must be a JSON object.");
    }
    Ok(value)
}

async fn patch_global(State(state): State<AppState>, body: Bytes) -> Response {
    let _ = &state;
    let patch = match json_object(&body) {
        Ok(patch) => patch,
        Err(reason) => return refuse(reason),
    };
    match settings_store().update(&patch).await {
        Ok(global) => Json(json!({ "ok": true, "global": global })).into_response(),
        Err(reason) => refuse(&reason),
    }
}

async fn patch_project(State(state): State<AppState>, uri: Uri, body: Bytes) -> Response {
    let patch = match json_object(&body) {
        Ok(patch) => patch,
        Err(reason) => return refuse(reason),
    };
    let patch = match validate_preferences_patch(&patch) {
        Ok(patch) => patch,
        Err(reason) => return refuse(&reason),
    };
    let scope = match project_scope(&state, &uri, true, true).await {
        Ok(Some(scope)) => scope,
        Ok(None) => return refuse("projectPath is required."),
        Err(response) => return response,
    };
    let scope = match revalidated(&state, &uri, &scope.root).await {
        Ok(scope) => scope,
        Err(response) => return response,
    };
    match scope.store.update_preferences(&patch).await {
        Ok(project) => Json(json!({ "ok": true, "project": project })).into_response(),
        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    }
}

async fn reset_global(State(state): State<AppState>) -> Response {
    let _ = &state;
    match settings_store().reset().await {
        Ok(global) => Json(json!({ "ok": true, "global": global })).into_response(),
        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason),
    }
}

async fn reset_project(State(state): State<AppState>, uri: Uri) -> Response {
    let scope = match project_scope(&state, &uri, true, true).await {
        Ok(Some(scope)) => scope,
        Ok(None) => return refuse("projectPath is required."),
        Err(response) => return response,
    };
    let scope = match revalidated(&state, &uri, &scope.root).await {
        Ok(scope) => scope,
        Err(response) => return response,
    };
    match scope.store.reset_preferences().await {
        Ok(project) => Json(json!({ "ok": true, "project": project })).into_response(),
        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    }
}

/// The project preferences patch schema: two optional groups, each strict.
fn validate_preferences_patch(patch: &Value) -> Result<Value, String> {
    let Some(object) = patch.as_object() else {
        return Err(report(&[ZodIssue::wrong_type(
            "object",
            type_name(patch),
            Vec::new(),
        )]));
    };
    let groups = ["logs", "database"];
    let unknown: Vec<String> = object
        .keys()
        .filter(|key| !groups.contains(&key.as_str()))
        .cloned()
        .collect();
    if !unknown.is_empty() {
        return Err(report(&[ZodIssue::unrecognized_keys(unknown, Vec::new())]));
    }

    let mut issues = Vec::new();
    for group in groups {
        let Some(fields) = object.get(group) else {
            continue;
        };
        let Some(fields) = fields.as_object() else {
            issues.push(ZodIssue::wrong_type(
                "object",
                type_name(fields),
                vec![json!(group)],
            ));
            continue;
        };
        let known: &[&str] = match group {
            "logs" => &["showTimestamps", "wrapLines"],
            _ => &["confirmWrites", "resultLimit"],
        };
        let unknown: Vec<String> = fields
            .keys()
            .filter(|key| !known.contains(&key.as_str()))
            .cloned()
            .collect();
        if !unknown.is_empty() {
            return Err(report(&[ZodIssue::unrecognized_keys(
                unknown,
                vec![json!(group)],
            )]));
        }
        for key in known {
            let Some(value) = fields.get(*key) else {
                continue;
            };
            let path = vec![json!(group), json!(key)];
            if *key == "resultLimit" {
                issues.extend(nomoreide_core::app_settings::bounded(
                    value, 10, 5_000, path,
                ));
            } else if !value.is_boolean() {
                issues.push(ZodIssue::wrong_type("boolean", type_name(value), path));
            }
        }
    }
    if issues.is_empty() {
        Ok(patch.clone())
    } else {
        Err(report(&issues))
    }
}
