//! Starting and stopping named groups of services.

use crate::server::app::AppState;
use crate::server::errors::mutation_error;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use nomoreide_daemon_client::protocol::BundleMutationEnvelope;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/bundles/:name/start", post(start_bundle))
        .route("/api/bundles/:name/stop", post(stop_bundle))
}

async fn start_bundle(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    bundle_action(state, name, BundleAction::Start).await
}

async fn stop_bundle(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    bundle_action(state, name, BundleAction::Stop).await
}

enum BundleAction {
    Start,
    Stop,
}

/// Ordering, dependency expansion, and how far a partial failure gets are all
/// the runtime's policy; the route only reports the statuses it hands back.
async fn bundle_action(state: AppState, name: String, action: BundleAction) -> Response {
    let result = match action {
        BundleAction::Start => state.runtime.start_bundle(&name).await,
        BundleAction::Stop => state.runtime.stop_bundle(&name).await,
    };
    match result {
        Ok(statuses) => Json(BundleMutationEnvelope { ok: true, statuses }).into_response(),
        Err(error) => mutation_error(error),
    }
}
