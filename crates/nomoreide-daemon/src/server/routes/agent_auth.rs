//! Browser sign-in to the profile registry.
//!
//! Five endpoints around one handshake. `start` mints a state and hands back a
//! URL; the user signs in on the registry's own site; the registry redirects
//! the browser to `finish` on this daemon with a token in the query; the
//! dashboard, which never left, polls `outcome` until the state it started with
//! settles.
//!
//! **`finish` is the one API route outside the credential.** It is loaded by a
//! browser following a redirect, which carries no bearer token and cannot be
//! made to. What guards it instead is the state: a 32-hex nonce this daemon
//! minted, kept in memory, refused if it was not issued here. That is the same
//! thing guarding it in the reference, which has no credential at all.
//!
//! **`finish` answers HTML, and its status codes carry meaning.** 400 for a
//! state nobody issued, 401 for a token the registry rejects, 200 only once the
//! token has been used successfully. A tab is what reads this, so the status is
//! how a browser knows it landed on a failure.

use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Map, Value};

use nomoreide_core::agent_profiles::auth::{self, Outcome};
use nomoreide_core::agent_profiles::registry_config as config;

use crate::server::app::AppState;
use crate::server::routes::query::query_value;

/// Reached by a browser redirect, so it cannot be behind the credential.
pub(crate) fn public() -> Router<AppState> {
    Router::new().route("/api/agent-env/auth/finish", get(finish))
}

pub(crate) fn authenticated() -> Router<AppState> {
    Router::new()
        .route("/api/agent-env/auth/status", get(status))
        .route("/api/agent-env/auth/start", post(start))
        .route("/api/agent-env/auth/outcome", get(outcome))
        .route("/api/agent-env/auth/logout", post(logout))
}

/// Which registry this daemon talks to, and how that was decided — carried on
/// every answer here.
///
/// The dashboard shows it because "signed out" and "signed in to the wrong
/// backend" look identical otherwise, and the second is what happens when
/// someone signs in through the production site while pointed at a local API.
fn api_info() -> Vec<(String, Value)> {
    let target = config::api_target();
    let frontend = config::frontend_url(Some(&target.api_base_url));
    vec![
        ("apiBaseUrl".to_string(), json!(target.api_base_url)),
        ("apiMode".to_string(), json!(target.mode)),
        ("apiSource".to_string(), json!(target.source)),
        ("apiFrontendUrl".to_string(), json!(frontend)),
    ]
}

fn envelope(fields: Vec<(String, Value)>) -> Response {
    let mut body = Map::new();
    for (key, value) in fields {
        body.insert(key, value);
    }
    Json(Value::Object(body)).into_response()
}

/// Signed in, signed out, or holding a token the registry will not honour.
///
/// A token that fails to verify still reports *where* it came from, because the
/// remedy differs: a stored one can be signed out, and one from the environment
/// has to be changed in the shell that set it.
async fn status() -> Response {
    let mut fields: Vec<(String, Value)> = vec![("ok".to_string(), json!(true))];
    let Some(source) = auth::token_source() else {
        fields.push(("signedIn".to_string(), json!(false)));
        fields.extend(api_info());
        return envelope(fields);
    };
    let source = json!(source.as_str());
    match auth::authenticated_get("/me").await {
        Ok(response) if response.ok() => {
            let user: Value = serde_json::from_str(&response.body).unwrap_or(Value::Null);
            fields.push(("signedIn".to_string(), json!(true)));
            fields.push(("source".to_string(), source));
            fields.push(("user".to_string(), described(&user)));
        }
        Ok(response) => {
            fields.push(("signedIn".to_string(), json!(false)));
            fields.push(("source".to_string(), source));
            fields.push((
                "error".to_string(),
                json!(format!("HTTP {}", response.status)),
            ));
        }
        Err(reason) => {
            fields.push(("signedIn".to_string(), json!(false)));
            fields.push(("source".to_string(), source));
            fields.push(("error".to_string(), json!(reason)));
        }
    }
    fields.extend(api_info());
    envelope(fields)
}

/// The registry's snake_case account, renamed to the dashboard's camelCase.
///
/// A field the registry omitted stays omitted rather than becoming `null`: the
/// reference reads them into `undefined`, which `JSON.stringify` drops.
fn described(user: &Value) -> Value {
    let mut described = Map::new();
    let mut carry = |from: &str, to: &str| {
        if let Some(value) = user.get(from) {
            if !value.is_null() {
                described.insert(to.to_string(), value.clone());
            }
        }
    };
    carry("email", "email");
    carry("display_name", "displayName");
    carry("avatar_url", "avatarUrl");
    Value::Object(described)
}

/// Mint a state and build the URL the browser should visit.
///
/// The callback names *this* daemon by the `Host` the caller reached it on, so
/// a dashboard opened on a forwarded port sends the browser back to the address
/// that actually works rather than to the one the daemon binds.
async fn start(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let nonce = state.registry_auth.issue();
    let target = config::api_target();
    let frontend = config::frontend_url(Some(&target.api_base_url));
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("127.0.0.1:4317");
    let callback = format!(
        "http://{host}/api/agent-env/auth/finish?state={}",
        encode(&nonce)
    );
    let url = format!(
        "{frontend}/cli-login?state={}&callback={}",
        encode(&nonce),
        encode(&callback)
    );
    envelope(vec![
        ("ok".to_string(), json!(true)),
        ("url".to_string(), json!(url)),
        ("state".to_string(), json!(nonce)),
    ])
}

/// Where the registry sends the browser back to.
async fn finish(State(state): State<AppState>, uri: Uri) -> Response {
    let nonce = query_value(&uri, "state").unwrap_or_default();
    let token = query_value(&uri, "token").unwrap_or_default();
    let refresh_token = query_value(&uri, "refresh_token").unwrap_or_default();
    let refused = query_value(&uri, "error").unwrap_or_default();

    if nonce.is_empty() || !state.registry_auth.is_live(&nonce) {
        return html(
            StatusCode::BAD_REQUEST,
            "error",
            "Invalid or expired sign-in request.",
        );
    }
    if !refused.is_empty() {
        state
            .registry_auth
            .mark(&nonce, Outcome::Error(refused.clone()));
        return html(StatusCode::BAD_REQUEST, "error", &refused);
    }
    if token.trim().is_empty() {
        let message = "No token returned by the registry.";
        state
            .registry_auth
            .mark(&nonce, Outcome::Error(message.to_string()));
        return html(StatusCode::BAD_REQUEST, "error", message);
    }

    let refresh = Some(refresh_token.trim()).filter(|value| !value.is_empty());
    if let Err(reason) = auth::save_tokens(token.trim(), refresh) {
        let message = format!("Failed to save token: {reason}");
        state
            .registry_auth
            .mark(&nonce, Outcome::Error(message.clone()));
        return html(StatusCode::INTERNAL_SERVER_ERROR, "error", &message);
    }

    // Verified before it is called a sign-in. A token that stores cleanly and
    // then fails on the first call would leave the dashboard reporting success
    // over a session that does not work.
    match auth::authenticated_get("/me").await {
        Ok(response) if response.ok() => {
            state.registry_auth.mark(&nonce, Outcome::Success);
            html(
                StatusCode::OK,
                "ok",
                "You are signed in. You can close this tab.",
            )
        }
        Ok(response) => {
            let _ = auth::clear_tokens();
            let base = config::api_base_url();
            let message = if response.status == 401 {
                format!("Token was rejected by the registry API at {base}. The site you signed in through likely targets a different backend.")
            } else {
                format!(
                    "Registry API at {base} returned HTTP {} when verifying the token.",
                    response.status
                )
            };
            state
                .registry_auth
                .mark(&nonce, Outcome::Error(message.clone()));
            html(StatusCode::UNAUTHORIZED, "error", &message)
        }
        Err(reason) => {
            let message = format!("Failed to save token: {reason}");
            state
                .registry_auth
                .mark(&nonce, Outcome::Error(message.clone()));
            html(StatusCode::INTERNAL_SERVER_ERROR, "error", &message)
        }
    }
}

/// What became of a sign-in, once.
async fn outcome(State(state): State<AppState>, uri: Uri) -> Response {
    let nonce = query_value(&uri, "state").unwrap_or_default();
    let Some(outcome) = state.registry_auth.read(&nonce) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": true, "status": "unknown" })),
        )
            .into_response();
    };
    let mut fields = vec![
        ("ok".to_string(), json!(true)),
        ("status".to_string(), json!(outcome.as_str())),
    ];
    if let Outcome::Error(message) = &outcome {
        fields.push(("message".to_string(), json!(message)));
    }
    envelope(fields)
}

/// Signing out drops the stored tokens and says nothing about whether there
/// were any — the button does the same thing either way.
async fn logout() -> Response {
    match auth::clear_tokens() {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(reason) => crate::server::errors::error(StatusCode::INTERNAL_SERVER_ERROR, &reason),
    }
}

/// The page the browser lands on.
fn html(status: StatusCode, kind: &str, message: &str) -> Response {
    let tone = if kind == "ok" { "#16a34a" } else { "#dc2626" };
    let title = if kind == "ok" {
        "Signed in"
    } else {
        "Sign-in failed"
    };
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title} — NoMoreIDE</title></head>\n\
<body style=\"font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0\">\n\
<div style=\"text-align:center;max-width:28rem;padding:1rem\">\n\
<h1 style=\"color:{tone};font-size:1.25rem\">{title}</h1>\n\
<p style=\"color:#555\">{}</p>\n\
</div></body></html>",
        escape(message)
    );
    (
        status,
        [(
            axum::http::header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        )],
        body,
    )
        .into_response()
}

/// The message is interpolated into a page on this daemon's own origin, and
/// one of its sources is a query parameter — so it is escaped rather than
/// trusted. The reference escapes it too; both were changed together, because
/// a page that runs script here runs it same-origin with the dashboard.
fn escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            other => escaped.push(other),
        }
    }
    escaped
}

/// `encodeURIComponent`, whose unreserved set is wider than a URL crate's
/// default. It matters here because the result is compared against the
/// reference byte for byte.
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_callback_is_encoded_the_way_the_browser_will_read_it() {
        assert_eq!(
            encode("http://127.0.0.1:4317/api/agent-env/auth/finish?state=abc"),
            "http%3A%2F%2F127.0.0.1%3A4317%2Fapi%2Fagent-env%2Fauth%2Ffinish%3Fstate%3Dabc"
        );
    }

    #[test]
    fn a_message_cannot_carry_markup_onto_the_page() {
        assert_eq!(
            escape("<script>alert('x')</script>"),
            "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"
        );
    }

    #[test]
    fn an_ordinary_message_is_left_alone() {
        assert_eq!(escape("access_denied"), "access_denied");
    }
}
