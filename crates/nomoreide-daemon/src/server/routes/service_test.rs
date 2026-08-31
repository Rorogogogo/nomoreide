//! Running a service's own test command, and watching one run.
//!
//! Both are pattern routes in the reference, so their handlers check the method
//! themselves and answer a JSON 405 rather than falling through to the shell.
//!
//! The stream's `event:` name changes frame to frame — `status`, then `output`,
//! then `status` — which is why `sse::Frame` carries the name rather than the
//! stream declaring one.

use crate::server::app::AppState;
use crate::server::errors::{error, method_not_allowed};
use crate::server::sse;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/services/:name/test",
            post(start).fallback(method_not_allowed),
        )
        .route(
            "/api/services/:name/test/stream",
            get(watch).fallback(method_not_allowed),
        )
}

/// Start a run.
///
/// A refusal is a **409**, not a 400: both reasons the runner gives — a run
/// already in progress, a service that is not registered — are about the state
/// of the world rather than the shape of the request.
async fn start(State(state): State<AppState>, Path(name): Path<String>, body: Bytes) -> Response {
    let pattern = crate::server::body::parse_form(&body)
        .get("pattern")
        .cloned();
    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(reason) => return error(StatusCode::CONFLICT, &reason.to_string()),
    };
    let cwd = crate::server::routes::daemon_cwd();
    match state
        .tests
        .run(&config, &cwd, &name, pattern.as_deref())
        .await
    {
        Ok(run) => Json(json!({ "ok": true, "run": run })).into_response(),
        Err(reason) => error(StatusCode::CONFLICT, &reason),
    }
}

/// Watch a service's runs.
///
/// The replay is the *current or most recent* run, so a page opened after a run
/// finished still shows how it went. A service nobody has run replays nothing.
async fn watch(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    let replay = state
        .tests
        .current(&name)
        .map(|run| {
            sse::named(
                "status",
                nomoreide_core::test_runner::TestRunEvent {
                    kind: "status".to_string(),
                    run,
                    line: None,
                },
            )
        })
        .into_iter()
        .collect();
    // One channel carries every service's runs, so this takes only its own.
    let wanted = name.clone();
    sse::stream(
        sse::RETRY_AND_PING,
        replay,
        state.tests.events(),
        move |event| (event.run.service == wanted).then(|| sse::named(&event.kind.clone(), event)),
    )
}
