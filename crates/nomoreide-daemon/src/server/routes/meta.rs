//! What the daemon says about itself rather than about what it runs.

use crate::server::app::AppState;
use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

pub(crate) fn routes() -> Router<AppState> {
    Router::new().route("/api/health", get(health))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthEnvelope {
    ok: bool,
    app: &'static str,
    version: &'static str,
    pid: u32,
    owner_id: String,
}

/// The owner id is the point: a client that finds *a* daemon on the configured
/// port still has to confirm it is the one its state file recorded.
async fn health(State(state): State<AppState>) -> Json<HealthEnvelope> {
    Json(HealthEnvelope {
        ok: true,
        app: "nomoreide",
        version: env!("CARGO_PKG_VERSION"),
        pid: std::process::id(),
        owner_id: state.owner_id,
    })
}
