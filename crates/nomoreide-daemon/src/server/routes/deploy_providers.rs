//! The deploy provider's dashboard surface: who you are signed in as, which
//! account you are acting as, which project this repository deploys, and what
//! it has deployed.
//!
//! The Rust half of `src/web/routes/provider-routes.ts`, minus `env`,
//! `domains`, the OAuth pair, and the write actions. Nothing here names Vercel
//! or Cloudflare — the id is a path segment and the client comes from the
//! registry — so a third provider adds no route.
//!
//! **Every route answers failure differently, and none of it is a house
//! style.** Each follows from where the reference's `try` starts, and the
//! dashboard is the reference's dashboard:
//!
//! - `status` reports a *connected* provider's refusal as a **200** carrying a
//!   status field, because the connection panel it feeds has a screen for
//!   "signed out" and none for a failed fetch. Only an id no provider claims
//!   is a 404.
//! - `projects` and `deployments` answer **500** for everything — an unknown
//!   provider, one that is not connected, a vendor that refused. Giving the
//!   unknown provider a 404 there would be more tasteful and would diverge.
//! - `connect` and `scope` answer **400** for everything, because everything
//!   they can refuse is the caller's doing.
//! - `project` answers **400** on the way in and **500** on the way out: a
//!   rejected write is the caller's problem and a failed read is not.
//!
//! **A missing project is not a failure.** `deployments` answers 200 with an
//! empty list and an explicit `project: null`, because the dashboard's job in
//! that state is to help the user link one, and an error would render as a
//! broken panel instead.
//!
//! **Where the method check sits is observable.** `connect` looks the provider
//! up *before* checking the verb, so a GET to an unknown provider is a 400
//! naming the provider rather than a 405; `scope` checks the verb first, so
//! the same request there is a 405; `status` checks no verb at all. That is
//! why every route below is `any()` with an explicit match rather than
//! `get()`/`post()` — the router would answer 405 in places the reference does
//! not.
//!
//! The OAuth pair is deliberately still the reference's. It holds a login
//! session in memory across two unrelated requests and serves an HTML page to
//! a browser tab, which is its own slice rather than a detail of these — and
//! being stateful, it belongs in a `deploy_providers/` submodule of its own
//! when it lands, the way `github/api.rs` sits under `github.rs`.

use crate::server::app::AppState;
use crate::server::body::{decode_uri_component, parse_form, read_json_object, string_field};
use crate::server::errors::{error, method_not_allowed};
use crate::server::routes::query::query_value;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::{Json, Router};
use nomoreide_core::config::{selected_git_repository, ProviderConnectionDef};
use nomoreide_core::providers::deploy::ProviderProject;
use nomoreide_core::providers::registry::{
    cli_missing, provider_cli_session, provider_cli_status, public_provider_connection,
    require_deploy_provider, require_provider_actions, require_provider_context, DeployActions,
    ProviderAccount, ProviderContext,
};
use serde_json::{json, Map, Value};

/// The most deployments one request will return, however large a `limit` asks
/// for.
const MAX_DEPLOYMENTS: u32 = 100;

/// What both vendors' managers fall back to when the caller names no limit.
/// Spelled here because the route has to send *something*, and sending a
/// different number would be a divergence nobody reading the route would see.
const DEFAULT_DEPLOYMENTS: u32 = 20;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        // The reference's pattern routes do not guard the verb for these
        // reads. Keeping that observable behavior matters until the reference
        // and native route can tighten it together.
        .route("/api/providers/:provider/status", any(status))
        .route("/api/providers/:provider/connect", any(connect))
        .route("/api/providers/:provider/scope", any(scope))
        .route("/api/providers/:provider/project", any(project))
        .route("/api/providers/:provider/env", any(env))
        .route("/api/providers/:provider/env/:env/reveal", any(reveal_env))
        .route("/api/providers/:provider/env/:env", any(change_env))
        .route("/api/providers/:provider/domains", any(domains))
        .route("/api/providers/:provider/projects", any(projects))
        .route("/api/providers/:provider/deployments", any(deployments))
}

fn ok() -> Response {
    Json(json!({ "ok": true })).into_response()
}

/// Everything the connection panel opens with: who the user is signed in as,
/// which scopes they can switch to, and whether the repository has a project.
///
/// **A refusal from a connected provider is a 200 here.** The panel's job in
/// that state is to say "your sign-in expired, reconnect" — which is a screen,
/// not an error toast — so the failure travels in `status` alongside the
/// manifest the panel needs to render itself either way. Only an id no
/// provider claims is a 404, and only because the reference's `try` closes
/// around the lookup.
async fn status(State(state): State<AppState>, Path(provider): Path<String>) -> Response {
    let manifest = match require_deploy_provider(&provider) {
        Ok(manifest) => manifest,
        Err(message) => return error(StatusCode::NOT_FOUND, &message),
    };
    // A config that will not load is reported as 404 too. That is the
    // reference's outer `catch`, which does not distinguish what threw — and
    // the panel reads the message, not the status.
    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(failure) => return error(StatusCode::NOT_FOUND, &failure.to_string()),
    };

    let cli = provider_cli_status(&provider).await;
    let mut base = Map::new();
    base.insert("ok".into(), Value::Bool(true));
    base.insert("provider".into(), manifest);
    let connection = public_provider_connection(&config, &provider);
    if let Some(connection) = connection.clone() {
        base.insert("connection".into(), connection);
    }
    base.insert("cliAvailable".into(), Value::Bool(cli.available));
    if let Some(cli_error) = cli.error {
        base.insert("cliError".into(), Value::String(cli_error));
    }
    if let Some(repository) = selected_git_repository(&config) {
        base.insert(
            "repositoryName".into(),
            Value::String(repository.name.clone()),
        );
    }

    if connection.is_none() && !cli.available {
        base.insert("status".into(), Value::String("not_configured".into()));
        return Json(Value::Object(base)).into_response();
    }

    let cwd = state.workspace_cwd().await;
    let context =
        match require_provider_context(&provider, &state.config_store, &config, &cwd).await {
            Ok(context) => context,
            // Nothing reached the vendor, so there is no status to read: an
            // unresolvable credential is a connection problem, not a rejected
            // one.
            Err(message) => return unreachable_provider(base, false, message),
        };

    // Both reads are started together, as the reference's `Promise.all` does.
    // The scope list is the *optional* half — a token that may read projects
    // but not the account list still gives a working dashboard, just without
    // the switcher — so its failure is swallowed where the account's is not.
    let (account, scopes) = tokio::join!(context.client.account(), context.client.list_scopes());
    match account {
        Ok(account) => connected_panel(
            base,
            connection,
            &context,
            account,
            scopes.unwrap_or_default(),
        ),
        Err(failure) => unreachable_provider(base, failure.is_auth(), failure.message),
    }
}

/// A provider that answered: who you are signed in as, what you can switch to,
/// and what this repository deploys.
fn connected_panel(
    mut base: Map<String, Value>,
    connection: Option<Value>,
    context: &ProviderContext,
    account: ProviderAccount,
    scopes: Vec<Value>,
) -> Response {
    base.insert(
        "connection".into(),
        // A CLI login is enough to work: someone who never opened this tab
        // gets a connected dashboard rather than a setup screen.
        connection.unwrap_or_else(|| json!({ "source": "cli" })),
    );
    base.insert(
        "status".into(),
        Value::String(
            if context.project.is_some() {
                "connected"
            } else {
                "no_project"
            }
            .into(),
        ),
    );
    // Only the two fields the panel shows, and each only when the vendor had
    // one — an absent key and a null are different answers here.
    let mut user = Map::new();
    if let Some(username) = account.username {
        user.insert("username".into(), username);
    }
    if let Some(avatar) = account.avatar {
        user.insert("avatar".into(), avatar);
    }
    base.insert("user".into(), Value::Object(user));
    base.insert("scopes".into(), json!(scopes));
    if let Some(project) = context.project.as_ref() {
        base.insert("project".into(), json!(project));
    }
    // The scope actually in force, which is not always the stored one: an
    // unscoped connection adopts the sole team or account it can see.
    if let Some(scope_id) = context.credential.scope_id.as_ref() {
        base.insert("scopeId".into(), Value::String(scope_id.clone()));
    }
    Json(Value::Object(base)).into_response()
}

/// A provider that is configured but did not answer, reported as the state it
/// is in rather than as a failed request.
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

/// Save a connection (`POST`) or forget one (`DELETE`).
///
/// The two sources differ in what is stored, and the difference is the policy:
/// a pasted token is written to config, while `cli` stores **only the scope**
/// and re-reads the token from the vendor CLI's own auth file at use time — so
/// `vercel logout` and `wrangler logout` revoke our access too.
async fn connect(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    method: Method,
    body: Bytes,
) -> Response {
    // Before the verb check, so a GET to an unknown provider names the
    // provider rather than the method. The reference's lookup opens its `try`
    // and its verb check is inside it.
    if let Err(message) = require_deploy_provider(&provider) {
        return error(StatusCode::BAD_REQUEST, &message);
    }

    if method == Method::DELETE {
        return match state.config_store.remove_connection(&provider).await {
            Ok(_) => ok(),
            Err(failure) => error(StatusCode::BAD_REQUEST, &failure.to_string()),
        };
    }
    if method != Method::POST {
        return method_not_allowed().await;
    }

    let form = parse_form(&body);
    let connection = if form.get("source").map(|source| source.trim()) == Some("cli") {
        let Some(session) = provider_cli_session(&provider).await else {
            return error(
                StatusCode::BAD_REQUEST,
                cli_missing(&provider).unwrap_or_default(),
            );
        };
        ProviderConnectionDef {
            source: "cli".into(),
            scope_id: session.current_scope,
            ..empty_connection()
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
            ..empty_connection()
        }
    };

    match state
        .config_store
        .set_connection(&provider, connection)
        .await
    {
        Ok(_) => ok(),
        Err(failure) => error(StatusCode::BAD_REQUEST, &failure.to_string()),
    }
}

/// Every field a connection can carry, empty. Spelled once so the two branches
/// above name only what they actually set — and so a field added to the stored
/// shape cannot silently arrive here carrying a stale value.
fn empty_connection() -> ProviderConnectionDef {
    ProviderConnectionDef {
        source: String::new(),
        token: None,
        refresh_token: None,
        expires_at: None,
        client_id: None,
        scope_id: None,
        scope_slug: None,
        username: None,
        legacy_team_id: None,
        legacy_team_slug: None,
    }
}

/// Point an existing connection at a different team or account.
///
/// The verb is checked *before* the provider, which is the opposite of
/// `connect` above and is what the reference does: its method guard sits
/// outside the `try` that holds the lookup.
async fn scope(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    method: Method,
    body: Bytes,
) -> Response {
    if method != Method::PUT {
        return method_not_allowed().await;
    }
    if let Err(message) = require_deploy_provider(&provider) {
        return error(StatusCode::BAD_REQUEST, &message);
    }
    // A non-string field is no field: the reference reads `typeof === "string"`
    // and passes `undefined` otherwise, which clears the scope rather than
    // storing a number. The store then trims what is left.
    let payload = read_json_object(&body);
    match state
        .config_store
        .set_connection_scope(
            &provider,
            string_field(&payload, "scopeId").map(str::to_string),
            string_field(&payload, "scopeSlug").map(str::to_string),
        )
        .await
    {
        Ok(_) => ok(),
        Err(failure) => error(StatusCode::BAD_REQUEST, &failure.to_string()),
    }
}

/// `GET` reads the linked project in full; `PUT` pins one, or clears the pin
/// when `projectId` is absent or empty.
///
/// The read is not the project `status` already carries. That one may have
/// come from a *listing*, and Vercel's listing omits the build settings — so
/// this always reads the single-project endpoint, which is what the settings
/// panel is there to show.
async fn project(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    method: Method,
    body: Bytes,
) -> Response {
    // A rejected write is the caller's problem; a failed read is not. The
    // reference picks its status from the verb in one place, at the end, so
    // every refusal below — the provider lookup included — follows the verb
    // rather than what went wrong.
    let refusal = if method == Method::PUT {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    if let Err(message) = require_deploy_provider(&provider) {
        return error(refusal, &message);
    }

    if method == Method::PUT {
        let payload = read_json_object(&body);
        let config = match state.config_store.load().await {
            Ok(config) => config,
            Err(failure) => return error(refusal, &failure.to_string()),
        };
        let Some(repository) = selected_git_repository(&config) else {
            return error(refusal, "No Git repository is selected.");
        };
        let repository = repository.name.clone();
        return match state
            .config_store
            .set_provider_project(
                &provider,
                &repository,
                string_field(&payload, "projectId").map(str::to_string),
            )
            .await
        {
            Ok(_) => ok(),
            Err(failure) => error(refusal, &failure.to_string()),
        };
    }
    if method != Method::GET {
        return method_not_allowed().await;
    }

    let context = match context(&state, &provider).await {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(linked) = context
        .project
        .as_ref()
        .and_then(ProviderProject::identifier)
    else {
        return error(refusal, "No project is linked to this repository.");
    };
    match context.client.get_project(linked).await {
        Ok(project) => Json(json!({ "ok": true, "project": project })).into_response(),
        Err(failure) => error(refusal, &failure.message),
    }
}

async fn context(state: &AppState, provider: &str) -> Result<ProviderContext, Response> {
    provider_context(state, provider)
        .await
        .map_err(|failure| error(StatusCode::INTERNAL_SERVER_ERROR, &failure))
}

/// The same, leaving the status to the caller — the env routes answer 400 or
/// 500 for the *same* unresolved provider depending on the verb, so they
/// cannot use the 500 above.
async fn provider_context(state: &AppState, provider: &str) -> Result<ProviderContext, String> {
    let config = state
        .config_store
        .load()
        .await
        .map_err(|failure| failure.to_string())?;
    let cwd = state.workspace_cwd().await;
    require_provider_context(provider, &state.config_store, &config, &cwd).await
}

/// The linked project, or the sentence the routes report when there is none.
fn require_project(context: &ProviderContext) -> Result<&str, String> {
    context
        .project
        .as_ref()
        .and_then(ProviderProject::identifier)
        .ok_or_else(|| "No project is linked to this repository.".to_string())
}

/// The write-capable client, resolved separately from the read context on
/// purpose — see [`require_provider_actions`].
async fn actions(state: &AppState, provider: &str) -> Result<DeployActions, String> {
    let config = state
        .config_store
        .load()
        .await
        .map_err(|failure| failure.to_string())?;
    require_provider_actions(provider, &state.config_store, &config).await
}

/// The `env` path segment as it was written, before percent-decoding.
///
/// Axum hands back a decoded parameter, but the reference decodes with
/// `decodeURIComponent`, which *throws* on a broken escape rather than passing
/// it through — and that throw is a 400 the caller sees. Reading the raw
/// segment back off the URI is what keeps that difference.
fn raw_env_segment(uri: &Uri) -> &str {
    uri.path().split('/').nth(5).unwrap_or_default()
}

/// `GET` lists the project's variables; `POST` adds one.
///
/// **The context is resolved before the verb is checked**, which is the
/// reference's order and is observable: a `PUT` here reaches the vendor to
/// resolve the project and *then* answers 405, while a `PUT` to a provider
/// that will not connect answers 400 instead. Both fall out of the reference's
/// `try` opening before its method guard.
async fn env(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    method: Method,
    body: Bytes,
) -> Response {
    // A failed read is a server-side problem; a rejected write is the
    // caller's. The split the routes this replaced drew too.
    let refusal = if method == Method::GET {
        StatusCode::INTERNAL_SERVER_ERROR
    } else {
        StatusCode::BAD_REQUEST
    };
    if let Err(message) = require_deploy_provider(&provider) {
        return error(refusal, &message);
    }
    let context = match provider_context(&state, &provider).await {
        Ok(context) => context,
        Err(message) => return error(refusal, &message),
    };

    if method == Method::GET {
        let project = match require_project(&context) {
            Ok(project) => project,
            Err(message) => return error(refusal, &message),
        };
        return match context.client.list_env(project).await {
            Ok(env) => Json(json!({ "ok": true, "env": env })).into_response(),
            Err(failure) => error(refusal, &failure.message),
        };
    }
    if method != Method::POST {
        return method_not_allowed().await;
    }

    let payload = read_json_object(&body);
    let actions = match actions(&state, &provider).await {
        Ok(actions) => actions,
        Err(message) => return error(refusal, &message),
    };
    let project = match require_project(&context) {
        Ok(project) => project.to_string(),
        Err(message) => return error(refusal, &message),
    };
    let key = string_field(&payload, "key").unwrap_or_default().trim();
    let environments = string_list(&payload, "environments");
    if key.is_empty() {
        return error(refusal, "A key is required.");
    }
    if environments.is_empty() {
        return error(refusal, "Choose at least one environment.");
    }
    match actions
        .create_env(
            &project,
            key,
            string_field(&payload, "value").unwrap_or_default(),
            &environments,
            // Anything that is not the word `plain` is a secret. The default
            // is the one whose value does not read back.
            if string_field(&payload, "type") == Some("plain") {
                "plain"
            } else {
                "encrypted"
            },
        )
        .await
    {
        Ok(env) => Json(json!({ "ok": true, "env": env })).into_response(),
        Err(failure) => error(refusal, &failure.message),
    }
}

/// Reveal one variable's value.
///
/// `POST` rather than `GET`, and one key at a time, so putting a secret on the
/// wire is always a deliberate act that leaves a request behind — the same
/// reasoning that keeps the database's write half off the agent surface. This
/// route has no MCP tool for that reason.
async fn reveal_env(
    State(state): State<AppState>,
    Path((provider, _env)): Path<(String, String)>,
    method: Method,
    uri: Uri,
) -> Response {
    // The verb is checked before anything else here, unlike `env` above.
    if method != Method::POST {
        return method_not_allowed().await;
    }
    let refusal = StatusCode::BAD_REQUEST;
    if let Err(message) = require_deploy_provider(&provider) {
        return error(refusal, &message);
    }
    let context = match provider_context(&state, &provider).await {
        Ok(context) => context,
        Err(message) => return error(refusal, &message),
    };
    let project = match require_project(&context) {
        Ok(project) => project,
        Err(message) => return error(refusal, &message),
    };
    let Some(env_id) = decode_uri_component(raw_env_segment(&uri)) else {
        return error(refusal, "URI malformed");
    };
    match context.client.get_env_value(project, &env_id).await {
        Ok(value) => Json(json!({ "ok": true, "value": value })).into_response(),
        Err(failure) => error(refusal, &failure.message),
    }
}

/// Update (`PATCH`) or delete (`DELETE`) one variable. The same write boundary
/// as adding one.
async fn change_env(
    State(state): State<AppState>,
    Path((provider, _env)): Path<(String, String)>,
    method: Method,
    uri: Uri,
    body: Bytes,
) -> Response {
    if method != Method::PATCH && method != Method::DELETE {
        return method_not_allowed().await;
    }
    let refusal = StatusCode::BAD_REQUEST;
    if let Err(message) = require_deploy_provider(&provider) {
        return error(refusal, &message);
    }
    // Context, then actions, then the project, then the id — the reference's
    // order, and each step can refuse before the next one runs.
    let context = match provider_context(&state, &provider).await {
        Ok(context) => context,
        Err(message) => return error(refusal, &message),
    };
    let actions = match actions(&state, &provider).await {
        Ok(actions) => actions,
        Err(message) => return error(refusal, &message),
    };
    let project = match require_project(&context) {
        Ok(project) => project.to_string(),
        Err(message) => return error(refusal, &message),
    };
    let Some(env_id) = decode_uri_component(raw_env_segment(&uri)) else {
        return error(refusal, "URI malformed");
    };

    if method == Method::DELETE {
        return match actions.delete_env(&project, &env_id).await {
            Ok(()) => ok(),
            Err(failure) => error(refusal, &failure.message),
        };
    }

    let payload = read_json_object(&body);
    // An empty string is not a new value: it is the dialog saying "leave the
    // value alone and change only the environments".
    let value = string_field(&payload, "value").filter(|value| !value.is_empty());
    // Absent rather than empty when the caller sent no list at all, which means
    // "keep the environments it has".
    let environments = payload
        .get("environments")
        .and_then(Value::as_array)
        .map(|_| string_list(&payload, "environments"));
    match actions
        .update_env(&project, &env_id, value, environments.as_deref())
        .await
    {
        Ok(env) => Json(json!({ "ok": true, "env": env })).into_response(),
        Err(failure) => error(refusal, &failure.message),
    }
}

/// The domains a project serves on. Like the two reads below it, this guards no
/// verb and answers 500 for everything.
async fn domains(State(state): State<AppState>, Path(provider): Path<String>) -> Response {
    let refusal = StatusCode::INTERNAL_SERVER_ERROR;
    if let Err(message) = require_deploy_provider(&provider) {
        return error(refusal, &message);
    }
    let context = match provider_context(&state, &provider).await {
        Ok(context) => context,
        Err(message) => return error(refusal, &message),
    };
    let project = match require_project(&context) {
        Ok(project) => project,
        Err(message) => return error(refusal, &message),
    };
    match context.client.list_domains(project).await {
        Ok(domains) => Json(json!({ "ok": true, "domains": domains })).into_response(),
        Err(failure) => error(refusal, &failure.message),
    }
}

/// The strings in a JSON array field, with everything that is not a string
/// dropped — the reference filters rather than refusing, so `["a", 7]` is a
/// list of one.
fn string_list(payload: &Value, key: &str) -> Vec<String> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

async fn projects(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    uri: Uri,
) -> Response {
    let context = match context(&state, &provider).await {
        Ok(context) => context,
        Err(response) => return response,
    };
    // A search of only spaces is no search: the reference trims and then treats
    // the empty string as absent, so `?search=%20%20` reaches the vendor as no
    // filter rather than as a filter nothing matches.
    let search = query_value(&uri, "search")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    match context.client.list_projects(search.as_deref()).await {
        Ok(projects) => {
            let mut body = serde_json::Map::new();
            body.insert("ok".into(), Value::Bool(true));
            body.insert("projects".into(), json!(projects));
            // Absent rather than null when nothing is linked, because the
            // reference builds this from `context.project?.id`.
            if let Some(linked) = context
                .project
                .as_ref()
                .and_then(|project| project.id.clone())
            {
                body.insert("linkedProjectId".into(), linked);
            }
            Json(Value::Object(body)).into_response()
        }
        Err(failure) => error(StatusCode::INTERNAL_SERVER_ERROR, &failure.message),
    }
}

async fn deployments(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    uri: Uri,
) -> Response {
    let context = match context(&state, &provider).await {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(project) = context.project.as_ref() else {
        return Json(json!({ "ok": true, "deployments": [], "project": Value::Null }))
            .into_response();
    };
    let Some(project_id) = project.identifier() else {
        return Json(json!({ "ok": true, "deployments": [], "project": Value::Null }))
            .into_response();
    };

    // Anything that is not one of the two named targets is no target at all,
    // rather than a filter the vendor would reject.
    let target =
        query_value(&uri, "target").filter(|value| value == "production" || value == "preview");
    let limit = deployment_limit(query_value(&uri, "limit").as_deref());

    match context
        .client
        .list_deployments(
            project_id,
            target.as_deref(),
            limit.unwrap_or(DEFAULT_DEPLOYMENTS),
        )
        .await
    {
        Ok(deployments) => Json(json!({
            "ok": true,
            "project": project,
            "deployments": deployments,
        }))
        .into_response(),
        Err(failure) => error(StatusCode::INTERNAL_SERVER_ERROR, &failure.message),
    }
}

/// `Number.parseInt(value, 10)` of the query value, kept only when it came out
/// a positive number, and capped.
///
/// `parseInt` is not `Number()`: it reads the leading digits and ignores
/// whatever follows, so `20abc` is twenty and `abc` is nothing at all. A value
/// at or below zero is *dropped* rather than clamped, which is what lets the
/// vendors' own default apply instead of a limit of one.
fn deployment_limit(raw: Option<&str>) -> Option<u32> {
    let parsed = parse_int(raw.unwrap_or(""))?;
    (parsed > 0).then(|| parsed.min(i64::from(MAX_DEPLOYMENTS)) as u32)
}

/// The leading integer of a string, the way `Number.parseInt` reads one.
fn parse_int(raw: &str) -> Option<i64> {
    let text = raw.trim_start();
    let (sign, digits) = match text.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, text.strip_prefix('+').unwrap_or(text)),
    };
    let leading: String = digits.chars().take_while(char::is_ascii_digit).collect();
    // Saturating, because `parseInt` of a number too large for an integer is a
    // float rather than a failure, and either way it is over the cap.
    leading
        .parse::<i64>()
        .ok()
        .or((!leading.is_empty()).then_some(i64::MAX))
        .map(|value| sign * value)
}
