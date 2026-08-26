//! User-owned git/GitHub workflows.
//!
//! `GET` returns the shipped templates with the user's saved workflows folded
//! in; `POST` and `DELETE` persist edits. There is no run endpoint on purpose —
//! the runner is client-side, and executes each agent step as a fresh headless
//! task.
//!
//! **Every failure here is a 400**, including one that is not the caller's
//! fault: all three routes wrap everything in one catch, so a config that
//! cannot be read reports the same way a malformed workflow does. That is the
//! reference's shape, and mirroring it is what keeps the dashboard's error
//! handling identical across the two runtimes.

use crate::server::app::AppState;
use crate::server::errors::{error, method_not_allowed};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::{Json, Router};
use nomoreide_core::workflows::{list_workflows, validate_workflow};
use serde_json::{json, Value};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/workflows", get(list).post(save))
        .route(
            "/api/workflows/:id",
            delete(remove).fallback(method_not_allowed),
        )
}

fn refuse(message: &str) -> Response {
    error(StatusCode::BAD_REQUEST, message)
}

async fn workflows_of(state: &AppState) -> Result<Vec<Value>, Response> {
    state
        .config_store
        .load()
        .await
        .map(|config| config.workflows.clone())
        .map_err(|reason| refuse(&reason.to_string()))
}

fn envelope(workflows: &[Value]) -> Response {
    Json(json!({ "ok": true, "workflows": list_workflows(workflows) })).into_response()
}

async fn list(State(state): State<AppState>) -> Response {
    match workflows_of(&state).await {
        Ok(workflows) => envelope(&workflows),
        Err(response) => response,
    }
}

/// Save a workflow, replacing one with the same id.
///
/// `builtin` is **forced false** before validation, so forking a template
/// cannot produce a saved workflow that claims to be one of the shipped ones.
async fn save(State(state): State<AppState>, body: Bytes) -> Response {
    // A body that did not parse is an empty object, not a refusal: the
    // reference's reader hands the schema `{}` and lets it report every
    // required field, so a corrupt body and an empty one say the same thing.
    let mut workflow = serde_json::from_slice::<Value>(&body).unwrap_or_else(|_| json!({}));
    if let Some(object) = workflow.as_object_mut() {
        object.insert("builtin".to_string(), Value::Bool(false));
    }
    if let Err(reason) = validate_workflow(&workflow) {
        return refuse(&reason);
    }
    match state.config_store.save_workflow(workflow).await {
        Ok(config) => envelope(&config.workflows),
        Err(reason) => refuse(&reason.to_string()),
    }
}

async fn remove(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.config_store.remove_workflow(id.trim()).await {
        Ok(config) => envelope(&config.workflows),
        Err(reason) => refuse(&reason.to_string()),
    }
}
