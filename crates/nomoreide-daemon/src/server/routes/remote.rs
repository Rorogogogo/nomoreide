//! What the local CLI asks about remote control.
//!
//! Two endpoints, both for `nomoreide remote`. Neither is reachable from a
//! phone: they are on the daemon's own loopback router behind the local
//! credential, which is a different surface entirely from the relay's.
//!
//! `connect` exists because pairing and connecting are separate events. A
//! machine paired while its daemon is already running used to stay offline
//! until something restarted it, with nothing saying so — so `remote pair` now
//! asks the daemon to dial the moment the credential is on disk.

use crate::server::app::AppState;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/remote/status", get(status))
        .route("/api/remote/connect", post(connect))
}

/// Whether this machine is paired, and whether it is actually attached.
///
/// The two are reported separately on purpose. A credential on disk with
/// nothing connected is the state a freshly paired machine is in, and every
/// check that reads only the file calls it healthy.
async fn status(State(state): State<AppState>) -> Response {
    let paired = nomoreide_core::remote::credentials::RemoteCredentials::discover().load();
    let relay = state.relay.snapshot();
    Json(json!({
        "ok": true,
        "paired": paired.is_some(),
        "deviceName": paired.as_ref().map(|stored| stored.device_name.clone()),
        "deviceId": paired.as_ref().map(|stored| stored.device_id.clone()),
        "platformBaseUrl": paired.as_ref().map(|stored| stored.platform_base_url.clone()),
        "relay": relay,
    }))
    .into_response()
}

/// Start the relay connection now.
///
/// Idempotent: a second call while one is running is `alreadyRunning`, not a
/// second socket. The relay keeps only the newest connection per device, so a
/// duplicate would silently evict its own predecessor.
async fn connect(State(state): State<AppState>) -> Response {
    use crate::remote::supervisor::StartOutcome;
    let outcome = state.relay.ensure_started();
    let (ok, status) = match outcome {
        StartOutcome::Started => (true, "started"),
        StartOutcome::AlreadyRunning => (true, "alreadyRunning"),
        StartOutcome::NotPaired => (false, "notPaired"),
        StartOutcome::Disabled => (false, "disabled"),
    };
    Json(json!({ "ok": ok, "status": status })).into_response()
}
