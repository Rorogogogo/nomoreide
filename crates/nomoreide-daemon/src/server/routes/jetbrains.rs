//! Importing a JetBrains project's run configurations and data sources.
//!
//! Two exact routes, and the pair is one flow: `scan` reads the project and
//! returns a preview plus a session id, `apply` spends that id. Nothing is
//! written until someone has seen the preview.
//!
//! The status codes are the reference's and they are not interchangeable: a
//! **400** means the request was the wrong shape, a **422** that the project
//! could not be read, and a **409** that the import itself was refused — an
//! expired preview, a name already taken, a selection naming nothing.

use crate::server::app::AppState;
use crate::server::body::read_json_object;
use crate::server::errors::error;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use nomoreide_core::jetbrains_import::{self, DatabaseSelection, ImportSelection, ScanRequest};
use serde_json::{json, Value};
use std::collections::HashSet;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/import/jetbrains/scan", post(scan))
        .route("/api/import/jetbrains/apply", post(apply))
}

async fn scan(State(state): State<AppState>, body: Bytes) -> Response {
    let payload = read_json_object(&body);
    let project_root = payload
        .get("projectRoot")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|root| !root.is_empty());
    let Some(project_root) = project_root else {
        return error(StatusCode::BAD_REQUEST, "projectRoot is required");
    };
    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(reason) => return error(StatusCode::UNPROCESSABLE_ENTITY, &reason.to_string()),
    };
    let request = ScanRequest {
        project_root,
        include_personal: payload.get("includePersonal") == Some(&Value::Bool(true)),
        existing_names: config
            .services
            .iter()
            .map(|service| service.name.clone())
            .collect::<HashSet<_>>(),
        existing_database_names: config
            .databases
            .iter()
            .map(|database| database.name.clone())
            .collect::<HashSet<_>>(),
    };
    match jetbrains_import::scan(request).await {
        Ok(preview) => Json(json!({ "ok": true, "preview": preview })).into_response(),
        Err(reason) => error(StatusCode::UNPROCESSABLE_ENTITY, &reason),
    }
}

async fn apply(State(state): State<AppState>, body: Bytes) -> Response {
    let payload = read_json_object(&body);
    let session_id = payload.get("sessionId").and_then(Value::as_str);
    let raw_selections = payload.get("selections").and_then(Value::as_array);
    let (Some(session_id), Some(raw_selections)) = (session_id, raw_selections) else {
        return error(
            StatusCode::BAD_REQUEST,
            "sessionId and selections are required",
        );
    };

    let selections = match parse_selections(raw_selections) {
        Ok(selections) => selections,
        Err(reason) => return error(StatusCode::CONFLICT, &reason),
    };
    let databases = match parse_database_selections(payload.get("databases")) {
        Ok(databases) => databases,
        Err(reason) => return error(StatusCode::CONFLICT, &reason),
    };

    let (services, imported_databases) =
        match jetbrains_import::consume(session_id, &selections, &databases) {
            Ok(pair) => pair,
            Err(reason) => return error(StatusCode::CONFLICT, &reason),
        };

    // One config mutation for both kinds, so a refused database cannot leave
    // half an import behind.
    let mut config = match state.config_store.load().await {
        Ok(config) => config,
        Err(reason) => return error(StatusCode::CONFLICT, &reason.to_string()),
    };
    if let Err(reason) =
        jetbrains_import::apply_to_config(&mut config, &services, &imported_databases)
    {
        return error(StatusCode::CONFLICT, &reason);
    }
    if let Err(reason) = state.config_store.save(&config).await {
        return error(StatusCode::CONFLICT, &reason.to_string());
    }
    // Only now: a preview spent against a write that failed would leave the
    // caller with nothing to retry.
    jetbrains_import::complete(session_id);

    Json(json!({
        "ok": true,
        "imported": services
            .iter()
            .map(|service| service.definition.name.clone())
            .collect::<Vec<_>>(),
        "importedDatabases": imported_databases
            .iter()
            .map(|database| database.definition.name.clone())
            .collect::<Vec<_>>(),
        "config": config.public_value(),
    }))
    .into_response()
}

/// The reference validates by hand and refuses the whole batch on the first bad
/// entry, so a partially-valid list imports nothing.
fn parse_selections(raw: &[Value]) -> Result<Vec<ImportSelection>, String> {
    raw.iter()
        .map(|entry| {
            let object = entry.as_object().ok_or("Invalid import selection.")?;
            let id = object
                .get("id")
                .and_then(Value::as_str)
                .ok_or("Invalid import selection.")?;
            let conflict = object
                .get("conflict")
                .and_then(Value::as_str)
                .filter(|mode| matches!(*mode, "add" | "skip" | "replace" | "rename"))
                .ok_or("Invalid import selection.")?;
            let optional_string = |key: &str| -> Result<Option<String>, String> {
                match object.get(key) {
                    None | Some(Value::Null) => Ok(None),
                    Some(Value::String(value)) => Ok(Some(value.clone())),
                    Some(_) => Err("Invalid import selection.".to_string()),
                }
            };
            let args = match object.get("args") {
                None | Some(Value::Null) => None,
                Some(Value::Array(items)) => Some(
                    items
                        .iter()
                        .map(|item| {
                            item.as_str()
                                .map(str::to_string)
                                .ok_or("Invalid import selection.")
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                ),
                Some(_) => return Err("Invalid import selection.".to_string()),
            };
            Ok(ImportSelection {
                id: id.to_string(),
                conflict: conflict.to_string(),
                name: optional_string("name")?,
                command: optional_string("command")?,
                args,
                cwd: optional_string("cwd")?,
            })
        })
        .collect()
}

fn parse_database_selections(raw: Option<&Value>) -> Result<Vec<DatabaseSelection>, String> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    if raw.is_null() {
        return Ok(Vec::new());
    }
    let entries = raw
        .as_array()
        .ok_or("Invalid database import selections.")?;
    entries
        .iter()
        .map(|entry| {
            let object = entry
                .as_object()
                .ok_or("Invalid database import selection.")?;
            let id = object
                .get("id")
                .and_then(Value::as_str)
                .ok_or("Invalid database import selection.")?;
            let conflict = object
                .get("conflict")
                .and_then(Value::as_str)
                .filter(|mode| matches!(*mode, "add" | "skip" | "replace" | "rename"))
                .ok_or("Invalid database import selection.")?;
            let optional_string = |key: &str| -> Result<Option<String>, String> {
                match object.get(key) {
                    None | Some(Value::Null) => Ok(None),
                    Some(Value::String(value)) => Ok(Some(value.clone())),
                    Some(_) => Err("Invalid database import selection.".to_string()),
                }
            };
            let test = match object.get("test") {
                None | Some(Value::Null) => None,
                Some(Value::Bool(value)) => Some(*value),
                Some(_) => return Err("Invalid database import selection.".to_string()),
            };
            Ok(DatabaseSelection {
                id: id.to_string(),
                conflict: conflict.to_string(),
                name: optional_string("name")?,
                username: optional_string("username")?,
                password: optional_string("password")?,
                test,
            })
        })
        .collect()
}
