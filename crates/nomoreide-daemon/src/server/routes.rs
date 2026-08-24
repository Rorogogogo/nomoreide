//! The route registry. Adding an endpoint means extending a domain module below
//! — or adding one and merging it here — and never editing the request path in
//! `server.rs`.

mod bundles;
mod errors;
mod meta;
mod services;
mod terminal;
mod timeline;

use crate::server::app::{require_credential, AppState};
use crate::server::errors::{method_not_allowed, not_found};
use axum::{middleware, Router};

pub(crate) fn router(state: AppState) -> Router {
    Router::new()
        // Health is what a client probes to find the daemon, before it has read
        // the credential — so it is deliberately the one endpoint outside the
        // authenticated router.
        .merge(meta::public())
        .merge(authenticated(state.clone()))
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .with_state(state)
}

/// Everything that speaks for the runtime. `route_layer` runs the credential
/// check only once a route has matched, so an unknown path is still a 404 and a
/// known path with the wrong method is still a 405 — the guard protects the
/// endpoints, it does not hide which ones exist.
fn authenticated(state: AppState) -> Router<AppState> {
    Router::new()
        .merge(meta::authenticated())
        .merge(errors::routes())
        .merge(services::routes())
        .merge(bundles::routes())
        .merge(timeline::routes())
        .merge(terminal::routes())
        .route_layer(middleware::from_fn_with_state(state, require_credential))
}
