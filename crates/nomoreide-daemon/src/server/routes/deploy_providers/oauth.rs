//! Browser sign-in for a deploy provider: `start`, the `callback` the vendor
//! redirects to, and the `status` the dashboard polls.
//!
//! The Rust half of the OAuth block in `src/web/routes/provider-routes.ts`, and
//! a submodule of its own because it is the one stateful thing on this surface.
//! Everything else here answers from config and a vendor round trip; **a
//! sign-in spans three unrelated requests** — the dashboard's `start`, the
//! browser's `callback`, and however many `status` polls — so something has to
//! outlive all three. That is [`ProviderLogins`], held by the daemon rather
//! than by this module, the same way `registry_auth` is.
//!
//! **`callback` answers HTML, not JSON**, because its reader is a browser tab
//! the vendor redirected, not the dashboard. The dashboard learns the outcome
//! by polling `status`, which is why the phase is recorded before the page is
//! written.
//!
//! **The provider is read from the pending sign-in, not from the path.** A
//! callback can therefore only ever store tokens for a sign-in that was
//! actually started — an unknown `state` is a stale tab or a forged request,
//! and either way no code is exchanged.
//!
//! Two orderings here are observable and neither is a house style:
//!
//! - `start` resolves the provider **and its OAuth spec** before checking the
//!   verb, so a `GET` to a provider with no browser sign-in is a 500 saying so
//!   rather than a 405. The verb check is also outside the `catch`, so a 405
//!   leaves the recorded phase alone where a 500 sets it to `error`.
//! - `callback` and `status` check no verb at all.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::{Json, Router};
use nomoreide_core::config::ProviderConnectionDef;
use nomoreide_core::providers::oauth::{
    begin_login, complete_login, loopback_callback_url, LoginSessions, PendingLogin,
};
use nomoreide_core::providers::registry::{provider_oauth, require_deploy_provider};
use serde_json::{json, Value};

use crate::server::app::AppState;
use crate::server::errors::{error, method_not_allowed};
use crate::server::routes::query::query_value;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/providers/:provider/oauth/start", any(start))
        .route("/api/providers/:provider/oauth/callback", any(callback))
        .route("/api/providers/:provider/oauth/status", any(status))
}

/// Where a provider's sign-in has got to, as the dashboard's poll reads it.
#[derive(Debug, Clone)]
enum LoginPhase {
    Idle,
    Pending,
    Connected,
    Error(String),
}

impl LoginPhase {
    /// Flattened into the answer rather than nested, because the reference
    /// spreads it: `{ ok: true, phase, error? }`.
    fn into_body(self) -> Value {
        match self {
            Self::Idle => json!({ "ok": true, "phase": "idle" }),
            Self::Pending => json!({ "ok": true, "phase": "pending" }),
            Self::Connected => json!({ "ok": true, "phase": "connected" }),
            Self::Error(error) => json!({ "ok": true, "phase": "error", "error": error }),
        }
    }
}

/// Sign-ins awaiting their browser callback, plus the outcome of the most
/// recent one, per provider.
///
/// Three maps rather than one because they are keyed differently and swept
/// differently: the verifier is keyed by `state` and expires on its own, the
/// phase is keyed by provider and is the last word until the next sign-in, and
/// the third ties a `state` back to the provider whose sign-in it belongs to.
#[derive(Clone, Default)]
pub(crate) struct ProviderLogins {
    inner: Arc<Logins>,
}

#[derive(Default)]
struct Logins {
    sessions: LoginSessions,
    phases: Mutex<HashMap<String, LoginPhase>>,
    /// `state` → provider id, so the callback can store tokens for the sign-in
    /// that was started rather than for whatever the path happens to name.
    owners: Mutex<HashMap<String, String>>,
}

impl ProviderLogins {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    fn phase(&self, provider: &str) -> LoginPhase {
        lock(&self.inner.phases)
            .get(provider)
            .cloned()
            .unwrap_or(LoginPhase::Idle)
    }

    fn set_phase(&self, provider: &str, phase: LoginPhase) {
        lock(&self.inner.phases).insert(provider.to_string(), phase);
    }

    /// Forget whatever the last sign-in ended as.
    ///
    /// Called when a connection is removed, and it is not housekeeping: without
    /// it a disconnect after a failed sign-in leaves `status` reporting that
    /// error forever, so the panel keeps showing a stale failure for an account
    /// that is no longer connected at all.
    pub(crate) fn forget(&self, provider: &str) {
        self.set_phase(provider, LoginPhase::Idle);
    }

    fn remember(&self, provider: &str, login: PendingLogin) {
        lock(&self.inner.owners).insert(login.state.clone(), provider.to_string());
        self.inner.sessions.remember(login);
    }

    /// The pending sign-in for `state`, and whoever started it. Both are
    /// forgotten in the taking — a code is redeemable once.
    fn take(&self, state: &str) -> (Option<PendingLogin>, Option<String>) {
        let login = self.inner.sessions.take(state);
        let owner = lock(&self.inner.owners).remove(state);
        (login, owner)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

/// Mints a sign-in and hands back the URL the dashboard must open.
///
/// A refusal is a **500** *and* an error phase, so a dashboard that never saw
/// the response body still learns why from its next poll. The 405 is neither:
/// it is a caller mistake, not a failed sign-in, and recording it would make
/// the panel say a sign-in had broken when none had started.
async fn start(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    method: Method,
    headers: axum::http::HeaderMap,
) -> Response {
    let logins = state.provider_logins.clone();
    let spec = match require_deploy_provider(&provider)
        .and_then(|manifest| browser_sign_in(&manifest, &provider))
    {
        Ok(spec) => spec,
        Err(message) => return refuse(&logins, &provider, message),
    };
    if method != Method::POST {
        return method_not_allowed().await;
    }

    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok());
    let redirect_uri = match loopback_callback_url(&spec, host) {
        Ok(url) => url,
        Err(message) => return refuse(&logins, &provider, message),
    };
    let pending = match begin_login(&spec, &redirect_uri).await {
        Ok(pending) => pending,
        Err(message) => return refuse(&logins, &provider, message),
    };

    let url = pending.authorize_url.clone();
    // Keyed by the *manifest's* id, which is what the callback will report the
    // outcome under — while a refusal above is keyed by the path segment,
    // because there may be no manifest to ask.
    let id = spec_provider_id(&provider);
    logins.remember(&id, pending);
    logins.set_phase(&id, LoginPhase::Pending);
    Json(json!({ "ok": true, "url": url })).into_response()
}

/// Where the provider returns the user.
///
/// Renders a page for the browser tab rather than JSON — the dashboard learns
/// the outcome by polling `status`. Every failure is a **400** with the same
/// page, because a browser showing a blank tab is worse than one showing what
/// went wrong.
async fn callback(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    uri: axum::http::Uri,
) -> Response {
    let logins = state.provider_logins.clone();
    let fail = |message: String| -> Response {
        logins.set_phase(&provider, LoginPhase::Error(message.clone()));
        html(
            StatusCode::BAD_REQUEST,
            &login_result_page("Sign-in failed", &message),
        )
    };

    if let Some(denied) =
        query_value(&uri, "error_description").or_else(|| query_value(&uri, "error"))
    {
        return fail(denied);
    }

    let code = query_value(&uri, "code");
    let state_param = query_value(&uri, "state");
    // An unknown `state` means this callback does not match a sign-in we
    // started — a stale tab, or a forged request. Either way, no exchange.
    let (pending, owner) = match state_param.as_deref() {
        Some(value) => logins.take(value),
        None => (None, None),
    };
    let (Some(code), Some(pending)) = (code, pending) else {
        return fail(
            "This sign-in link has expired. Start the sign-in again from NoMoreIDE.".to_string(),
        );
    };

    let provider_id = owner.unwrap_or_else(|| provider.clone());
    let spec = match require_deploy_provider(&provider_id)
        .and_then(|manifest| browser_sign_in(&manifest, &provider_id))
    {
        Ok(spec) => spec,
        Err(message) => return fail(message),
    };
    let tokens = match complete_login(&spec, &pending, &code).await {
        Ok(tokens) => tokens,
        Err(message) => return fail(message),
    };

    let connection = ProviderConnectionDef {
        source: "oauth".into(),
        token: Some(tokens.access_token),
        refresh_token: tokens.refresh_token,
        expires_at: Some(tokens.expires_at),
        client_id: Some(pending.client_id),
        ..ProviderConnectionDef::default()
    };
    if let Err(failure) = state
        .config_store
        .set_connection(&provider_id, connection)
        .await
    {
        return fail(failure.to_string());
    }

    logins.set_phase(&provider_id, LoginPhase::Connected);
    html(
        StatusCode::OK,
        &login_result_page(
            &format!("Connected to {}", spec.name),
            "You can close this tab and return to NoMoreIDE.",
        ),
    )
}

/// What the dashboard polls while the browser tab is open. Guards no verb and
/// never fails: an id no provider claims is simply `idle`.
async fn status(State(state): State<AppState>, Path(provider): Path<String>) -> Response {
    Json(state.provider_logins.phase(&provider).into_body()).into_response()
}

/// The provider's OAuth spec, or the sentence saying it has none.
fn browser_sign_in(
    manifest: &Value,
    provider_id: &str,
) -> Result<nomoreide_core::providers::oauth::ProviderOAuthSpec, String> {
    provider_oauth(provider_id).ok_or_else(|| {
        let name = manifest
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(provider_id);
        format!("{name} has no browser sign-in.")
    })
}

/// The id the manifest goes by, which is what the callback and the poll agree
/// on. Falls back to the path segment for an id no provider claims — the phase
/// still has to be filed somewhere the poll will look.
fn spec_provider_id(provider: &str) -> String {
    require_deploy_provider(provider)
        .ok()
        .and_then(|manifest| {
            manifest
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| provider.to_string())
}

/// A 500 that also records why, so the dashboard's next poll can say it.
fn refuse(logins: &ProviderLogins, provider: &str, message: String) -> Response {
    logins.set_phase(provider, LoginPhase::Error(message.clone()));
    error(StatusCode::INTERNAL_SERVER_ERROR, &message)
}

fn html(status: StatusCode, body: &str) -> Response {
    (
        status,
        [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
        body.to_string(),
    )
        .into_response()
}

/// The page the browser tab is left on.
///
/// Byte-identical to the reference's, because it is a response body a gate
/// compares like any other — the whitespace and the line breaks inside the
/// `<style>` are part of it.
fn login_result_page(heading: &str, detail: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{heading}</title>\n\
<style>body{{font:15px/1.5 ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#111}}\n\
@media(prefers-color-scheme:dark){{body{{background:#0a0a0a;color:#fafafa}}}}\n\
div{{text-align:center;max-width:32rem;padding:2rem}}p{{opacity:.7}}</style></head>\n\
<body><div><h2>{heading}</h2><p>{}</p></div></body></html>",
        escape_html(detail)
    )
}

/// Error text reaches this page from the network, so it is escaped rather than
/// interpolated raw. The heading never is — those are ours.
fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_supplied_text_is_escaped_into_the_page() {
        let page = login_result_page("Sign-in failed", "<script>alert('x')</script>");
        assert!(
            page.contains("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"),
            "{page}"
        );
        assert!(!page.contains("<script>"), "{page}");
    }

    /// The heading reaches both the title and the body, and neither is escaped
    /// there — the reference interpolates it raw, and it is never network text.
    #[test]
    fn the_heading_is_ours_and_travels_unescaped() {
        let page = login_result_page("Connected to Vercel", "detail");
        assert!(
            page.contains("<title>Connected to Vercel</title>"),
            "{page}"
        );
        assert!(page.contains("<h2>Connected to Vercel</h2>"), "{page}");
    }

    #[test]
    fn an_unknown_provider_is_idle_rather_than_an_error() {
        let logins = ProviderLogins::new();
        assert_eq!(
            logins.phase("nowhere").into_body(),
            json!({ "ok": true, "phase": "idle" })
        );
    }

    /// A state is redeemable once, and taking it forgets who owned it.
    #[test]
    fn a_pending_sign_in_names_its_provider_exactly_once() {
        let logins = ProviderLogins::new();
        logins.remember(
            "vercel",
            PendingLogin {
                state: "st".into(),
                verifier: "v".into(),
                client_id: "c".into(),
                redirect_uri: "http://127.0.0.1:4317/cb".into(),
                authorize_url: "https://vercel.com/authorize".into(),
                created_at: nomoreide_core::providers::oauth::now_ms(),
            },
        );
        let (login, owner) = logins.take("st");
        assert_eq!(owner.as_deref(), Some("vercel"));
        assert_eq!(login.unwrap().verifier, "v");
        assert_eq!(logins.take("st").1, None);
    }
}
