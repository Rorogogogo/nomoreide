//! The context every route handler shares, and the credential check that stands
//! in front of the ones that speak for the runtime.

use crate::runtime::DaemonRuntime;
use crate::server::errors::error;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use nomoreide_core::config::ConfigStore;
use std::sync::Arc;
use subtle::ConstantTimeEq;
use tokio::sync::mpsc;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) credential: String,
    pub(crate) owner_id: String,
    pub(crate) config_store: ConfigStore,
    pub(crate) runtime: Arc<DaemonRuntime>,
    /// The same channel a SIGTERM pulls on. A shutdown asked for over HTTP has
    /// to drain the runtime the way a signalled one does, so both go through
    /// here rather than one of them exiting the process directly.
    pub(crate) shutdown: mpsc::Sender<()>,
}

/// Reject anything that does not carry the daemon's local credential.
///
/// This is a layer over the authenticated router rather than a line inside each
/// handler: a handler that forgot the check would be an authentication hole
/// that reads exactly like the handlers around it, and the number of handlers
/// only grows. Mounting a route in the authenticated router is what guards it.
pub(crate) async fn require_credential(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    if !authorized(request.headers(), &state.credential) {
        return error(StatusCode::UNAUTHORIZED, "Authentication required.");
    }
    next.run(request).await
}

/// Compared in constant time: a credential that leaks its prefix through timing
/// is guessable byte by byte.
fn authorized(headers: &HeaderMap, credential: &str) -> bool {
    let Some(candidate) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return false;
    };
    bool::from(candidate.as_bytes().ct_eq(credential.as_bytes()))
}
