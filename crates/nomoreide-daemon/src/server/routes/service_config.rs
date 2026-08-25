//! The service *registration* surface: reading and editing what a service is,
//! rather than running it.
//!
//! Three behaviours here are the reference's and are not guessable from the
//! shapes of the routes.
//!
//! **`/api/services/graph` is shadowed.** It is a single path segment, so a
//! request that is not a `GET` does not fall through to the shell the way a
//! wrong method on an exact route usually does — it falls through to
//! `/api/services/:name`, which checks the method itself. So a `POST` there is
//! a 405, and a `DELETE` is not a refusal at all: it is an attempt to remove a
//! service named `graph`.
//!
//! **`definition` hands back the stored record verbatim**, `env` values and
//! all, where every route that returns a whole config returns the redacted
//! view. It is the editor's read of one service the user is about to change,
//! so a masked value would be saved back as the mask.
//!
//! **Registering a bundle has no try/catch in the reference**, so a missing
//! name escapes to the dispatcher as a **500**, while the same missing field on
//! `project` or on a delete is a handled 404/400. The status is the tell for
//! which routes the reference wrapped.

use crate::server::app::AppState;
use crate::server::body::parse_form;
use crate::server::errors::{error, method_not_allowed};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::header::CACHE_CONTROL;
use axum::http::{HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use nomoreide_core::config::BundleDef;
use nomoreide_core::service_graph::build_service_graph;
use nomoreide_daemon_client::protocol::ServiceRuntimeState;
use serde::Serialize;
use serde_json::json;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        // Shadowed by `/api/services/:name`: see the module docs. axum matches
        // the static segment first, so the fallback has to re-supply the name
        // the pattern route would have captured.
        .route("/api/services/graph", get(graph).fallback(shadowed_graph))
        .route(
            "/api/services/:name/definition",
            get(definition).fallback(method_not_allowed),
        )
        .route(
            "/api/services/:name/project",
            post(set_project).fallback(method_not_allowed),
        )
        .route("/api/bundles", post(register_bundle))
        .route(
            "/api/bundles/:name/restart",
            post(restart_bundle).fallback(method_not_allowed),
        )
        .route(
            "/api/services/:name",
            delete(remove_service).fallback(method_not_allowed),
        )
}

/// What `/api/services/graph` does for a method that is not `GET`.
///
/// The reference reaches its `/api/services/:name` route here, so a `DELETE` is
/// a delete of a service called `graph` and everything else is that route's own
/// 405. axum matched the static segment, so the name has to be re-supplied.
async fn shadowed_graph(state: State<AppState>, method: Method) -> Response {
    if method == Method::DELETE {
        return remove_service(state, Path("graph".to_string())).await;
    }
    method_not_allowed().await
}

#[derive(Serialize)]
struct ConfigEnvelope {
    ok: bool,
    config: serde_json::Value,
}

fn config_envelope(config: &nomoreide_core::config::Config) -> Response {
    let value = serde_json::to_value(config.public_view()).unwrap_or_else(|_| json!({}));
    Json(ConfigEnvelope {
        ok: true,
        config: value,
    })
    .into_response()
}

/// The dependency graph, as a pure function of config.
///
/// Live state is deliberately absent: the panel already holds the dashboard's
/// status payload and overlays it, so this stays a config read that costs
/// nothing to poll.
async fn graph(State(state): State<AppState>) -> Response {
    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to load NoMoreIDE config.",
            )
        }
    };
    Json(json!({ "ok": true, "graph": build_service_graph(&config.services) })).into_response()
}

/// One service's stored record.
///
/// The name is **not** trimmed before the lookup, so a request for a name of
/// spaces reports that name as unregistered rather than reporting a missing
/// field — this route has no notion of a required field at all, only of a
/// service that is there or is not.
async fn definition(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to load NoMoreIDE config.",
            )
        }
    };
    let Some(service) = config.services.iter().find(|s| s.name == name) else {
        return error(
            StatusCode::NOT_FOUND,
            &format!("Service \"{name}\" is not registered."),
        );
    };
    let mut response = Json(json!({ "ok": true, "service": service })).into_response();
    // The editor re-reads this after every save, so a cached copy would show
    // the values the user just replaced.
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Assign or clear a service's project folder.
///
/// Every refusal is a **404**, including a blank service name: the reference
/// wraps the whole call in one catch and answers 404 from it, so "you named no
/// service" and "you named one that is gone" are not distinguished by status.
async fn set_project(
    State(state): State<AppState>,
    Path(name): Path<String>,
    body: Bytes,
) -> Response {
    let form = parse_form(&body);
    match state
        .config_store
        .set_service_project(&name, form.get("projectPath").map(String::as_str))
        .await
    {
        Ok(config) => config_envelope(&config),
        Err(reason) => error(StatusCode::NOT_FOUND, &reason.to_string()),
    }
}

/// Register a bundle, or rename one.
///
/// Members are not checked against the registered services: a bundle may name a
/// service that does not exist yet, which is what lets a group be assembled
/// before its members are.
async fn register_bundle(State(state): State<AppState>, body: Bytes) -> Response {
    let form = parse_form(&body);
    let Some(name) = form
        .get("name")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        // Unwrapped in the reference, so this escapes as a 500.
        return error(StatusCode::INTERNAL_SERVER_ERROR, "name is required");
    };
    let services: Vec<String> = form
        .get("services")
        .map(String::as_str)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect();
    let previous = form
        .get("originalName")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    match state
        .config_store
        .register_bundle(
            BundleDef {
                name: name.to_string(),
                services,
            },
            previous,
        )
        .await
    {
        Ok(config) => config_envelope(&config),
        Err(reason) => error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
    }
}

async fn restart_bundle(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    match state.runtime.restart_bundle(&name).await {
        Ok(statuses) => Json(json!({ "ok": true, "statuses": statuses })).into_response(),
        Err(reason) => crate::server::errors::mutation_error(reason),
    }
}

/// Remove a service from config.
///
/// A service that is up is refused with a **409** rather than stopped first:
/// deleting a definition out from under a running process would leave one this
/// daemon can no longer name, and stopping it silently would be a second action
/// the caller did not ask for.
async fn remove_service(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    let running = state
        .runtime
        .status()
        .into_iter()
        .find(|entry| entry.name == name)
        .is_some_and(|entry| {
            matches!(
                entry.state,
                ServiceRuntimeState::Running | ServiceRuntimeState::Starting
            )
        });
    if running {
        return error(
            StatusCode::CONFLICT,
            &format!("Stop \"{name}\" before deleting it."),
        );
    }
    match state.config_store.remove_service(&name).await {
        Ok(config) => config_envelope(&config),
        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}
