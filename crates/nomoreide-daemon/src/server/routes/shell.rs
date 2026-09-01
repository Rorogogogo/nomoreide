//! The dashboard itself: `/assets/*` and the SPA shell.
//!
//! Registered as the router's fallback rather than as routes, which is how it
//! keeps the reference's dispatch order — every `/api/*` route is matched
//! first, and only what none of them claimed reaches here. It sits *outside*
//! the credential layer, because a browser loading a document cannot send an
//! `Authorization` header.
//!
//! **Which is why the shell hands the page its credential.** Every `/api/*`
//! route is behind `require_credential`, and a browser has no other way to
//! learn one — so before this, the dashboard loaded and then answered every
//! request with `401 Authentication required`. The credential goes into the
//! document as a frozen global the client reads on its first call.
//!
//! A bearer token rather than a cookie, deliberately. A cookie would ride
//! along on any request a *different* origin caused the browser to make, which
//! is textbook CSRF against a daemon that can start and stop processes. A
//! header cannot be set cross-origin, so a hostile page can neither read this
//! value (the response is same-origin) nor replay it.
//!
//! This is not a new exposure: the credential file is already `0600`, so any
//! process running as this user could read it directly.

use crate::server::app::AppState;
use crate::server::errors::unmatched;
use crate::server::static_assets::{normalize_request_path, read_asset, read_shell, serves_shell};
use axum::extract::State;
use axum::http::{header, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};

const HTML: &str = "text/html; charset=utf-8";

/// Put the daemon's credential in the document, as a frozen global.
///
/// Injected before `</head>` so it exists before any bundle runs — the client
/// reads it on its first API call, and a value that arrived later would mean a
/// race between the first request and the script that authorises it.
///
/// JSON-encoded *and* `<` escaped. `serde_json` does not escape `<`, so a
/// value containing `</script>` would close the element and turn the rest of
/// the document into markup — `\u003c` is the same string to a JSON parser and
/// inert to an HTML one. Today's credential is 64 hex characters and could
/// never do this; the escape is here so that stays true if it ever changes.
fn with_credential(html: String, credential: Option<&str>) -> String {
    let Some(credential) = credential else {
        return html;
    };
    let payload = serde_json::json!({ "credential": credential })
        .to_string()
        .replace('<', "\\u003c");
    let script = format!(
        "<script>Object.defineProperty(window,'__NOMOREIDE_WEB__',\
{{value:Object.freeze({payload}),enumerable:false,configurable:false,writable:false}});</script>"
    );
    match html.find("</head>") {
        Some(at) => {
            let mut out = String::with_capacity(html.len() + script.len());
            out.push_str(&html[..at]);
            out.push_str(&script);
            out.push_str(&html[at..]);
            out
        }
        // A shell with no `</head>` is not one this project builds, but
        // prepending still yields a document that runs the script first.
        None => format!("{script}{html}"),
    }
}

pub(crate) async fn serve(State(state): State<AppState>, method: Method, uri: Uri) -> Response {
    serve_inner(method, uri, Some(state.credential.as_str())).await
}

/// The shell with no credential to hand out — the empty-segment path, which
/// only ever answers `/api/…` with a 404 and never renders the document.
pub(crate) async fn serve_unauthenticated(method: Method, uri: Uri) -> Response {
    serve_inner(method, uri, None).await
}

async fn serve_inner(method: Method, uri: Uri, credential: Option<&str>) -> Response {
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
                        with_credential(html, credential),
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

#[cfg(test)]
mod tests {
    use super::*;

    const SHELL: &str = "<!doctype html><html><head><title>x</title></head><body></body></html>";

    #[test]
    fn the_document_carries_the_credential_before_any_script_runs() {
        let html = with_credential(SHELL.to_string(), Some("abc123"));
        let script_at = html
            .find("__NOMOREIDE_WEB__")
            .expect("the global is injected");
        let head_end = html.find("</head>").expect("head is still closed");
        assert!(
            script_at < head_end,
            "the credential has to exist before the bundle loads, or the first \
             API call races the script that authorises it"
        );
        assert!(html.contains("abc123"));
    }

    /// The empty-segment path answers `/api/…` and never renders a document,
    /// so it is handed no credential — and must not invent one.
    #[test]
    fn no_credential_means_the_document_is_untouched() {
        assert_eq!(with_credential(SHELL.to_string(), None), SHELL);
    }

    /// JSON-encoded, so a value containing `</script>` cannot close the element
    /// early and turn the rest of the document into markup.
    #[test]
    fn a_credential_cannot_break_out_of_its_script_element() {
        let html = with_credential(SHELL.to_string(), Some("</script><img src=x>"));
        assert!(
            !html.contains("</script><img src=x>"),
            "the raw value escaped into the document"
        );
        assert!(html.contains("<\\/script>") || html.contains("\\u003c"));
    }

    #[test]
    fn a_shell_without_a_head_still_gets_the_credential_first() {
        let html = with_credential("<body>hi</body>".to_string(), Some("abc123"));
        assert!(html.starts_with("<script>"));
        assert!(html.contains("abc123"));
    }
}
