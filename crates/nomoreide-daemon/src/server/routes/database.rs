//! Registered database connections: what exists, what a service's `.env`
//! suggests, and the register / test / remove / unlock operations around them.
//!
//! Reading the catalog is a separate module. What these routes have in common
//! is that they handle the connection *string*, which is the only secret the
//! database feature holds. It is masked on the way out of every one of them.
//!
//! The reference reaches these through an exact route per static path and a
//! trailing pattern for `/api/databases/:name`. An exact route only claims its
//! own method, so `DELETE /api/databases/detect` falls past the detect route
//! into the pattern and removes a connection *named* "detect". Axum matches the
//! static segment first and would answer 405, so the static paths carry the
//! same DELETE arm and read their name back out of the URI.

use crate::server::app::AppState;
use crate::server::body::{parse_form, percent_decode};
use crate::server::errors::{config_failure, error, method_not_allowed};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use nomoreide_core::config::DatabaseDef;
use nomoreide_core::db;
use serde_json::json;

const ENGINES: [&str; 3] = ["postgres", "mysql", "sqlite"];

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/databases", get(list).post(register))
        .route(
            "/api/databases/detect",
            get(detect).delete(remove).fallback(method_not_allowed),
        )
        .route(
            "/api/databases/test",
            post(test).delete(remove).fallback(method_not_allowed),
        )
        .route(
            "/api/databases/:name",
            delete(remove).fallback(method_not_allowed),
        )
        .route(
            "/api/databases/:name/write-access",
            post(write_access).fallback(method_not_allowed),
        )
}

async fn list(State(state): State<AppState>) -> Response {
    match state.config_store.load().await {
        Ok(config) => Json(json!({ "ok": true, "connections": db::list_connections(&config) }))
            .into_response(),
        Err(reason) => config_failure(&reason),
    }
}

async fn detect(State(state): State<AppState>) -> Response {
    match state.config_store.load().await {
        Ok(config) => Json(json!({ "ok": true, "detected": db::detect_from_env(&config).await }))
            .into_response(),
        Err(reason) => config_failure(&reason),
    }
}

/// Register a connection, or re-register one under a name already in use.
///
/// Re-registering *replaces* the stored entry, which is why two fields are
/// carried across by hand. The password is spliced back in because the client
/// never had it to send. The unlock flag is carried because losing it would
/// silently re-lock a connection someone had deliberately opened. The project
/// path is **not** carried: the client always knows that one, so its absence is
/// a real instruction to clear it.
async fn register(State(state): State<AppState>, body: Bytes) -> Response {
    let form = parse_form(&body);
    let name = match required(&form, "name") {
        Ok(name) => name,
        Err(reason) => return throw(&reason),
    };
    let engine = match required(&form, "engine").and_then(|value| parse_engine(&value)) {
        Ok(engine) => engine,
        Err(reason) => return throw(&reason),
    };
    let mut url = match required(&form, "url") {
        Ok(url) => url,
        Err(reason) => return throw(&reason),
    };

    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(reason) => return config_failure(&reason),
    };
    let existing = config
        .databases
        .iter()
        .find(|database| database.name == name)
        .cloned();
    if let Some(existing) = &existing {
        url = db::merge_stored_password(engine, &url, &existing.url);
    }

    let definition = DatabaseDef {
        name,
        engine: engine.to_string(),
        url,
        write_unlocked: existing.and_then(|existing| existing.write_unlocked),
        project_path: optional(&form, "projectPath"),
    };
    match state.config_store.register_database(definition).await {
        Ok(config) => Json(json!({
            "ok": true,
            "databases": config
                .databases
                .iter()
                .map(|database| json!({ "name": database.name, "engine": database.engine }))
                .collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(reason) => config_failure(&reason),
    }
}

/// Try a connection string without storing it.
///
/// A refusal is answered `200 { ok: false }`, not an error status: the caller
/// asked whether this works, and "no" is a successful answer to that question.
/// The driver's wording is passed through, minus the credential.
async fn test(body: Bytes) -> Response {
    let form = parse_form(&body);
    let engine = match required(&form, "engine").and_then(|value| parse_engine(&value)) {
        Ok(engine) => engine,
        Err(reason) => return throw(&reason),
    };
    let url = match required(&form, "url") {
        Ok(url) => url,
        Err(reason) => return throw(&reason),
    };
    match db::test_connection(engine, &url).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(reason) => Json(json!({
            "ok": false,
            "error": db::redact_database_error(engine, &url, &reason),
        }))
        .into_response(),
    }
}

/// Removing a connection that is not there succeeds. The caller asked for it to
/// be gone, and it is.
async fn remove(State(state): State<AppState>, uri: Uri) -> Response {
    let Some(name) = name_from(&uri) else {
        return error(StatusCode::NOT_FOUND, "Not found");
    };
    match state.config_store.remove_database(&name).await {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(reason) => config_failure(&reason),
    }
}

/// Open or close write access for one connection. Human-only: nothing on the
/// agent surface reaches this, which is what makes the flag worth trusting.
async fn write_access(State(state): State<AppState>, uri: Uri, body: Bytes) -> Response {
    let Some(name) = name_from(&uri) else {
        return error(StatusCode::NOT_FOUND, "Not found");
    };
    let form = parse_form(&body);
    let unlocked = match required(&form, "unlocked") {
        // Exactly `"true"` unlocks. Anything else -- `"1"`, `"yes"`, `"TRUE"` --
        // locks, rather than being read as a general truthy value.
        Ok(value) => value == "true",
        Err(reason) => return throw(&reason),
    };
    match state
        .config_store
        .set_database_write_access(&name, unlocked)
        .await
    {
        Ok(_) => Json(json!({ "ok": true, "writeUnlocked": unlocked })).into_response(),
        Err(reason) => config_failure(&reason),
    }
}

/// The `:name` segment, decoded once, however the route was reached.
fn name_from(uri: &Uri) -> Option<String> {
    let path = uri.path().strip_prefix("/api/databases/")?;
    let segment = path.split('/').next()?;
    if segment.is_empty() {
        return None;
    }
    Some(percent_decode(segment))
}

fn required(form: &std::collections::HashMap<String, String>, key: &str) -> Result<String, String> {
    form.get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{key} is required"))
}

fn optional(form: &std::collections::HashMap<String, String>, key: &str) -> Option<String> {
    form.get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn parse_engine(value: &str) -> Result<&'static str, String> {
    ENGINES
        .iter()
        .find(|engine| **engine == value)
        .copied()
        .ok_or_else(|| {
            format!(
                "Unsupported engine \"{value}\". Use one of: {}.",
                ENGINES.join(", ")
            )
        })
}

/// What an uncaught throw becomes in the reference's dispatcher. These checks
/// sit outside any try/catch there, so a missing field is a 500 rather than the
/// 400 it reads like.
fn throw(message: &str) -> Response {
    error(StatusCode::INTERNAL_SERVER_ERROR, message)
}
