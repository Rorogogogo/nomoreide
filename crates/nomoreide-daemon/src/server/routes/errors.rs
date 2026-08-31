//! The error inbox: deduped incidents detected across managed service logs, the
//! debugging prompt for one of them, the repro bundle, and the fix loop.
//!
//! **Every `:id` route here is a `\d+` pattern in the reference**, and a
//! pattern that does not match is not a route at all — `/api/errors/abc/bundle`
//! reaches the SPA shell's 404, not a 400 about a bad parameter. So the id is
//! taken as a string and checked here, and the method is checked *after* it, in
//! that order: a non-numeric id with a wrong method is still a 404, because the
//! reference never got as far as looking at the method.

use crate::server::app::AppState;
use crate::server::errors::error;
use crate::server::routes::query::query_value;
use crate::server::routes::shell;
use crate::server::sse;
use axum::extract::{Path, Query, State};
use axum::http::{Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use nomoreide_core::agent_sessions::default_store_path;
use nomoreide_core::error_inbox::{service_cwd, IncidentContext};
use nomoreide_core::process_manager::ServiceStatus;
use nomoreide_core::{fix_loop, repro_bundle};
use nomoreide_daemon_client::protocol::{Incident, IncidentPromptEnvelope, IncidentsEnvelope};
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/errors", get(list))
        .route("/api/errors/stream", get(stream))
        .route("/api/errors/:id/prompt", any(prompt))
        .route("/api/errors/:id/bundle", any(bundle))
        .route("/api/errors/:id/fix", any(fix))
}

/// Read the way the reference reads it: anything missing, unparsable, or not
/// positive falls back to the default, and nobody can ask for more than the
/// inbox keeps.
#[derive(Deserialize)]
struct ListQuery {
    #[serde(default)]
    limit: Option<String>,
}

const DEFAULT_INCIDENT_LIMIT: usize = 100;
const MAX_INCIDENT_LIMIT: usize = 200;

async fn list(State(state): State<AppState>, Query(query): Query<ListQuery>) -> Response {
    let limit = query
        .limit
        .and_then(|limit| limit.parse::<usize>().ok())
        .filter(|limit| *limit > 0)
        .map_or(DEFAULT_INCIDENT_LIMIT, |limit| {
            limit.min(MAX_INCIDENT_LIMIT)
        });
    Json(IncidentsEnvelope {
        ok: true,
        incidents: state.errors.list(limit).into_iter().map(wire).collect(),
    })
    .into_response()
}

/// The live incident feed: the fifty most recent, then whatever arrives.
///
/// The replay is what stops a reloaded dashboard from starting blank, and it
/// goes out newest-first because that is the order [`ErrorInbox::list`] holds.
async fn stream(State(state): State<AppState>) -> Response {
    let replay: Vec<Incident> = state
        .errors
        .list(STREAM_REPLAY)
        .into_iter()
        .map(wire)
        .collect();
    sse::stream(
        sse::RETRY_AND_PING,
        replay
            .into_iter()
            .map(|i| sse::named("incident", i))
            .collect(),
        state.errors.events(),
        |incident| Some(sse::named("incident", wire(incident))),
    )
}

/// How many incidents a newly-opened stream replays.
const STREAM_REPLAY: usize = 50;

/// Does the reference's `(\d+)` claim this segment, and what number is it?
///
/// The outer `Option` is whether the pattern matched at all; the inner one is
/// whether the digits fit a `u64`. They differ: a run of digits too long to be
/// one is still a *match* — the reference reads it as a float and finds no
/// incident by it, which is the 404 an unknown id gets anyway — while `abc` is
/// not a route at all.
fn incident_id(raw: &str) -> Option<Option<u64>> {
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(raw.parse::<u64>().ok())
}

/// The reference's own order: does the pattern match, then is the method right.
///
/// `Err` is the response to send — the shell's 404 for an id the pattern never
/// claimed, a JSON 405 for a method the handler refuses.
async fn accept(
    raw: &str,
    method: &Method,
    allowed: Method,
    uri: &Uri,
) -> Result<Option<u64>, Response> {
    let Some(id) = incident_id(raw) else {
        return Err(shell::serve(method.clone(), uri.clone()).await);
    };
    if method != allowed {
        return Err(error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed"));
    }
    Ok(id)
}

async fn prompt(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    Path(raw): Path<String>,
) -> Response {
    let id = match accept(&raw, &method, Method::GET, &uri).await {
        Ok(id) => id,
        Err(response) => return response,
    };
    let payload = match id {
        Some(id) => state.errors.build_prompt(id).await,
        None => None,
    };
    match payload {
        Some(payload) => Json(IncidentPromptEnvelope {
            ok: true,
            incident: wire(payload.incident),
            file: payload.file,
            prompt: payload.prompt,
        })
        .into_response(),
        None => not_found(),
    }
}

async fn bundle(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    Path(raw): Path<String>,
) -> Response {
    let id = match accept(&raw, &method, Method::GET, &uri).await {
        Ok(id) => id,
        Err(response) => return response,
    };
    let Some(context) = incident_context(&state, id).await else {
        return not_found();
    };
    // Only exactly `1` saves. `save=true` and `save=0` alike leave the bundle
    // in the response and nothing on disk.
    let save = query_value(&uri, "save").as_deref() == Some("1");
    let status = status_of(&state, &context.service);
    match repro_bundle::build(&context, status.as_ref(), &repro_dir(), save).await {
        // `savedPath` is absent rather than null when nothing was saved: the
        // reference spreads an object whose field is `undefined`, and a client
        // testing for the key would read a null as a path.
        Ok(bundle) => envelope(&bundle),
        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    }
}

async fn fix(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    Path(raw): Path<String>,
) -> Response {
    let id = match accept(&raw, &method, Method::POST, &uri).await {
        Ok(id) => id,
        Err(response) => return response,
    };
    let Some(context) = incident_context(&state, id).await else {
        return not_found();
    };
    // The fix loop's own bundle is never saved: the document goes into the
    // prompt, and a file nobody asked for would accumulate one per fix.
    let status = status_of(&state, &context.service);
    let bundle = match repro_bundle::build(&context, status.as_ref(), &repro_dir(), false).await {
        Ok(bundle) => bundle,
        Err(reason) => return error(StatusCode::BAD_REQUEST, &reason.to_string()),
    };
    let repo_path = state.workspace_cwd().await;
    let prepared = fix_loop::prepare(&bundle, &repo_path, &default_store_path()).await;
    ok_with(serde_json::to_value(&prepared))
}

/// `{ ok: true, ...payload }`, the reference's one envelope shape.
///
/// Serializing the value and merging beats naming the fields again here: the
/// struct already says which of them are omitted when absent, and a second
/// list of them would be a second place to keep right.
fn ok_with(payload: Result<serde_json::Value, serde_json::Error>) -> Response {
    let mut envelope = serde_json::Map::new();
    envelope.insert("ok".to_string(), json!(true));
    if let Ok(serde_json::Value::Object(object)) = payload {
        envelope.extend(object);
    }
    Json(serde_json::Value::Object(envelope)).into_response()
}

fn envelope(bundle: &nomoreide_core::repro_bundle::ReproBundle) -> Response {
    ok_with(serde_json::to_value(bundle))
}

/// Everything the bundle needs about an incident, or nothing when the inbox
/// does not hold one by that id.
async fn incident_context(state: &AppState, id: Option<u64>) -> Option<IncidentContext> {
    let id = id?;
    let incident = state
        .errors
        .list(usize::MAX)
        .into_iter()
        .find(|incident| incident.id == id)?;
    let cwd = daemon_cwd();
    let config = state.config_store.load().await.ok()?;
    state
        .errors
        .context(id, &service_cwd(&config, &incident.service, &cwd))
        .await
}

/// What the process manager knows about the service, if it has ever launched
/// it.
fn status_of(state: &AppState, service: &str) -> Option<ServiceStatus> {
    state.runtime.service_status(service)
}

fn daemon_cwd() -> String {
    std::env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Where a saved bundle goes: beside the project's logs, not in the user's
/// home — a repro belongs to the workspace it was taken in.
fn repro_dir() -> PathBuf {
    PathBuf::from(daemon_cwd())
        .join(".nomoreide")
        .join("repros")
}

fn not_found() -> Response {
    error(StatusCode::NOT_FOUND, "Incident not found")
}

/// Core's incident as the wire's. The timestamps become the same ISO-8601 UTC
/// spelling the rest of the daemon's payloads use.
fn wire(incident: nomoreide_core::error_inbox::Incident) -> Incident {
    Incident {
        id: incident.id,
        service: incident.service,
        level: incident.level,
        signature: incident.signature,
        title: incident.title,
        file: incident.file,
        line: incident.line,
        first_seen: iso(incident.first_seen),
        last_seen: iso(incident.last_seen),
        count: incident.count,
        log_excerpt: incident.log_excerpt,
    }
}

fn iso(at: chrono::DateTime<chrono::Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
