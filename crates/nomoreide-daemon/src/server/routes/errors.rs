//! The error inbox: deduped incidents detected across managed service logs,
//! and the debugging prompt for one of them.

use crate::server::app::AppState;
use crate::server::errors::error;
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use nomoreide_daemon_client::protocol::{Incident, IncidentPromptEnvelope, IncidentsEnvelope};
use serde::Deserialize;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/errors", get(list))
        .route("/api/errors/:id/prompt", get(prompt))
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

async fn prompt(State(state): State<AppState>, Path(id): Path<u64>) -> Response {
    match state.errors.build_prompt(id).await {
        Some(payload) => Json(IncidentPromptEnvelope {
            ok: true,
            incident: wire(payload.incident),
            file: payload.file,
            prompt: payload.prompt,
        })
        .into_response(),
        None => error(axum::http::StatusCode::NOT_FOUND, "Incident not found"),
    }
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
