//! Registering a service, and testing a command before you do.
//!
//! Both routes exist for the same moment in the dashboard: someone is filling
//! in the "add a service" form and wants to know whether what they typed
//! actually runs. `POST /api/services/test` answers that without writing
//! anything; `POST /api/services` writes it.
//!
//! **The form is not the stored shape.** `env` and `args` arrive as JSON *text*
//! in form fields and are parsed here, with the reference's own wording, before
//! the definition is assembled. Those refusals come first and are separate from
//! the schema's: `env must be a JSON object.` is this route's, while a missing
//! `cwd` is the validator's union report.
//!
//! **Which fields are kept depends on the kind.** A compose service stores no
//! `command`; a local one stores no `host`. A field belonging to another arm is
//! dropped rather than carried, so config never holds a value nothing reads.

use crate::server::app::AppState;
use crate::server::body::parse_form;
use crate::server::errors::error;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use nomoreide_core::service_definition::service_definition;
use nomoreide_core::service_test::{test_service_command, ServiceTestRequest};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/services", post(register_service))
        // Two segments, so `/api/services/test` is shadowed by the reference's
        // `/api/services/:name` route the same way `/api/services/graph` is: a
        // wrong method reaches that route's own 405, and a DELETE is an attempt
        // to remove a service called `test`.
        .route(
            "/api/services/test",
            post(test_command).fallback(super::service_config::shadowed_service_path),
        )
}

/// The env key rule for a *service definition*, which is stricter than the one
/// a `.env` file uses: no dots. Two rules on purpose — this one describes what
/// a shell will accept on the left of an assignment.
fn is_service_env_key(key: &str) -> bool {
    let mut characters = key.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && characters.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `env` out of the form: absent means "unchanged", present means it must be a
/// JSON object of string values with shell-safe names.
fn parse_service_env(form: &HashMap<String, String>) -> Result<Option<Value>, String> {
    let Some(raw) = form.get("env") else {
        return Ok(None);
    };
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Err("env must be a JSON object.".to_string());
    };
    let Some(map) = value.as_object() else {
        return Err("env must be a JSON object.".to_string());
    };
    for (key, entry) in map {
        if !is_service_env_key(key) {
            return Err(format!("Invalid environment variable name: {key}"));
        }
        if !entry.is_string() {
            return Err(format!("Environment variable \"{key}\" must be a string."));
        }
    }
    Ok(Some(value))
}

/// `args` out of the form: a JSON array of strings, none carrying a null byte.
fn parse_service_args(form: &HashMap<String, String>) -> Result<Option<Value>, String> {
    let Some(raw) = form.get("args") else {
        return Ok(None);
    };
    let message = "args must be a JSON array of strings.";
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Err(message.to_string());
    };
    let Some(list) = value.as_array() else {
        return Err(message.to_string());
    };
    if !list.iter().all(Value::is_string) {
        return Err(message.to_string());
    }
    if list
        .iter()
        .any(|entry| entry.as_str().is_some_and(|text| text.contains('\0')))
    {
        return Err("args contain an invalid null byte.".to_string());
    }
    Ok(Some(value))
}

async fn register_service(State(state): State<AppState>, body: Bytes) -> Response {
    let form = parse_form(&body);
    let env = match parse_service_env(&form) {
        Ok(env) => env,
        // A ConfigValidationError in the reference, which its dispatcher
        // answers with a 400.
        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason),
    };
    let args = match parse_service_args(&form) {
        Ok(args) => args,
        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason),
    };

    // Read **before** the union is tried, and unwrapped in the reference, so a
    // form with nothing in it reports the missing name as a 500 rather than
    // producing a three-armed report about every other field.
    let Some(name) = form
        .get("name")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "name is required");
    };
    let mut arguments = Map::new();
    arguments.insert("name".to_string(), Value::from(name));
    // An unrecognised `kind` is **dropped, not refused**: the reference's
    // ternary falls through to the local shape, and that shape has no `kind`
    // property at all. So `kind=podman` registers a plain local service.
    if let Some(kind) = form
        .get("kind")
        .map(|value| value.trim())
        .filter(|value| *value == "docker-compose" || *value == "ssh")
    {
        arguments.insert("kind".to_string(), Value::from(kind));
    }
    for (field, key) in [
        ("command", "command"),
        ("cwd", "cwd"),
        ("description", "description"),
        ("composeFile", "composeFile"),
        ("composeService", "composeService"),
        ("host", "host"),
        ("projectPath", "projectPath"),
    ] {
        if let Some(value) = form
            .get(field)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            arguments.insert(key.to_string(), Value::from(value));
        }
    }
    // `Number("")` is 0 and `Number("x")` is NaN; a blank field means "no port"
    // and anything unreadable has to reach the validator as the wrong type
    // rather than be dropped.
    if let Some(raw) = form
        .get("port")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        match raw.parse::<u64>() {
            Ok(port) => {
                arguments.insert("port".to_string(), Value::from(port));
            }
            // `Number("abc")` is NaN, which JSON cannot carry. The sentinel
            // reaches the validator as a non-number, which is exactly what the
            // schema has to see.
            Err(_) => {
                arguments.insert("port".to_string(), Value::from("NaN"));
            }
        }
    }
    if let Some(env) = env {
        arguments.insert("env".to_string(), env);
    }
    if let Some(args) = args {
        arguments.insert("args".to_string(), args);
    }
    // A self-reference is dropped rather than refused: a form that lists every
    // service is a plausible way to reach one.
    let depends_on: Vec<Value> = form
        .get("dependsOn")
        .map(String::as_str)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != name)
        .map(Value::from)
        .collect();
    if !depends_on.is_empty() {
        arguments.insert("dependsOn".to_string(), Value::Array(depends_on));
    }

    // **The route reads its own required fields before the schema sees
    // anything**, and which ones depends on the kind it thinks it is building.
    // They are `requiredFormValue` calls in the reference, unwrapped, so each
    // is a 500 naming one field — quite unlike the union report, which only
    // appears for a mistake the form-building did not catch. The order is the
    // order the object literal's properties are evaluated in.
    let required: &[&str] = match arguments.get("kind").and_then(Value::as_str) {
        Some("docker-compose") => &["cwd", "composeService"],
        Some("ssh") => &["host", "cwd", "command"],
        _ => &["command", "cwd"],
    };
    for field in required {
        if !arguments.contains_key(*field) {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("{field} is required"),
            );
        }
    }

    let mut definition = match service_definition(&arguments) {
        Ok(definition) => definition,
        // Also unwrapped: a schema refusal is a 500 carrying zod's report.
        Err(report) => return error(StatusCode::INTERNAL_SERVER_ERROR, &report),
    };
    // Set after validation rather than inside it. The validator's arms carry
    // only the fields that decide *which kind* a service is, and these two
    // belong to every kind — folding them in there would also add them to the
    // MCP tool, which does not accept them.
    definition.depends_on = arguments.get("dependsOn").map(|value| {
        value
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(|entry| entry.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    });
    definition.project_path = arguments
        .get("projectPath")
        .and_then(Value::as_str)
        .map(str::to_string);
    match state.config_store.register_service(definition).await {
        Ok(config) => {
            let view = serde_json::to_value(config.public_view()).unwrap_or_else(|_| json!({}));
            Json(json!({ "ok": true, "config": view })).into_response()
        }
        Err(reason) => crate::server::errors::config_failure(&reason),
    }
}

/// Run a command for a couple of seconds and report what happened.
///
/// Unwrapped in the reference, so a missing `command` or `cwd` escapes as a
/// 500 rather than being reported as a bad request.
async fn test_command(State(state): State<AppState>, body: Bytes) -> Response {
    let _ = &state;
    let form = parse_form(&body);
    let args = match parse_service_args(&form) {
        Ok(args) => args,
        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason),
    };
    let env = match parse_service_env(&form) {
        Ok(env) => env,
        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason),
    };
    let Some(command) = form
        .get("command")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "command is required");
    };
    let Some(cwd) = form
        .get("cwd")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "cwd is required");
    };
    let port = form
        .get("port")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .and_then(|raw| raw.parse::<u16>().ok());

    let result = test_service_command(ServiceTestRequest {
        command: command.to_string(),
        args: args.map(|value| {
            value
                .as_array()
                .map(|list| {
                    list.iter()
                        .filter_map(|entry| entry.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default()
        }),
        env: env.and_then(|value| {
            value.as_object().map(|map| {
                map.iter()
                    .filter_map(|(key, entry)| {
                        entry.as_str().map(|text| (key.clone(), text.to_string()))
                    })
                    .collect()
            })
        }),
        cwd: cwd.to_string(),
        port,
    })
    .await;
    Json(result).into_response()
}
