//! The route registry. Adding an endpoint means extending a domain module below
//! — or adding one and merging it here — and never editing the request path in
//! `server.rs`.

mod agent_auth;
mod agent_chat;
mod agent_env;
mod agent_info;
mod agent_profiles;
mod agent_registry;
mod agent_status;
mod bundles;
mod change_sets;
mod context;
mod dashboard;
mod database;
mod database_catalog;
mod database_write;
pub(crate) mod deploy_providers;
mod docker;
mod errors;
mod extensions;
mod fs_directories;
mod git;
mod github;
mod host_providers;
mod jetbrains;
mod log_sources;
mod meta;
mod metrics;
mod onboard;
mod query;
pub(crate) mod remote;
mod servers;
mod service_config;
mod service_files;
mod service_register;
mod service_test;
mod services;
mod settings;
mod shell;
mod skills;
mod snapshots;
mod terminal;
mod timeline;
mod usage;

pub(crate) use usage::daemon_cwd;
mod workflow_triggers;
mod workflows;

use crate::server::app::{require_credential, AppState};
use axum::http::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    ACCESS_CONTROL_MAX_AGE, ACCESS_CONTROL_REQUEST_METHOD, CONTENT_TYPE, ORIGIN, VARY,
};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{middleware, Router};

const DESKTOP_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://127.0.0.1:5173",
];

/// Permit only the origins the bundled Tauri webview can actually use.
///
/// This is installed only on the embedded daemon. The bearer credential is
/// still required; CORS merely lets the webview send it to its private port.
pub(crate) async fn allow_desktop_origin(
    request: axum::extract::Request,
    next: middleware::Next,
) -> Response {
    let origin = request.headers().get(ORIGIN).cloned();
    let allowed = origin.as_ref().is_some_and(|origin| {
        DESKTOP_ORIGINS
            .iter()
            .any(|candidate| origin.as_bytes() == candidate.as_bytes())
    });
    let preflight = request.method() == Method::OPTIONS
        && request
            .headers()
            .contains_key(ACCESS_CONTROL_REQUEST_METHOD);

    if preflight && !allowed {
        return StatusCode::FORBIDDEN.into_response();
    }

    let mut response = if preflight {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    if allowed {
        let headers = response.headers_mut();
        headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin.expect("allowed origin"));
        headers.insert(
            ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"),
        );
        headers.insert(
            ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("authorization, content-type, x-nomoreide-terminal-control"),
        );
        headers.insert(ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
        headers.append(VARY, HeaderValue::from_static("Origin"));
    }
    response
}

pub(crate) fn router(state: AppState) -> Router {
    Router::new()
        // Health is what a client probes to find the daemon, before it has read
        // the credential — so it is deliberately the one endpoint outside the
        // authenticated router.
        .merge(meta::public())
        // Loaded by a browser following the registry's redirect, which carries
        // no credential and cannot be given one.
        .merge(agent_auth::public())
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
        // Outermost, so it decides before anything is matched.
        .layer(middleware::from_fn(refuse_empty_segments))
        .with_state(state)
}

/// A path with an empty segment in it reaches the shell, not a route.
///
/// The reference's parameterised routes are regexes over the **raw** pathname,
/// and every one of them requires at least one character — `([^/]+)`, `(\d+)`.
/// So `/api/snapshots//files` matches nothing there and falls through to the
/// shell's 404. This router's `:param` segments happily match an empty string,
/// which turned the same request into whatever the handler made of a blank
/// name: an "invalid sha" here, an unregistered service there.
///
/// One layer rather than a check in every handler, because it is one rule and
/// it holds for every route: no reference pattern can match an empty segment,
/// and no exact path contains one.
async fn refuse_empty_segments(
    request: axum::extract::Request,
    next: middleware::Next,
) -> Response {
    let path = request.uri().path();
    if path.starts_with("/api/") && path.split('/').skip(1).any(str::is_empty) {
        let method = request.method().clone();
        let uri = request.uri().clone();
        return shell::serve_unauthenticated(method, uri).await;
    }
    next.run(request).await
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
        .merge(agent_auth::authenticated())
        .merge(agent_chat::routes())
        .merge(agent_env::routes())
        .merge(agent_info::routes())
        .merge(agent_status::routes())
        .merge(usage::routes())
        .merge(agent_registry::routes())
        .merge(agent_profiles::routes())
        .merge(docker::routes())
        .merge(errors::routes())
        .merge(extensions::routes())
        .merge(deploy_providers::routes())
        .merge(host_providers::routes())
        .merge(dashboard::routes())
        .merge(database::routes())
        .merge(database_catalog::routes())
        .merge(database_write::routes())
        .merge(servers::routes())
        .merge(services::routes())
        .merge(service_config::routes())
        .merge(service_files::routes())
        .merge(service_register::routes())
        .merge(service_test::routes())
        .merge(fs_directories::routes())
        .merge(jetbrains::routes())
        .merge(log_sources::routes())
        .merge(metrics::routes())
        .merge(onboard::routes())
        .merge(remote::routes())
        .merge(snapshots::routes())
        .merge(settings::routes())
        .merge(skills::routes())
        .merge(workflows::routes())
        .merge(workflow_triggers::routes())
        .merge(bundles::routes())
        .merge(change_sets::routes())
        .merge(context::routes())
        .merge(timeline::routes())
        .merge(terminal::routes())
        .merge(git::routes())
        .merge(github::routes())
        .route_layer(middleware::from_fn_with_state(state, require_credential))
}
