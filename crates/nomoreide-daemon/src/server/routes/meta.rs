//! What the daemon says about itself rather than about what it runs.

use crate::server::app::AppState;
use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;

/// Reachable before a client has read the credential, because finding the
/// daemon is what a client does first.
pub(crate) fn public() -> Router<AppState> {
    Router::new().route("/api/health", get(health))
}

/// Stopping the daemon stops every service on the machine, so it sits behind
/// the credential with the rest of the runtime.
pub(crate) fn authenticated() -> Router<AppState> {
    Router::new().route("/api/daemon/shutdown", post(shutdown))
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

#[derive(Serialize)]
struct ShutdownEnvelope {
    ok: bool,
}

/// Answers before the daemon is down, not after: draining the services takes
/// as long as they take to stop, and a caller that waited for the socket to
/// close would be waiting on its own request to be dropped.
async fn shutdown(State(state): State<AppState>) -> Json<ShutdownEnvelope> {
    let _ = state.shutdown.try_send(());
    Json(ShutdownEnvelope { ok: true })
}
