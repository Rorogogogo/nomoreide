//! Linear: the connection, the browser sign-in, and the fixed GraphQL surface.
//!
//! **Two ways to connect, and they are not equivalent.** A personal API key is
//! pasted and never expires; an OAuth grant is consented to in a browser and
//! expires in a day. Both land in the same `connections["linear"]` entry, and
//! `source` is what tells them apart — which is the only thing
//! [`authorization_header`] needs to present each one the way Linear wants it.
//!
//! **The OAuth trio mirrors the deploy providers'** (`deploy_providers/oauth`)
//! and reuses its session store rather than growing a second one: `start` mints
//! the sign-in, `callback` is where Linear returns the browser, and `status` is
//! what the dashboard polls while that tab is open. `callback` answers HTML
//! because its reader is a browser tab, not the dashboard.
//!
//! **Refresh happens on the way into a request, not on a timer.** A Linear
//! access token lasts a day and this daemon may be asleep for most of it, so a
//! background renewal would be a task that mostly runs while nothing needs it.
//! [`authorized`] renews when the stored expiry has passed and writes back what
//! it gets — Linear rotates refresh tokens, so the answer replaces the one used.

use crate::server::routes::deploy_providers::oauth::{html, login_result_page, LoginPhase};
use crate::server::routes::query::query_value;
use crate::server::{app::AppState, errors::error};
use axum::{
    extract::State,
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Json, Router,
};
use nomoreide_core::providers::oauth::{
    begin_login, complete_login, now_ms, refresh_tokens, TOKEN_REFRESH_SKEW_MS,
};
use nomoreide_core::{
    config::ProviderConnectionDef,
    linear,
    linear_oauth::{self, authorization_header, linear_oauth},
    remote::protocol::linear::LinearRequest,
};
use serde::Deserialize;
use serde_json::json;

/// The key this provider's connection and its sign-in phase are both filed
/// under.
const PROVIDER: &str = "linear";

/// The callback, and nothing else.
///
/// **Outside the credential layer, and it has to be.** This route is loaded by
/// a browser that Linear redirected. A redirect carries no `Authorization`
/// header and there is no way to give it one — the daemon's credential is not
/// something a third party can be asked to forward — so mounting it with the
/// rest answers `401 Authentication required` and the code is never exchanged.
/// The same reason `agent_auth::public` exists.
///
/// **What guards it instead is `state`.** The callback exchanges nothing unless
/// its `state` matches a sign-in this daemon started and has not yet redeemed —
/// 128 bits minted per attempt, held in memory, and taken exactly once. A
/// request without one is a stale tab or a forgery, and is refused before any
/// code reaches Linear. That is the same defence the credential would have
/// provided here, and it is the one OAuth is designed around.
pub(super) fn public() -> Router<AppState> {
    Router::new().route("/api/linear/oauth/callback", any(oauth_callback))
}

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/linear/connection",
            get(connection).post(connect).delete(disconnect),
        )
        .route("/api/linear/request", post(execute))
        .route("/api/linear/oauth/start", any(oauth_start))
        .route("/api/linear/oauth/status", any(oauth_status))
}
/// Whether Linear is connected, how, and whether a browser sign-in is even on
/// offer here.
///
/// `oauthAvailable` is false on an install with no client id, and the dashboard
/// hides the button rather than offering one that could only fail — the same
/// gate GitHub's `deviceFlowAvailable` is.
async fn connection(State(state): State<AppState>) -> Response {
    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(_) => return refused("Could not read Linear connection"),
    };
    let stored = config.connections.get(PROVIDER);
    Json(json!({
        "ok": true,
        "connected": stored.is_some_and(|c| c.token.is_some()),
        "username": stored.and_then(|c| c.username.as_ref()),
        "source": stored.map(|c| c.source.clone()),
        "oauthAvailable": linear_oauth::available(),
    }))
    .into_response()
}
#[derive(Deserialize)]
struct Connect {
    token: String,
}
async fn connect(State(state): State<AppState>, Json(input): Json<Connect>) -> Response {
    let token = input.token.trim();
    if token.is_empty() || token.len() > 4096 {
        return refused("A Linear API key is required");
    }
    // A pasted key is a `stored` credential, so it is presented raw.
    let header = authorization_header("stored", token);
    let viewer = match linear::query(&header, "query { viewer { id name } }", json!({})).await {
        Ok(data) => data,
        Err(reason) => return refused(&reason),
    };
    let connection = ProviderConnectionDef {
        source: "stored".into(),
        token: Some(token.into()),
        username: viewer["viewer"]["name"].as_str().map(str::to_owned),
        ..Default::default()
    };
    match state
        .config_store
        .set_connection("linear", connection)
        .await
    {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(_) => refused("Could not save Linear connection"),
    }
}
async fn disconnect(State(state): State<AppState>) -> Response {
    match state.config_store.remove_connection(PROVIDER).await {
        Ok(_) => {
            // Without this, a disconnect after a failed sign-in leaves `status`
            // reporting that error forever, for an account no longer connected.
            state.provider_logins.forget(PROVIDER);
            Json(json!({"ok": true})).into_response()
        }
        Err(_) => refused("Could not remove Linear connection"),
    }
}
async fn execute(State(state): State<AppState>, Json(request): Json<LinearRequest>) -> Response {
    if let Err(reason) = request.validate() {
        return refused(reason);
    }
    let mut config = match state.config_store.load().await {
        Ok(config) => config,
        Err(_) => return refused("Could not read Linear connection"),
    };
    // Renewed here rather than on a timer, and *before* the borrow below: an
    // OAuth token lasts a day, and a refresh writes the config back.
    let header = match authorized(&state).await {
        Ok(header) => header,
        Err(reason) => return refused(&reason),
    };
    // Re-read, because a refresh above rewrote the file this was loaded from.
    if header.refreshed {
        config = match state.config_store.load().await {
            Ok(config) => config,
            Err(_) => return refused("Could not read Linear connection"),
        };
    }
    let header = header.value;
    let repository = config.selected_git_repository.clone().unwrap_or_default();
    if let LinearRequest::Binding { team, project } = &request {
        if repository.is_empty() {
            return refused("Select a repository before linking Linear");
        }
        let metadata = match linear::execute(&header, &LinearRequest::Metadata {}).await {
            Ok(data) => data,
            Err(reason) => return refused(&reason),
        };
        let selected = metadata["teams"]["nodes"]
            .as_array()
            .and_then(|teams| teams.iter().find(|t| t["id"].as_str() == Some(team)));
        let Some(selected) = selected else {
            return refused("Choose an accessible Linear team");
        };
        if project.as_ref().is_some_and(|p| {
            !selected["projects"]["nodes"]
                .as_array()
                .is_some_and(|ps| ps.iter().any(|v| v["id"].as_str() == Some(p)))
        }) {
            return refused("Project does not belong to this team");
        }
        let preferences = config.preferences.get_or_insert_with(|| json!({}));
        if !preferences.is_object() {
            return refused("Invalid repository preferences");
        }
        if !preferences["linearBindings"].is_object() {
            preferences["linearBindings"] = json!({});
        }
        preferences["linearBindings"][&repository] = json!({"team": team, "project": project});
        return match state.config_store.save(&config).await {
            Ok(_) => {
                Json(json!({"ok": true, "data": {"binding": {"team": team, "project": project}}}))
                    .into_response()
            }
            Err(_) => refused("Could not save Linear project link"),
        };
    }
    match linear::execute(&header, &request).await {
        Ok(mut data) => {
            if matches!(request, LinearRequest::Metadata {}) {
                data["binding"] = config
                    .preferences
                    .as_ref()
                    .map(|p| p["linearBindings"][&repository].clone())
                    .unwrap_or(serde_json::Value::Null);
            }
            Json(json!({"ok": true, "data": data})).into_response()
        }
        Err(reason) => refused(&reason),
    }
}
fn refused(reason: &str) -> Response {
    error(StatusCode::BAD_REQUEST, reason)
}

// ---------------------------------------------------------------------------
// The credential, renewed on the way in
// ---------------------------------------------------------------------------

/// A ready-to-send `Authorization` value, and whether producing it rewrote the
/// stored connection.
///
/// The flag is not bookkeeping: a caller holding a `Config` loaded before the
/// refresh is holding a stale one, and the only honest thing to do is say so.
struct Authorized {
    value: String,
    refreshed: bool,
}

/// The header Linear wants for whatever credential this machine holds,
/// renewing an expired OAuth token first.
///
/// An API key never expires and never reaches the refresh path. An OAuth grant
/// with no refresh token cannot be renewed at all — Linear always issues one,
/// so this is the shape of a connection written by an older build, and the
/// honest answer is to ask for a reconnect rather than send a token that will
/// be refused.
async fn authorized(state: &AppState) -> Result<Authorized, String> {
    let config = state
        .config_store
        .load()
        .await
        .map_err(|_| "Could not read Linear connection".to_string())?;
    let connection = config
        .connections
        .get(PROVIDER)
        .ok_or("Connect Linear on the host to use tasks")?;
    let token = connection
        .token
        .as_deref()
        .ok_or("Connect Linear on the host to use tasks")?;

    let expired = connection.source == "oauth"
        && connection
            .expires_at
            // Renewed a little early, so a call never starts with a token that
            // expires while it is in flight.
            .is_some_and(|at| now_ms() + TOKEN_REFRESH_SKEW_MS >= at);
    if !expired {
        return Ok(Authorized {
            value: authorization_header(&connection.source, token),
            refreshed: false,
        });
    }

    let (Some(refresh), Some(client_id)) = (
        connection.refresh_token.as_deref(),
        connection.client_id.as_deref(),
    ) else {
        return Err("Your Linear sign-in expired. Connect Linear again.".into());
    };
    let tokens = refresh_tokens(&linear_oauth(), client_id, refresh)
        .await
        .map_err(|_| "Your Linear sign-in expired. Connect Linear again.".to_string())?;

    let renewed = ProviderConnectionDef {
        source: "oauth".into(),
        token: Some(tokens.access_token.clone()),
        // Linear rotates on use, so what came back replaces what went in. A
        // provider that returned none leaves the old one in place rather than
        // dropping the only way to renew again.
        refresh_token: tokens
            .refresh_token
            .or_else(|| connection.refresh_token.clone()),
        expires_at: Some(tokens.expires_at),
        client_id: Some(client_id.to_string()),
        username: connection.username.clone(),
        ..ProviderConnectionDef::default()
    };
    state
        .config_store
        .set_connection(PROVIDER, renewed)
        .await
        .map_err(|_| "Could not save the renewed Linear connection".to_string())?;

    Ok(Authorized {
        value: authorization_header("oauth", &tokens.access_token),
        refreshed: true,
    })
}

// ---------------------------------------------------------------------------
// Browser sign-in
// ---------------------------------------------------------------------------

/// Mints a sign-in and hands back the URL the dashboard must open.
async fn oauth_start(State(state): State<AppState>, method: Method) -> Response {
    if method != Method::POST {
        return crate::server::errors::method_not_allowed().await;
    }
    if !linear_oauth::available() {
        return refused(
            "This build has no Linear OAuth app configured. Set NOMOREIDE_LINEAR_CLIENT_ID, or connect with an API key.",
        );
    }

    let spec = linear_oauth();
    // Fixed, not derived from the request's Host: Linear matches a redirect
    // against a list somebody typed into a form, so it has to be the one string
    // that is registered there.
    let pending = match begin_login(&spec, linear_oauth::REDIRECT_URI).await {
        Ok(pending) => pending,
        Err(message) => {
            state
                .provider_logins
                .set_phase(PROVIDER, LoginPhase::Error(message.clone()));
            return error(StatusCode::INTERNAL_SERVER_ERROR, &message);
        }
    };

    let url = pending.authorize_url.clone();
    state.provider_logins.remember(PROVIDER, pending);
    state
        .provider_logins
        .set_phase(PROVIDER, LoginPhase::Pending);
    Json(json!({ "ok": true, "url": url })).into_response()
}

/// Where Linear returns the browser.
///
/// Answers a page rather than JSON, because its reader is the tab Linear
/// redirected — the dashboard learns the outcome from `oauth_status`.
async fn oauth_callback(State(state): State<AppState>, uri: axum::http::Uri) -> Response {
    let logins = state.provider_logins.clone();
    let fail = |message: String| -> Response {
        logins.set_phase(PROVIDER, LoginPhase::Error(message.clone()));
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

    // An unknown `state` means this callback matches no sign-in this daemon
    // started — a stale tab, or a forged request. Either way, no exchange.
    let (pending, _) = match query_value(&uri, "state").as_deref() {
        Some(value) => logins.take(value),
        None => (None, None),
    };
    let (Some(code), Some(pending)) = (query_value(&uri, "code"), pending) else {
        return fail(
            "This sign-in link has expired. Start the sign-in again from NoMoreIDE.".to_string(),
        );
    };

    let spec = linear_oauth();
    let tokens = match complete_login(&spec, &pending, &code).await {
        Ok(tokens) => tokens,
        Err(message) => return fail(message),
    };

    // Who it belongs to, so the panel can name the account. A viewer lookup
    // that fails is not a failed sign-in — the grant is good and the name is
    // decoration, so it is left unset rather than losing the connection.
    let header = authorization_header("oauth", &tokens.access_token);
    let username = linear::query(&header, "query { viewer { id name } }", json!({}))
        .await
        .ok()
        .and_then(|data| data["viewer"]["name"].as_str().map(str::to_owned));

    let connection = ProviderConnectionDef {
        source: "oauth".into(),
        token: Some(tokens.access_token),
        refresh_token: tokens.refresh_token,
        expires_at: Some(tokens.expires_at),
        client_id: Some(pending.client_id),
        username,
        ..ProviderConnectionDef::default()
    };
    if let Err(failure) = state
        .config_store
        .set_connection(PROVIDER, connection)
        .await
    {
        return fail(failure.to_string());
    }

    logins.set_phase(PROVIDER, LoginPhase::Connected);
    html(
        StatusCode::OK,
        &login_result_page(
            "Connected to Linear",
            "You can close this tab and return to NoMoreIDE.",
        ),
    )
}

/// What the dashboard polls while the browser tab is open. Never fails: a
/// machine that has started no sign-in is simply `idle`.
async fn oauth_status(State(state): State<AppState>) -> Response {
    Json(state.provider_logins.phase(PROVIDER).into_body()).into_response()
}
