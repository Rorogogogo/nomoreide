//! GitHub connection: which account this machine speaks to GitHub as.
//!
//! Three ways in, and the dashboard treats them as one setting. A personal
//! access token can be pasted, the OAuth device flow can fetch one, or an
//! account the user already has in `gh` can be borrowed — and [`token_status`]
//! reports whichever is in force, together with everything the connect screen
//! needs to offer the other two.
//!
//! Nothing here answers with a token. A stored secret leaves this process only
//! in the `Authorization` header of a request to GitHub itself; what the
//! dashboard sees is the *selection* — which source, which host, which login.

mod api;
mod template;

use crate::server::app::AppState;
use crate::server::body::{parse_form, read_json_object, string_field};
use crate::server::errors::{config_failure, error};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use nomoreide_core::config::{
    selected_git_repository, GitRepoDef, GithubCredentialSelection, GithubProfile,
};
use nomoreide_core::github_auth;
use nomoreide_core::github_context::require_github_context;
use nomoreide_core::github_manager::{GithubApiError, GithubManager};
use nomoreide_core::github_oauth;
use serde_json::{json, Map, Value};

/// The one host these routes speak for. An enterprise install would need its
/// own API base as well as its own token, so a credential for anything else is
/// refused rather than half-supported.
const GITHUB_HOST: &str = "github.com";

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/github/token", get(token_status).post(store_token))
        .route("/api/github/token/:host", delete(remove_token))
        .route("/api/github/accounts", get(accounts))
        .route("/api/github/account", put(select_account))
        .route("/api/github/oauth/start", post(oauth_start))
        .route("/api/github/oauth/poll", post(oauth_poll))
        .merge(api::routes())
        .merge(template::routes())
}

// --- Status -----------------------------------------------------------------

/// Everything the connect screen needs in one answer: whether GitHub is
/// connected, who as, which repository that account was resolved for, and
/// which other accounts could be chosen instead.
///
/// The `status` field carries the outcome rather than the HTTP code: this route
/// answers 200 even when the connection is broken, because "your token expired"
/// is a screen to render, not a request that failed.
async fn token_status(State(state): State<AppState>) -> Response {
    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(reason) => return config_failure(&reason),
    };
    let token = state
        .config_store
        .get_github_token(&config, GITHUB_HOST)
        .map(str::to_string);
    let repository = selected_git_repository(&config).cloned();
    let cli = github_auth::list_accounts().await;
    let selected = repository
        .as_ref()
        .and_then(|repository| repository.github_credential.clone());

    let mut answer = Map::new();
    answer.insert("ok".into(), Value::Bool(true));
    answer.insert(
        "configured".into(),
        // A `gh` account counts as configured without a stored token: the
        // secret lives in the CLI's own auth file and is fetched per call.
        Value::Bool(
            token.is_some() || matches!(selected, Some(GithubCredentialSelection::Gh { .. })),
        ),
    );
    answer.insert("storedConfigured".into(), Value::Bool(token.is_some()));
    answer.insert(
        "deviceFlowAvailable".into(),
        Value::Bool(!github_oauth::client_id().is_empty()),
    );
    answer.insert("accounts".into(), json!(cli.accounts));
    answer.insert("cliAvailable".into(), Value::Bool(cli.available));
    if let Some(reason) = cli.error {
        answer.insert("cliError".into(), Value::String(reason));
    }
    if let Some(selected) = &selected {
        answer.insert("selected".into(), json!(selected));
    }
    if let Some(repository) = &repository {
        answer.insert(
            "repositoryName".into(),
            Value::String(repository.name.clone()),
        );
    }

    if repository.is_none() && token.is_none() {
        answer.insert("status".into(), Value::String("not_configured".into()));
        return Json(Value::Object(answer)).into_response();
    }

    // Backfill: a token stored before identity was captured learns whose it is
    // on the next status check, rather than needing a reconnect. Deliberately
    // *outside* the connection attempt below — failing to save the identity is
    // a broken config, not a broken GitHub connection.
    let mut profile = state.config_store.get_github_profile(&config, GITHUB_HOST);
    if profile.is_none() {
        if let Some(token) = &token {
            profile = fetch_github_profile(token).await;
            if let Some(profile) = &profile {
                if let Err(reason) = state
                    .config_store
                    .set_github_profile(
                        GITHUB_HOST,
                        profile.login.clone(),
                        profile.avatar_url.clone(),
                    )
                    .await
                {
                    return config_failure(&reason);
                }
            }
        }
    }

    match connection(
        &state,
        repository.as_ref(),
        token.as_deref(),
        profile.as_ref(),
    )
    .await
    {
        Ok(fields) => {
            answer.extend(fields);
            Json(Value::Object(answer)).into_response()
        }
        Err(failure) => {
            answer.insert("status".into(), Value::String(failure.status().into()));
            answer.insert("error".into(), Value::String(failure.message()));
            Json(Value::Object(answer)).into_response()
        }
    }
}

/// Why a connection check did not reach "connected".
enum ConnectionFailure {
    /// GitHub answered, and said no. A 401 or 403 means the credential itself
    /// is the problem, which is a different thing to tell the user than "GitHub
    /// could not be reached".
    Api(GithubApiError),
    Local(String),
}

impl ConnectionFailure {
    fn status(&self) -> &'static str {
        match self {
            Self::Api(error) if error.status == 401 || error.status == 403 => "auth_error",
            _ => "connection_error",
        }
    }

    fn message(&self) -> String {
        match self {
            Self::Api(error) => error.message.clone(),
            Self::Local(message) => message.clone(),
        }
    }
}

/// The fields that describe a working connection, or why there isn't one.
async fn connection(
    state: &AppState,
    repository: Option<&GitRepoDef>,
    token: Option<&str>,
    profile: Option<&GithubProfile>,
) -> Result<Map<String, Value>, ConnectionFailure> {
    let mut fields = Map::new();
    let Some(repository) = repository else {
        // No repository at all: the stored token speaks for itself, and who it
        // belongs to is the only question left.
        let token = token
            .ok_or_else(|| ConnectionFailure::Local("No stored GitHub token configured.".into()))?;
        // Who the token belongs to, from the identity stored beside it or —
        // when there is none — from GitHub, asked a second time. (The backfill
        // above has already asked once and been given nothing usable; the
        // reference asks again here rather than remembering that.)
        let (login, avatar_url) = match profile {
            Some(profile) => (Some(profile.login.clone()), profile.avatar_url.clone()),
            None => {
                let viewer = GithubManager::new(token, "", "")
                    .viewer()
                    .await
                    .map_err(ConnectionFailure::Api)?;
                (
                    string_field(&viewer, "login").map(str::to_string),
                    string_field(&viewer, "avatar_url").map(str::to_string),
                )
            }
        };
        // **Mirrors a reference bug on purpose.** This branch reads the viewer
        // payload without checking that it named anyone, so an account GitHub
        // answered for but did not name renders the *word* "undefined" into the
        // avatar URL — `encodeURIComponent(undefined)` is the string
        // `"undefined"` — while the `login` key disappears entirely, because
        // `JSON.stringify` drops it. Reproduced rather than corrected: the two
        // runtimes have to agree, and this is what the dashboard is built
        // against.
        let avatar =
            avatar_url.unwrap_or_else(|| avatar_for_login(login.as_deref().unwrap_or("undefined")));
        let mut user = Map::new();
        if let Some(login) = login {
            user.insert("login".into(), Value::String(login));
        }
        user.insert("avatarUrl".into(), Value::String(avatar));
        fields.insert("status".into(), Value::String("connected".into()));
        fields.insert("user".into(), Value::Object(user));
        return Ok(fields);
    };

    // The repository's own folder, not its active worktree: the remote and the
    // registered credential are properties of the repository, and a worktree
    // that has been removed would fail a question that is not about it.
    let context = require_github_context(&state.config_store, &repository.path)
        .await
        .map_err(|reason| ConnectionFailure::Local(reason.to_string()))?;

    // A `gh` credential names its own account; a stored one is named by the
    // identity captured alongside it.
    let login = match &context.credential {
        GithubCredentialSelection::Gh { login, .. } => Some(login.clone()),
        GithubCredentialSelection::Stored { .. } => profile.map(|profile| profile.login.clone()),
    };
    let user = login.map(|login| {
        // The stored avatar belongs to the stored login. When the account in
        // force is a different one, its public avatar is the right picture.
        let avatar = profile
            .filter(|profile| profile.login == login)
            .and_then(|profile| profile.avatar_url.clone())
            .unwrap_or_else(|| avatar_for_login(&login));
        json!({ "login": login, "avatarUrl": avatar })
    });
    let slug = format!("{}/{}", context.owner, context.repo);

    fields.insert("configured".into(), Value::Bool(true));
    match context.manager.repo_info().await {
        Ok(repository) => {
            fields.insert("status".into(), Value::String("connected".into()));
            fields.insert("credential".into(), json!(context.credential));
            fields.insert("repository".into(), repository);
            fields.insert("repositorySlug".into(), Value::String(slug));
            if let Some(user) = user {
                fields.insert("user".into(), user);
            }
            Ok(fields)
        }
        // A 404 here is the credential working perfectly and answering "no such
        // repository for you" — the signed-in account simply cannot see this
        // one. Reporting that as a failed connection sent people off to
        // reconnect an account that was never broken.
        Err(reason) if reason.status == 404 => {
            fields.insert("status".into(), Value::String("repo_access".into()));
            fields.insert("credential".into(), json!(context.credential));
            fields.insert("repositorySlug".into(), Value::String(slug));
            if let Some(user) = user {
                fields.insert("user".into(), user);
            }
            fields.insert("error".into(), Value::String(reason.message.clone()));
            Ok(fields)
        }
        Err(reason) => Err(ConnectionFailure::Api(reason)),
    }
}

// --- Accounts ---------------------------------------------------------------

/// Which accounts `gh` is already signed in to, so connecting can be a choice
/// rather than another login.
async fn accounts() -> Response {
    let accounts = github_auth::list_accounts().await;
    let mut answer = Map::new();
    answer.insert("ok".into(), Value::Bool(true));
    if let Value::Object(fields) = json!(accounts) {
        answer.extend(fields);
    }
    Json(Value::Object(answer)).into_response()
}

/// Point one repository at one account.
///
/// A `gh` selection is verified by asking the CLI for the token *now*: a
/// repository saved against an account that cannot be spoken for would fail
/// later, on a push, where the cause is much harder to see.
async fn select_account(State(state): State<AppState>, body: Bytes) -> Response {
    let body = read_json_object(&body);
    let repository = string_field(&body, "repository")
        .map(str::trim)
        .unwrap_or_default();
    // `typeof x === "object"` is what the reference tests, and an array passes
    // it. So an array reaches the source check and is refused there, for the
    // reason it is actually wrong rather than as a missing field.
    let candidate = body
        .get("credential")
        .filter(|value| value.is_object() || value.is_array());
    let Some(candidate) = candidate.filter(|_| !repository.is_empty()) else {
        return bad_request("repository and credential are required");
    };
    let host = string_field(candidate, "host").map(str::trim).unwrap_or("");
    if !host.is_empty() && host != GITHUB_HOST {
        return bad_request(
            "The selected repository uses github.com; choose a github.com account.",
        );
    }

    let credential = match string_field(candidate, "source") {
        Some("gh") => {
            let login = string_field(candidate, "login")
                .map(str::trim)
                .unwrap_or("");
            if host.is_empty() || login.is_empty() {
                return bad_request("GitHub CLI host and login are required");
            }
            if let Err(reason) = github_auth::token(host, login).await {
                return bad_request(&reason);
            }
            GithubCredentialSelection::Gh {
                host: host.to_string(),
                login: login.to_string(),
            }
        }
        Some("stored") => {
            let config = match state.config_store.load().await {
                Ok(config) => config,
                Err(reason) => return bad_request(&reason.to_string()),
            };
            if host.is_empty() || state.config_store.get_github_token(&config, host).is_none() {
                let named = if host.is_empty() { "that host" } else { host };
                return bad_request(&format!("No stored GitHub token configured for {named}."));
            }
            GithubCredentialSelection::Stored {
                host: host.to_string(),
            }
        }
        _ => return bad_request("Unsupported GitHub credential source"),
    };

    match state
        .config_store
        .set_github_credential(repository, credential)
        .await
    {
        Ok(_) => ok(),
        Err(reason) => bad_request(&reason.to_string()),
    }
}

// --- Stored tokens ----------------------------------------------------------

/// Store a pasted personal access token, and point the selected repository at
/// it — the second half is what makes it take effect.
async fn store_token(State(state): State<AppState>, body: Bytes) -> Response {
    let form = parse_form(&body);
    let host = form
        .get("host")
        .map(|host| host.trim())
        .filter(|host| !host.is_empty())
        .unwrap_or(GITHUB_HOST)
        .to_string();
    let Some(token) = form
        .get("token")
        .map(|token| token.trim())
        .filter(|token| !token.is_empty())
    else {
        return bad_request("token is required");
    };

    // Who the token belongs to, captured once here so every later status check
    // can name the account without spending an API call. Best-effort: a failure
    // must not fail the login.
    let profile = fetch_github_profile(token).await;
    if let Err(reason) = state
        .config_store
        .set_github_token(host.clone(), token.to_string(), profile)
        .await
    {
        return bad_request(&reason.to_string());
    }
    let config = match state.config_store.load().await {
        Ok(config) => config,
        Err(reason) => return bad_request(&reason.to_string()),
    };
    if let Some(repository) = selected_git_repository(&config) {
        let name = repository.name.clone();
        if let Err(reason) = state
            .config_store
            .set_github_credential(&name, GithubCredentialSelection::Stored { host })
            .await
        {
            return bad_request(&reason.to_string());
        }
    }
    ok()
}

async fn remove_token(State(state): State<AppState>, Path(host): Path<String>) -> Response {
    match state.config_store.remove_github_token(&host).await {
        Ok(_) => ok(),
        Err(reason) => config_failure(&reason),
    }
}

// --- OAuth device flow ------------------------------------------------------

/// Begin the device flow: GitHub hands back a code for the user to type and a
/// page to type it into.
async fn oauth_start() -> Response {
    let client_id = github_oauth::client_id();
    if client_id.is_empty() {
        return bad_request("NOMOREIDE_GITHUB_CLIENT_ID is not set.");
    }
    let data = match github_oauth::request_device_code(&client_id).await {
        Ok(data) => data,
        Err(reason) => return error(StatusCode::INTERNAL_SERVER_ERROR, &reason),
    };
    // Only *here* is the refusal gated on truthiness: an empty `error` beside a
    // real device code is not a refusal, and the reference's `if (data.error)`
    // lets it through. The poll route reads the same field differently.
    if truthy(data.get("error").unwrap_or(&Value::Null)) {
        return bad_request_value(&described(&data));
    }
    let mut answer = Map::new();
    answer.insert("ok".into(), Value::Bool(true));
    // Whatever GitHub sent, in whatever type it sent it: the reference copies
    // these across without inspecting them. A field it omitted is omitted here
    // too — the reference builds this object out of `undefined`s, which
    // `JSON.stringify` drops — but one it sent as null stays null.
    for key in ["device_code", "user_code", "verification_uri"] {
        if let Some(value) = data.get(key) {
            answer.insert(key.into(), value.clone());
        }
    }
    // The completed URL falls back to the plain one, `??`-style: a null is a
    // missing value here, and so is an absent key.
    if let Some(value) = match data.get("verification_uri_complete") {
        Some(Value::Null) | None => data.get("verification_uri"),
        Some(value) => Some(value),
    } {
        answer.insert("verification_uri_complete".into(), value.clone());
    }
    answer.insert(
        "expires_in".into(),
        coalesce(&data, "expires_in", json!(900)),
    );
    answer.insert("interval".into(), coalesce(&data, "interval", json!(5)));
    Json(Value::Object(answer)).into_response()
}

/// Ask whether the user has finished authorizing yet.
///
/// "Not yet" is a success: the dashboard polls this on a timer, and an error
/// every few seconds until the user finishes typing would be indistinguishable
/// from a real failure.
async fn oauth_poll(State(state): State<AppState>, body: Bytes) -> Response {
    let client_id = github_oauth::client_id();
    if client_id.is_empty() {
        return bad_request("NOMOREIDE_GITHUB_CLIENT_ID is not set.");
    }
    let body = read_json_object(&body);
    let Some(device_code) = string_field(&body, "device_code").filter(|code| !code.is_empty())
    else {
        return bad_request("device_code is required");
    };
    let data = match github_oauth::request_access_token(&client_id, device_code).await {
        Ok(data) => data,
        Err(reason) => return error(StatusCode::INTERNAL_SERVER_ERROR, &reason),
    };

    if let Some(token) = data
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
    {
        let profile = fetch_github_profile(token).await;
        if let Err(reason) = state
            .config_store
            .set_github_token(GITHUB_HOST.to_string(), token.to_string(), profile)
            .await
        {
            return error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string());
        }
        let config = match state.config_store.load().await {
            Ok(config) => config,
            Err(reason) => return error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string()),
        };
        if let Some(repository) = selected_git_repository(&config) {
            let name = repository.name.clone();
            if let Err(reason) = state
                .config_store
                .set_github_credential(
                    &name,
                    GithubCredentialSelection::Stored {
                        host: GITHUB_HOST.to_string(),
                    },
                )
                .await
            {
                return error(StatusCode::INTERNAL_SERVER_ERROR, &reason.to_string());
            }
        }
        return Json(json!({ "ok": true, "done": true })).into_response();
    }

    // `authorization_pending` and `slow_down` are the flow working — the second
    // one also asking us to poll less often.
    let code = data.get("error").and_then(Value::as_str);
    if matches!(code, Some("authorization_pending") | Some("slow_down")) {
        return Json(json!({
            "ok": true,
            "done": false,
            "slowDown": code == Some("slow_down"),
        }))
        .into_response();
    }
    // No truthiness test on the way out: anything that is not a token and not
    // one of the two waiting states is a refusal, even one GitHub worded as an
    // empty string. Only the absence of both fields falls back to our own
    // sentence.
    match described(&data) {
        Value::Null => bad_request("Authorization failed"),
        reason => bad_request_value(&reason),
    }
}

/// GitHub's own words for a refusal: the human-readable description when there
/// is one, else the machine code — `error_description ?? error`, in which a
/// null counts as missing and an empty string does not.
fn described(data: &Value) -> Value {
    for key in ["error_description", "error"] {
        match data.get(key) {
            Some(Value::Null) | None => continue,
            Some(value) => return value.clone(),
        }
    }
    Value::Null
}

/// JavaScript truthiness, for the fields the reference branches on directly.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `??` — a field GitHub omitted or sent as null takes the default, and a `0`
/// it really sent is kept.
fn coalesce(data: &Value, key: &str, fallback: Value) -> Value {
    match data.get(key) {
        Some(Value::Null) | None => fallback,
        Some(value) => value.clone(),
    }
}

// --- Shared -----------------------------------------------------------------

/// Who a token belongs to, or nothing.
///
/// Every failure is swallowed on purpose: this runs alongside storing a token,
/// and an identity lookup that failed must not fail the login it decorates.
async fn fetch_github_profile(token: &str) -> Option<GithubProfile> {
    let viewer = GithubManager::new(token, "", "").viewer().await.ok()?;
    let login = string_field(&viewer, "login").filter(|login| !login.is_empty())?;
    Some(GithubProfile {
        login: login.to_string(),
        avatar_url: string_field(&viewer, "avatar_url")
            .filter(|url| !url.is_empty())
            .map(str::to_string),
    })
}

/// The public avatar for a login we already know, which costs no API call.
fn avatar_for_login(login: &str) -> String {
    format!(
        "https://github.com/{}.png?size=64",
        encode_uri_component(login)
    )
}

/// `encodeURIComponent`, whose unreserved set is wider than a URL crate's
/// default — matching it matters because the result is compared against the
/// reference byte for byte.
fn encode_uri_component(value: &str) -> String {
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

fn ok() -> Response {
    Json(json!({ "ok": true })).into_response()
}

fn bad_request(message: &str) -> Response {
    error(StatusCode::BAD_REQUEST, message)
}

/// A refusal GitHub worded, which is not necessarily a string: the reference
/// puts whatever came back into `error`, so a numeric code stays a number.
fn bad_request_value(message: &Value) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "ok": false, "error": message })),
    )
        .into_response()
}
