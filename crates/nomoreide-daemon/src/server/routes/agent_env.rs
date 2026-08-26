//! Agent Environments: what is installed, what each agent is configured with,
//! and the guarded edits to one agent's settings file.
//!
//! Three of these are read-on-mount and answer straight from
//! [`nomoreide_core::agent_env`]. The settings pair is the write side, and the
//! two of them check their inputs in **opposite orders**, which is the reference's
//! shape and not an oversight:
//!
//! - `/settings/:agent` validates the agent before the method, so a `DELETE`
//!   naming an agent nobody ships is a 400 about the agent, never a 405.
//! - `/settings/:agent/model` validates the method first, so the same unknown
//!   agent behind a `GET` is a 405.
//!
//! Neither decodes its path segment. The reference matches the raw capture
//! against a fixed list of three names, so `%63laude` is a stranger.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use nomoreide_core::agent_env::{self, Agent};
use nomoreide_core::agent_settings::{
    read_agent_settings, set_agent_model, write_agent_settings, WrittenSettings,
};

use crate::server::app::AppState;
use crate::server::body::read_json_object;
use crate::server::errors::error;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/agent-env/agents", get(agents))
        .route("/api/agent-env/live", get(live))
        .route("/api/agent-env/doctor", get(doctor))
        .route("/api/agent-env/snapshot", post(snapshot))
        .route(
            "/api/agent-env/settings/:agent",
            get(settings_file)
                .put(settings_file)
                .fallback(settings_file),
        )
        .route(
            "/api/agent-env/settings/:agent/model",
            post(settings_model).fallback(settings_model),
        )
}

/// The path segment naming the agent, exactly as it arrived.
///
/// Not the `Path` extractor: that percent-decodes, and the reference does not.
/// It matches the raw capture against three literal names, so `%63laude` is a
/// stranger rather than a spelling of `claude`.
fn agent_segment(uri: &Uri, trailing: bool) -> &str {
    let path = uri.path();
    let rest = path
        .strip_prefix("/api/agent-env/settings/")
        .unwrap_or_default();
    if trailing {
        rest.strip_suffix("/model").unwrap_or(rest)
    } else {
        rest
    }
}

/// The three agents, by the only names the reference answers to.
fn agent_named(id: &str) -> Option<Agent> {
    match id {
        "claude" => Some(Agent::Claude),
        "codex" => Some(Agent::Codex),
        "antigravity" => Some(Agent::Antigravity),
        _ => None,
    }
}

async fn agents() -> Response {
    Json(json!({ "ok": true, "agents": agent_env::status() })).into_response()
}

async fn live() -> Response {
    Json(json!({ "ok": true, "configs": agent_env::read_configs(None) })).into_response()
}

async fn doctor() -> Response {
    let report = agent_env::doctor(None);
    Json(json!({
        "ok": true,
        "checks": report.checks,
        "hasIssues": report.has_issues,
    }))
    .into_response()
}

async fn snapshot(State(_state): State<AppState>, body: Bytes) -> Response {
    let payload = read_json_object(&body);
    let Some(agent) = payload
        .get("agent")
        .and_then(Value::as_str)
        .and_then(agent_named)
    else {
        return error(
            StatusCode::BAD_REQUEST,
            "agent must be claude, codex, or antigravity.",
        );
    };
    match agent_env::snapshot_agent(agent) {
        Ok(outcome) => Json(json!({
            "ok": true,
            "agent": agent.id(),
            "backups": outcome.backups,
        }))
        .into_response(),
        Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

/// `GET` reads the file, `PUT` replaces it, and anything else is a 405 — but
/// only once the agent has been recognised.
async fn settings_file(method: Method, uri: Uri, body: Bytes) -> Response {
    let Some(agent) = agent_named(agent_segment(&uri, false)) else {
        return error(StatusCode::BAD_REQUEST, "Unknown agent.");
    };
    match method {
        Method::GET => {
            Json(json!({ "ok": true, "settings": read_agent_settings(agent) })).into_response()
        }
        Method::PUT => {
            let payload = read_json_object(&body);
            let Some(content) = payload.get("content").and_then(Value::as_str) else {
                return error(StatusCode::BAD_REQUEST, "Invalid settings body.");
            };
            written(write_agent_settings(agent, content))
        }
        _ => error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed"),
    }
}

async fn settings_model(method: Method, uri: Uri, body: Bytes) -> Response {
    if method != Method::POST {
        return error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    }
    let Some(agent) = agent_named(agent_segment(&uri, true)) else {
        return error(StatusCode::BAD_REQUEST, "Unknown agent.");
    };
    let payload = read_json_object(&body);
    let Some(model) = payload.get("model").and_then(Value::as_str) else {
        return error(StatusCode::BAD_REQUEST, "Invalid model body.");
    };
    match set_agent_model(agent, model) {
        Ok(written) => settings_response(written),
        // Unlike a write, this route has no 400 branch: the reference reports
        // every failure here as a 500, including a file that will not parse.
        Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

/// A write's refusal splits on wording: content the caller could fix is a 400,
/// and anything else is the server's fault.
fn written(result: Result<WrittenSettings, String>) -> Response {
    match result {
        Ok(written) => settings_response(written),
        Err(message) => {
            let status = if message.starts_with("Not valid") {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            error(status, &message)
        }
    }
}

fn settings_response(written: WrittenSettings) -> Response {
    Json(json!({
        "ok": true,
        "settings": written.settings,
        "backup": written.backup,
    }))
    .into_response()
}
