//! Reading and changing the state of individual services.

use crate::server::app::AppState;
use crate::server::errors::{error, mutation_error};
use crate::service_discovery::build_service_discovery;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use nomoreide_daemon_client::protocol::{
    LogsEnvelope, ServiceDiscoveryEnvelope, ServiceMutationEnvelope, StatusEnvelope,
};
use serde::Deserialize;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/services", get(list_services))
        .route("/api/status", get(status))
        .route("/api/services/:name/logs", get(logs))
        .route("/api/services/:name/start", post(start_service))
        .route("/api/services/:name/stop", post(stop_service))
        .route("/api/services/:name/restart", post(restart_service))
}

async fn list_services(State(state): State<AppState>) -> Response {
    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to load NoMoreIDE config.",
            )
        }
    };
    let discovery = match build_service_discovery(&config) {
        Ok(discovery) => discovery,
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to build service discovery.",
            )
        }
    };
    (
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(ServiceDiscoveryEnvelope {
            ok: true,
            services: discovery.services,
            bundles: discovery.bundles,
        }),
    )
        .into_response()
}

/// Runtime state is never cacheable: a stale read here is a caller acting on a
/// service that has already stopped.
async fn status(State(state): State<AppState>) -> Response {
    (
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(StatusEnvelope {
            ok: true,
            services: state.runtime.status(),
        }),
    )
        .into_response()
}

/// How many buffered lines to hand back. The reference reads this leniently —
/// anything missing, unparsable, or not positive falls back to the default
/// rather than failing the request, because a malformed `lines` is no reason to
/// withhold the logs someone is debugging with.
#[derive(Deserialize)]
struct LogQuery {
    #[serde(default)]
    lines: Option<String>,
}

const DEFAULT_LOG_LINES: usize = 500;

async fn logs(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Query(query): Query<LogQuery>,
) -> Response {
    let lines = query
        .lines
        .and_then(|lines| lines.parse::<usize>().ok())
        .filter(|lines| *lines > 0)
        .unwrap_or(DEFAULT_LOG_LINES);
    (
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(LogsEnvelope {
            ok: true,
            logs: state.runtime.logs(&name, lines),
        }),
    )
        .into_response()
}

async fn start_service(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    service_action(state, name, ServiceAction::Start).await
}

async fn stop_service(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    service_action(state, name, ServiceAction::Stop).await
}

async fn restart_service(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    service_action(state, name, ServiceAction::Restart).await
}

enum ServiceAction {
    Start,
    Stop,
    Restart,
}

/// The daemon owns the sequencing behind each of these, so a route is only ever
/// the name of an action plus the one envelope they all answer in.
async fn service_action(state: AppState, name: String, action: ServiceAction) -> Response {
    let result = match action {
        ServiceAction::Start => state.runtime.start_service(&name).await,
        ServiceAction::Stop => state.runtime.stop_service(&name).await,
        ServiceAction::Restart => state.runtime.restart_service(&name).await,
    };
    match result {
        Ok(status) => Json(ServiceMutationEnvelope { ok: true, status }).into_response(),
        Err(error) => mutation_error(error),
    }
}
