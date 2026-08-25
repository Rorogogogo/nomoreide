//! The route registry. Adding an endpoint means extending a domain module below
//! — or adding one and merging it here — and never editing the request path in
//! `server.rs`.

mod agent_chat;
mod bundles;
mod database;
mod database_catalog;
mod database_write;
mod errors;
mod git;
mod github;
mod meta;
mod service_config;
mod services;
mod shell;
mod terminal;
mod timeline;

use crate::server::app::{require_credential, AppState};
use axum::http::header::CONTENT_TYPE;
use axum::http::HeaderValue;
use axum::response::Response;
use axum::{middleware, Router};

pub(crate) fn router(state: AppState) -> Router {
    Router::new()
        // Health is what a client probes to find the daemon, before it has read
        // the credential — so it is deliberately the one endpoint outside the
        // authenticated router.
        .merge(meta::public())
        .merge(authenticated(state.clone()))
        // Last, so every `/api/*` route above wins first — the dispatch order
        // the reference gets by registering its shell routes at the end of the
        // list. Anything the shell does not claim falls through to the same
        // 404 the fallback used to answer directly.
        .fallback(shell::serve)
        // A wrong method falls through to the shell, not to a 405.
        //
        // The reference registers most endpoints with an exact method, so a
        // request that misses it matches nothing and reaches the shell routes
        // at the end of the list, which answer `404 Not found` as HTML. Only
        // its *pattern* routes answer 405, because there the handler checks the
        // method itself — and the modules that mirror those say so with their
        // own `.fallback(method_not_allowed)`, which wins over this one.
        .method_not_allowed_fallback(shell::serve)
        .layer(middleware::map_response(declare_json_charset))
        .with_state(state)
}

/// Say which encoding the JSON is in.
///
/// The reference writes `application/json; charset=utf-8` from its one
/// `sendJson`, and the JSON serializer here writes a bare `application/json`.
/// Both are UTF-8 and every client this daemon has reads them the same way —
/// but the header is part of the answer, and an answer that differs is a
/// divergence whether or not anything currently notices.
///
/// Applied here rather than at each route, because the alternative is a rule
/// every future route has to remember. Only the exact bare value is rewritten,
/// so a route that deliberately says something else keeps saying it.
async fn declare_json_charset(mut response: Response) -> Response {
    const BARE: HeaderValue = HeaderValue::from_static("application/json");
    const WITH_CHARSET: HeaderValue = HeaderValue::from_static("application/json; charset=utf-8");
    if response.headers().get(CONTENT_TYPE) == Some(&BARE) {
        response.headers_mut().insert(CONTENT_TYPE, WITH_CHARSET);
    }
    response
}

/// Everything that speaks for the runtime. `route_layer` runs the credential
/// check only once a route has matched, so an unknown path is still a 404 and a
/// known path with the wrong method is still a 405 — the guard protects the
/// endpoints, it does not hide which ones exist.
fn authenticated(state: AppState) -> Router<AppState> {
    Router::new()
        .merge(meta::authenticated())
        .merge(agent_chat::routes())
        .merge(errors::routes())
        .merge(database::routes())
        .merge(database_catalog::routes())
        .merge(database_write::routes())
        .merge(services::routes())
        .merge(service_config::routes())
        .merge(bundles::routes())
        .merge(timeline::routes())
        .merge(terminal::routes())
        .merge(git::routes())
        .merge(github::routes())
        .route_layer(middleware::from_fn_with_state(state, require_credential))
}
