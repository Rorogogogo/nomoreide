//! Host-provider visibility and controls: who you are signed in as, what
//! machines the account owns, and the one door that powers one on or off.
//!
//! The Rust half of `src/web/routes/host-routes.ts`. Nothing here names Vultr —
//! the id is a path segment and the client comes from the registry — so a
//! second host provider adds no route.
//!
//! **Separate from `deploy_providers.rs` rather than merged with it**, for the
//! reason the reference gives: the two contracts disagree about almost every
//! path. A deploy route is scoped to the selected repository's project; a host
//! route is scoped to nothing but the account. The one thing they genuinely
//! share is connecting a credential, which is a form read and a store write,
//! and hoisting that into a helper would couple two route families to save less
//! than it cost.
//!
//! **The failure statuses differ per route, and each follows from where the
//! reference's `try` starts:**
//!
//! - `status` reports a *connected* provider's refusal as a **200** carrying a
//!   status field, because the panel it feeds has a screen for "signed out" and
//!   none for a failed fetch. Only an id no provider claims is a **404** — and
//!   that is a 404 where the deploy side's `connect` answers 400, because these
//!   are two different `try` blocks and not one shared rule.
//! - `connect` answers **400** for everything: all of it is the caller's doing.
//! - the instance reads answer **500** for everything, the unknown provider
//!   included.
//! - the action route answers **404** for a name the manifest does not declare
//!   and **400** for everything else.
//!
//! **Every write invalidates the SSH target cache**, because these machines
//! also reach the user through `/api/servers` — a rebooted instance that keeps
//! reporting "running" there for the next minute is the cache, not the vendor.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use nomoreide_core::config::ProviderConnectionDef;
use nomoreide_core::providers::registry::{
    host_cli_missing, host_cli_session, host_cli_status, host_provider_manifests,
    public_provider_connection, require_host_actions, require_host_context, require_host_provider,
    HostClient,
};
use nomoreide_core::ssh_servers::invalidate_host_ssh_targets;
use serde_json::{json, Map, Value};

use crate::server::app::AppState;
use crate::server::body::{decode_uri_component, parse_form};
use crate::server::errors::{error, method_not_allowed};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/hosts", get(providers))
        // `any()` with an explicit match, not `get()`/`post()`: the reference's
        // pattern routes decide their own verb handling, and a router that
        // answered 405 where they answer something else would diverge.
        .route("/api/hosts/:provider/status", any(status))
        .route("/api/hosts/:provider/connect", any(connect))
        .route("/api/hosts/:provider/instances", any(instances))
        // Static before dynamic: `:action` must not swallow a bare instance id.
        .route(
            "/api/hosts/:provider/instances/:instance/:action",
            any(run_action),
        )
        .route("/api/hosts/:provider/instances/:instance", any(instance))
}

fn ok() -> Response {
    Json(json!({ "ok": true })).into_response()
}

/// The registry itself — what the dashboard renders a tab for.
async fn providers() -> Response {
    Json(json!({ "ok": true, "providers": host_provider_manifests() })).into_response()
}

/// Everything the connection panel opens with: who the credential belongs to,
/// and whether there is one at all.
///
/// **A refusal from a connected provider is a 200 here**, carrying the state in
/// `status` alongside the manifest the panel needs to render itself either way.
/// Only an id no provider claims is a 404.
async fn status(State(state): State<AppState>, Path(provider): Path<String>) -> Response {
    let manifest = match require_host_provider(&provider) {
        Ok(manifest) => manifest,
        Err(message) => return error(StatusCode::NOT_FOUND, &message),
    };
    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(failure) => return error(StatusCode::NOT_FOUND, &failure.to_string()),
    };
    let cli = host_cli_status(&provider);
    let connection = public_provider_connection(&config, &provider);

    let mut base = Map::new();
    base.insert("ok".into(), Value::Bool(true));
    base.insert("provider".into(), manifest);
    if let Some(connection) = connection.clone() {
        base.insert("connection".into(), connection);
    }
    base.insert("cliAvailable".into(), Value::Bool(cli.available));
    if let Some(cli_error) = cli.error.as_ref() {
        base.insert("cliError".into(), Value::String(cli_error.clone()));
    }

    if connection.is_none() && !cli.available {
        base.insert("status".into(), Value::String("not_configured".into()));
        return Json(Value::Object(base)).into_response();
    }

    let client = match require_host_context(&provider, &state.config_store, &config) {
        Ok(client) => client,
        Err(message) => return unreachable_provider(base, false, message),
    };
    match client.account().await {
        Ok(account) => connected_panel(base, connection.is_none(), account),
        Err(failure) => unreachable_provider(base, failure.is_auth(), failure.message),
    }
}

/// The panel for a credential that answered.
fn connected_panel(
    mut base: Map<String, Value>,
    ambient: bool,
    account: nomoreide_core::providers::registry::HostAccount,
) -> Response {
    // An ambient credential is enough to work: a user who never opened this tab
    // still gets a connected dashboard rather than a setup screen.
    if ambient {
        base.insert("connection".into(), json!({ "source": "cli" }));
    }
    base.insert("status".into(), Value::String("connected".into()));
    let mut user = Map::new();
    if let Some(username) = account.username {
        user.insert("username".into(), username);
    }
    if let Some(avatar) = account.avatar {
        user.insert("avatar".into(), avatar);
    }
    base.insert("user".into(), Value::Object(user));
    Json(Value::Object(base)).into_response()
}

/// A provider that is configured but did not answer, reported as the state it
/// is in rather than as a failed request — so the panel offers reconnect for an
/// expired credential and retry for everything else.
fn unreachable_provider(mut base: Map<String, Value>, auth: bool, message: String) -> Response {
    base.insert(
        "status".into(),
        Value::String(
            if auth {
                "auth_error"
            } else {
                "connection_error"
            }
            .into(),
        ),
    );
    base.insert("error".into(), Value::String(message));
    Json(Value::Object(base)).into_response()
}

/// Save a credential (`POST`) or forget one (`DELETE`).
///
/// The two sources differ in what is stored, and the difference is the policy:
/// a pasted token is written to config, while `cli` stores **only the scope**
/// and re-reads the token from the vendor CLI's own file at use time — so a
/// vendor logout revokes our access too.
async fn connect(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    method: Method,
    body: Bytes,
) -> Response {
    // Before the verb check, so a GET to an unknown provider names the provider
    // rather than the method — the reference's lookup opens its `try` and its
    // verb check is inside it.
    if let Err(message) = require_host_provider(&provider) {
        return error(StatusCode::BAD_REQUEST, &message);
    }

    if method == Method::DELETE {
        return match state.config_store.remove_connection(&provider).await {
            Ok(_) => {
                invalidate_host_ssh_targets();
                ok()
            }
            Err(failure) => error(StatusCode::BAD_REQUEST, &failure.to_string()),
        };
    }
    if method != Method::POST {
        return method_not_allowed().await;
    }

    let form = parse_form(&body);
    let connection = if form.get("source").map(|source| source.trim()) == Some("cli") {
        let Some(session) = host_cli_session(&provider) else {
            return error(
                StatusCode::BAD_REQUEST,
                host_cli_missing(&provider).unwrap_or_default(),
            );
        };
        ProviderConnectionDef {
            source: "cli".into(),
            scope_id: session.current_scope,
            ..ProviderConnectionDef::default()
        }
    } else {
        let token = form
            .get("token")
            .map(|token| token.trim())
            .filter(|token| !token.is_empty());
        let Some(token) = token else {
            return error(StatusCode::BAD_REQUEST, "token is required");
        };
        ProviderConnectionDef {
            source: "stored".into(),
            token: Some(token.to_string()),
            ..ProviderConnectionDef::default()
        }
    };

    match state
        .config_store
        .set_connection(&provider, connection)
        .await
    {
        Ok(_) => {
            // The servers list is about to show a different set of machines.
            invalidate_host_ssh_targets();
            ok()
        }
        Err(failure) => error(StatusCode::BAD_REQUEST, &failure.to_string()),
    }
}

/// Every machine the account owns.
async fn instances(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    method: Method,
) -> Response {
    if method != Method::GET {
        return method_not_allowed().await;
    }
    let client = match host_client(&state, &provider).await {
        Ok(client) => client,
        Err(response) => return response,
    };
    match client.list_instances().await {
        Ok(instances) => Json(json!({ "ok": true, "instances": instances })).into_response(),
        Err(failure) => error(StatusCode::INTERNAL_SERVER_ERROR, &failure.message),
    }
}

/// One machine on its own.
async fn instance(
    State(state): State<AppState>,
    Path((provider, _instance)): Path<(String, String)>,
    method: Method,
    uri: Uri,
) -> Response {
    if method != Method::GET {
        return method_not_allowed().await;
    }
    let client = match host_client(&state, &provider).await {
        Ok(client) => client,
        Err(response) => return response,
    };
    // The reference decodes inside its `try`, so an id that will not
    // percent-decode is a 500 like a vendor refusal rather than a 400 about the
    // escape.
    let Some(id) = decode_uri_component(raw_segment(&uri, 5)) else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "URI malformed");
    };
    match client.get_instance(&id).await {
        Ok(instance) => Json(json!({ "ok": true, "instance": instance })).into_response(),
        Err(failure) => error(StatusCode::INTERNAL_SERVER_ERROR, &failure.message),
    }
}

/// **The write boundary's single door.** Every power operation arrives here,
/// POST-only and named in the path, so there is one place to audit what a
/// provider can change and one place a guard would go.
///
/// Which names are legal comes from the manifest, not from this file — an
/// action a provider does not declare is a **404** naming it, before any
/// credential is resolved. That matters more here than on the deploy side:
/// Vultr serves `destroy` and `reinstall` endpoints this codebase deliberately
/// does not implement, and the manifest check is the first of the two doors
/// keeping a request away from them.
async fn run_action(
    State(state): State<AppState>,
    Path((provider, _instance, _action)): Path<(String, String, String)>,
    method: Method,
    uri: Uri,
) -> Response {
    if method != Method::POST {
        return method_not_allowed().await;
    }
    let refusal = StatusCode::BAD_REQUEST;
    let manifest = match require_host_provider(&provider) {
        Ok(manifest) => manifest,
        Err(message) => return error(refusal, &message),
    };
    // Read raw: the reference never decodes the action, so an escaped spelling
    // is a name no provider declares rather than the action it spells.
    let action = raw_segment(&uri, 6);
    if !declares_action(&manifest, action) {
        let name = manifest
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&provider);
        return error(
            StatusCode::NOT_FOUND,
            &format!("{name} has no action \"{action}\"."),
        );
    }

    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(failure) => return error(refusal, &failure.to_string()),
    };
    let actions = match require_host_actions(&provider, &state.config_store, &config) {
        Ok(actions) => actions,
        Err(message) => return error(refusal, &message),
    };
    let Some(instance_id) = decode_uri_component(raw_segment(&uri, 5)) else {
        return error(refusal, "URI malformed");
    };

    match actions.run(action, &instance_id).await {
        Ok(()) => {
            // The instance's state just changed, and it is on the servers list.
            invalidate_host_ssh_targets();
            ok()
        }
        Err(failure) => error(refusal, &failure.message),
    }
}

/// The read-safe client for `provider`, or the 500 both instance reads answer.
async fn host_client(state: &AppState, provider: &str) -> Result<HostClient, Response> {
    let refusal = StatusCode::INTERNAL_SERVER_ERROR;
    let config = state
        .config_store
        .load()
        .await
        .map_err(|failure| error(refusal, &failure.to_string()))?;
    require_host_context(provider, &state.config_store, &config)
        .map_err(|message| error(refusal, &message))
}

/// Whether the provider's manifest lists this action name.
fn declares_action(manifest: &Value, action: &str) -> bool {
    manifest
        .get("actions")
        .and_then(Value::as_array)
        .is_some_and(|actions| actions.iter().any(|name| name == action))
}

/// The nth `/`-separated piece of the path, counting the empty piece before the
/// leading slash as zero — so `/api/hosts/<id>/instances/<instance>` puts the
/// provider at 3 and the instance at 5.
///
/// Read raw rather than through `Path`, because axum decodes a parameter while
/// the reference calls `decodeURIComponent`, which *throws* on a broken escape
/// instead of passing it through.
fn raw_segment(uri: &Uri, index: usize) -> &str {
    uri.path().split('/').nth(index).unwrap_or_default()
}
