//! Agent introspection: the co-author setting, MCP auth state, and the
//! tool-call feed.
//!
//! Every route here is exact, so a wrong method falls through to the SPA
//! shell's 404 rather than answering 405 — there are no pattern routes on this
//! prefix to catch one.

use crate::server::app::AppState;
use crate::server::body::read_json_object;
use crate::server::errors::error;
use crate::server::routes::query::query_value;
use crate::server::sse;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use nomoreide_core::claude_settings::{get_co_author, set_co_author};
use nomoreide_core::js_number;
use nomoreide_core::mcp_auth::{mcp_auth_statuses, AgentName};
use nomoreide_core::tool_call_store::clamp_limit;
use serde_json::{json, Value};
use std::path::PathBuf;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/agent/claude-settings",
            get(read_settings).post(write_settings),
        )
        .route("/api/agent/mcp-status", get(mcp_status))
        .route("/api/agent/tool-calls", get(tool_calls))
        .route("/api/agent/tool-calls/stream", get(tool_calls_stream))
}

fn home() -> PathBuf {
    nomoreide_core::home::home_directory()
}

fn settings_envelope(co_author: bool) -> Response {
    Json(json!({ "ok": true, "settings": { "coAuthorWithClaude": co_author } })).into_response()
}

async fn read_settings() -> Response {
    match get_co_author(&home()).await {
        Ok(co_author) => settings_envelope(co_author),
        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason),
    }
}

/// A boolean, strictly.
///
/// Not "truthy": a string `"true"`, a `1`, a `null` and an absent field are all
/// the same refusal, because this writes to a file the user owns and a
/// mistyped body should not decide what goes in it.
async fn write_settings(body: Bytes) -> Response {
    let payload = read_json_object(&body);
    let Some(enabled) = payload.get("coAuthorWithClaude").and_then(Value::as_bool) else {
        return error(
            StatusCode::BAD_REQUEST,
            "coAuthorWithClaude must be boolean",
        );
    };
    match set_co_author(&home(), enabled).await {
        Ok(co_author) => settings_envelope(co_author),
        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason),
    }
}

async fn mcp_status(uri: Uri) -> Response {
    let agent = AgentName::parse(query_value(&uri, "agent").as_deref());
    Json(json!({ "ok": true, "statuses": mcp_auth_statuses(agent).await })).into_response()
}

/// The live feed, newest window first.
///
/// **Always empty in a daemon.** The store is only written by an in-process MCP
/// server and the daemon's clients are separate processes, so this reports the
/// shape and nothing else. The clamp is still applied rather than skipped: the
/// writer is the missing half, and when it lands this should already be right.
async fn tool_calls(State(state): State<AppState>, uri: Uri) -> Response {
    let limit = clamp_limit(js_number::parse(
        &query_value(&uri, "limit").unwrap_or_default(),
    ));
    Json(json!({ "ok": true, "records": state.tool_calls.recent(limit) })).into_response()
}

/// The live tool-call feed.
///
/// **Empty in a daemon, and streaming anyway.** Nothing writes to the store
/// here — see [`tool_calls`] — so this replays nothing and then heartbeats.
/// The framing is still the contract, and the writer is the missing half.
async fn tool_calls_stream(State(state): State<AppState>) -> Response {
    sse::stream(
        "tool-call",
        state.tool_calls.recent(STREAM_REPLAY),
        state.tool_calls.subscribe(),
        |record| record,
    )
}

/// How many calls a newly-opened stream replays.
const STREAM_REPLAY: usize = 50;
