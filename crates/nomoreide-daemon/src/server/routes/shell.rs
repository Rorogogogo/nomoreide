//! The dashboard itself: `/assets/*` and the SPA shell.
//!
//! Registered as the router's fallback rather than as routes, which is how it
//! keeps the reference's dispatch order — every `/api/*` route is matched
//! first, and only what none of them claimed reaches here. It also sits
//! *outside* the credential layer: a browser loading a document cannot send an
//! `Authorization` header, and the shell carries nothing worth guarding.

use crate::server::errors::unmatched;
use crate::server::static_assets::{normalize_request_path, read_asset, read_shell, serves_shell};
use axum::http::{header, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};

const HTML: &str = "text/html; charset=utf-8";

pub(crate) async fn serve(method: Method, uri: Uri) -> Response {
    // Normalized first, because the reference's URL parser has already done it
    // by the time its dispatcher runs — see `normalize_request_path`.
    let path = normalize_request_path(uri.path());
    let path = path.as_str();

    // The reference registers its asset route for GET only, so a HEAD for an
    // asset is not a page and not an asset — it falls through to the 404 that
    // any other unmatched path gets.
    if method == Method::GET && path.starts_with("/assets/") {
        return match read_asset(path) {
            Some((bytes, content_type)) => (
                [(header::CONTENT_TYPE, HeaderValue::from_static(content_type))],
                bytes,
            )
                .into_response(),
            // HTML, not the daemon's JSON envelope: this answers a browser
            // asking for a file, and the reference answers it the same way.
            None => (
                StatusCode::NOT_FOUND,
                [(header::CONTENT_TYPE, HeaderValue::from_static(HTML))],
                "Not found",
            )
                .into_response(),
        };
    }

    if serves_shell(path) {
        match method {
            // A HEAD announces the shell without rendering it — what a client
            // probing for "is the dashboard here" gets.
            Method::HEAD => {
                return (
                    [(header::CONTENT_TYPE, HeaderValue::from_static(HTML))],
                    axum::body::Body::empty(),
                )
                    .into_response()
            }
            Method::GET => {
                return match read_shell() {
                    Ok(html) => (
                        [(header::CONTENT_TYPE, HeaderValue::from_static(HTML))],
                        html,
                    )
                        .into_response(),
                    // An unbuilt checkout, which is a real state a developer
                    // reaches — say so instead of 404ing as if the page did
                    // not exist.
                    Err(reason) => {
                        crate::server::errors::error(StatusCode::INTERNAL_SERVER_ERROR, &reason)
                    }
                };
            }
            _ => {}
        }
    }

    unmatched().await
}
