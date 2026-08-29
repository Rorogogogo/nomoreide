//! Reading and changing the state of individual services.

use crate::server::app::AppState;
use crate::server::errors::{error, service_mutation_error};
use crate::service_discovery::build_service_discovery;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use nomoreide_daemon_client::protocol::{
    LogsEnvelope, ServiceDiscoveryEnvelope, ServiceMutationEnvelope, ServiceStatusSnapshot,
    StatusEnvelope,
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
        .route(
            "/api/services/:name/inspector",
            post(set_inspector).fallback(set_inspector),
        )
}

/// Turn a service's HTTP inspector on or off.
///
/// **The body is a form, not JSON**, and only `"true"` and `"1"` mean on.
/// Anything else — `"yes"`, `"True"`, a JSON body, an absent field — turns it
/// *off*, because the reference compares two exact strings rather than testing
/// truthiness. A JSON body is not an error here; it simply parses as a form
/// with no `enabled` key in it, which is off.
async fn set_inspector(
    State(state): State<AppState>,
    Path(name): Path<String>,
    method: axum::http::Method,
    body: axum::body::Bytes,
) -> Response {
    if method != axum::http::Method::POST {
        return error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    }
    let Some(name) = crate::server::body::decode_uri_component(&name) else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "URI malformed");
    };
    let form = crate::server::body::parse_form(&body);
    let enabled = matches!(
        form.get("enabled").map(String::as_str),
        Some("true") | Some("1")
    );
    match state.runtime.set_inspector_enabled(&name, enabled).await {
        Ok(status) => Json(serde_json::json!({ "ok": true, "status": status })).into_response(),
        Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
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
    // No cache-control: the reference sends none here, and the gates compare
    // the header.
    (Json(StatusEnvelope {
        ok: true,
        status: ServiceStatusSnapshot {
            services: state
                .runtime
                .status()
                .into_iter()
                .map(|status| (status.name.clone(), status))
                .collect(),
        },
    }),)
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
        Err(error) => service_mutation_error(error),
    }
}
