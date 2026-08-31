//! Saved log sources: list, register, remove, and read.
//!
//! **Three error vocabularies over one form.** `name` and `kind` are read with
//! the reference's unwrapped form helpers, so a missing name or a kind nobody
//! knows escapes as a **500** carrying prose. The schema behind them is inside
//! a catch, so its refusals are a **400** carrying zod's report. And a failed
//! *read* — a file that is not there, a command that exited non-zero — is a
//! **200** with `{ ok: false, error }`, because the log pane renders the reason
//! where the lines would go rather than treating it as a failed request.
//!
//! The two `:name` routes are pattern routes in the reference, so a wrong
//! method there is a 405 JSON refusal; `/api/log-sources` is exact, so a wrong
//! method on it falls through to the SPA shell's 404.

use crate::server::app::AppState;
use crate::server::body::{parse_form, parse_query};
use crate::server::errors::{error, method_not_allowed};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::{Json, Router};
use nomoreide_core::config::LogSourceDef;
use nomoreide_core::log_sources::{parse_log_query, read_log_source};
use nomoreide_core::zod_report::{report, ZodIssue};
use serde_json::json;
use std::collections::HashMap;

const KINDS: [&str; 3] = ["file", "ssh", "command"];
const DRIVERS: [&str; 2] = ["journald", "docker"];

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/log-sources", get(list).post(register))
        .route(
            "/api/log-sources/:name",
            delete(remove).fallback(method_not_allowed),
        )
        .route(
            "/api/log-sources/:name/logs",
            get(logs).fallback(method_not_allowed),
        )
}

/// The envelope every mutation answers with: the whole list, not the one row.
async fn sources_envelope(state: &AppState) -> Response {
    match state.config_store.load().await {
        Ok(config) => Json(json!({ "ok": true, "sources": config.log_sources })).into_response(),
        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    }
}

async fn list(State(state): State<AppState>) -> Response {
    sources_envelope(&state).await
}

/// A form field that has to be there. It returns the *message* rather than a
/// whole response: an `Err` carrying an `axum::Response` is large enough that
/// clippy refuses it, and every caller answers this one the same way.
fn required(form: &HashMap<String, String>, key: &str) -> Result<String, String> {
    form.get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{key} is required"))
}

/// A form field that may be absent, and where blank means absent. The schema
/// requires a non-empty string, so a blank field has to be dropped here or it
/// would be reported as "too small" rather than as missing.
fn optional(form: &HashMap<String, String>, key: &str) -> Option<String> {
    form.get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

async fn register(State(state): State<AppState>, body: Bytes) -> Response {
    let form = parse_form(&body);
    let name = match required(&form, "name") {
        Ok(name) => name,
        Err(reason) => return error(StatusCode::INTERNAL_SERVER_ERROR, &reason),
    };
    let kind = match required(&form, "kind") {
        Ok(kind) => kind,
        Err(reason) => return error(StatusCode::INTERNAL_SERVER_ERROR, &reason),
    };
    if !KINDS.contains(&kind.as_str()) {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!(
                "Unsupported log source kind \"{kind}\". Use one of: {}.",
                KINDS.join(", ")
            ),
        );
    }
    let driver = optional(&form, "driver");
    if let Some(driver) = &driver {
        if !DRIVERS.contains(&driver.as_str()) {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!(
                    "Unsupported log driver \"{driver}\". Use one of: {}.",
                    DRIVERS.join(", ")
                ),
            );
        }
    }

    let definition = LogSourceDef {
        name,
        kind,
        path: optional(&form, "path"),
        host: optional(&form, "host"),
        command: optional(&form, "command"),
        cwd: optional(&form, "cwd"),
        driver,
        unit: optional(&form, "unit"),
        container: optional(&form, "container"),
    };
    if let Err(reason) = validate_log_source(&definition) {
        return error(StatusCode::BAD_REQUEST, &reason);
    }
    match state.config_store.register_log_source(definition).await {
        Ok(config) => Json(json!({ "ok": true, "sources": config.log_sources })).into_response(),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

/// The schema's refinement, which is all of it that a form can still fail.
///
/// Every other rule — the enums, the non-empty strings — is already satisfied
/// by the way the definition was built, so what is left is the cross-field
/// check. **A driver returns early**: a source that names one builds its own
/// query and never uses `path`, `host` or `command`, so the kind's own
/// requirements do not apply to it at all.
fn validate_log_source(source: &LogSourceDef) -> Result<(), String> {
    let missing = |value: &Option<String>| value.as_deref().unwrap_or_default().is_empty();
    let mut issues = Vec::new();
    match source.driver.as_deref() {
        Some("journald") => {
            if missing(&source.unit) {
                issues.push(ZodIssue::custom("journald log source requires a unit."));
            }
        }
        Some("docker") => {
            if missing(&source.container) {
                issues.push(ZodIssue::custom("docker log source requires a container."));
            }
        }
        _ => match source.kind.as_str() {
            "file" if missing(&source.path) => {
                issues.push(ZodIssue::custom("File log source requires a path."));
            }
            "ssh" if missing(&source.host) || missing(&source.path) => {
                issues.push(ZodIssue::custom("SSH log source requires host and path."));
            }
            "command" if missing(&source.command) => {
                issues.push(ZodIssue::custom("Command log source requires a command."));
            }
            _ => {}
        },
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(report(&issues))
    }
}

/// Removal is unwrapped and does **not** trim: the name is taken as sent, and a
/// name nobody registered is a success with the list unchanged.
async fn remove(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    match state.config_store.remove_log_source(&name).await {
        Ok(config) => Json(json!({ "ok": true, "sources": config.log_sources })).into_response(),
        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    }
}

async fn logs(State(state): State<AppState>, Path(name): Path<String>, uri: Uri) -> Response {
    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(reason) => return error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    };
    let Some(source) = config.log_sources.iter().find(|item| item.name == name) else {
        return error(
            StatusCode::NOT_FOUND,
            &format!("Unknown log source \"{name}\"."),
        );
    };
    match read_log_source(source, &parse_log_query(&parse_query(&uri))).await {
        Ok(logs) => Json(json!({ "ok": true, "logs": logs })).into_response(),
        // A read that failed is still a 200: the pane shows the reason.
        Err(reason) => Json(json!({ "ok": false, "error": reason })).into_response(),
    }
}
