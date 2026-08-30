//! Browser sign-in for a deploy provider: OAuth 2.0 authorization code + PKCE
//! against a loopback redirect (RFC 8252, "OAuth 2.0 for Native Apps").
//!
//! The Rust half of `src/core/providers/oauth.ts`. Every provider that offers a
//! browser sign-in needs the same seven things — discovery, dynamic client
//! registration, a PKCE challenge, the authorize URL, the code exchange, a
//! rotating refresh, and somewhere to park the verifier between the redirect
//! and the callback. None of that is vendor-specific. What *is* vendor-specific
//! is four constants, which arrive as a [`ProviderOAuthSpec`].
//!
//! Two behaviours this module is built around, both first met in Vercel's
//! authorization server and both common enough to be the default:
//!
//! 1. `offline_access` (or the provider's equivalent) is **required**. Without
//!    it the grant comes back with no refresh token and dies after an hour,
//!    forcing the user to sign in again. Hence `scope` is not optional.
//! 2. Refresh may **rotate**: a refresh can return a new refresh token and
//!    invalidate the previous one, so the caller must persist what comes back.
//!
//! **These requests do not go through the provider egress allowlist.** That
//! allowlist follows a provider's *API* base, and an authorization server is a
//! different host from the API it issues tokens for — Vercel's is `vercel.com`,
//! not `api.vercel.com`. The issuer is a constant in this file's callers rather
//! than anything a request can influence, which is what keeps that safe.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// How long a discovery document is reused before it is read again.
const DISCOVERY_TTL_MS: i64 = 60 * 60 * 1000;
/// How long a started sign-in stays redeemable. Past this the verifier is
/// swept, because a code that has not come back in ten minutes is not coming.
const PENDING_LOGIN_TTL_MS: i64 = 10 * 60 * 1000;
/// Refresh a little early so a call never starts with an about-to-expire token.
pub const TOKEN_REFRESH_SKEW_MS: i64 = 60_000;
const DEFAULT_CLIENT_NAME: &str = "NoMoreIDE";

/// The vendor-specific half of a browser sign-in.
///
/// Deliberately four plain values and no behaviour: this is the shape that has
/// to survive being read out of a provider manifest rather than compiled in.
#[derive(Debug, Clone)]
pub struct ProviderOAuthSpec {
    /// Display name, used verbatim in every message the user may see.
    pub name: String,
    /// Issuer whose `/.well-known/openid-configuration` is read.
    pub issuer: String,
    /// Scopes requested at authorize time, space-separated.
    pub scope: String,
    /// Path the loopback redirect points at, e.g.
    /// `/api/providers/vercel/oauth/callback`.
    pub callback_path: String,
    /// Name registered with the authorization server.
    pub client_name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct OAuthMetadata {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: Option<String>,
    pub userinfo_endpoint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Epoch ms at which `access_token` stops being accepted.
    pub expires_at: i64,
}

/// A sign-in that has been started and is waiting for its callback.
#[derive(Debug, Clone)]
pub struct PendingLogin {
    pub state: String,
    pub verifier: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub authorize_url: String,
    pub created_at: i64,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Discovered metadata per issuer.
///
/// Keyed rather than a single slot because two providers signed in at once
/// would otherwise serve each other's endpoints — and cached at all because a
/// sign-in reads it twice, once to build the authorize URL and once to exchange
/// the code, and those are two unrelated requests minutes apart.
fn discovery_cache() -> &'static Mutex<HashMap<String, (OAuthMetadata, i64)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (OAuthMetadata, i64)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Exposed for tests and for a daemon that has been pointed at a new issuer;
/// with no argument every issuer is cleared.
pub fn reset_discovery_cache(issuer: Option<&str>) {
    let mut cache = lock(discovery_cache());
    match issuer {
        Some(issuer) => {
            cache.remove(issuer);
        }
        None => cache.clear(),
    }
}

/// The issuer's advertised endpoints. Discovered rather than hard-coded so a
/// move of the token or registration endpoint doesn't silently break sign-in.
pub async fn discover(spec: &ProviderOAuthSpec) -> Result<OAuthMetadata, String> {
    let now = now_ms();
    if let Some((cached, fetched_at)) = lock(discovery_cache()).get(&spec.issuer) {
        if now - fetched_at < DISCOVERY_TTL_MS {
            return Ok(cached.clone());
        }
    }

    let name = &spec.name;
    let response = client()
        .get(format!("{}/.well-known/openid-configuration", spec.issuer))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("{name} OAuth discovery failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "{name} OAuth discovery failed (HTTP {}).",
            status.as_u16()
        ));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("{name} OAuth discovery returned no JSON: {error}"))?;

    let (Some(authorization_endpoint), Some(token_endpoint)) = (
        string_field(&body, "authorization_endpoint"),
        string_field(&body, "token_endpoint"),
    ) else {
        return Err(format!(
            "{name} OAuth discovery is missing its authorization or token endpoint."
        ));
    };

    let metadata = OAuthMetadata {
        authorization_endpoint,
        token_endpoint,
        registration_endpoint: string_field(&body, "registration_endpoint"),
        userinfo_endpoint: string_field(&body, "userinfo_endpoint"),
    };
    lock(discovery_cache()).insert(spec.issuer.clone(), (metadata.clone(), now));
    Ok(metadata)
}

/// Registers a client for `redirect_uri` (RFC 7591).
///
/// Called immediately before every sign-in rather than once at install time:
/// the endpoint may hand back a shared client whose redirect list is replaced
/// by whatever was registered last, so re-registering is what guarantees our
/// own redirect is the one in force when the user reaches the consent screen.
pub async fn register_client(
    spec: &ProviderOAuthSpec,
    metadata: &OAuthMetadata,
    redirect_uri: &str,
) -> Result<String, String> {
    let name = &spec.name;
    let endpoint = metadata
        .registration_endpoint
        .as_deref()
        .ok_or_else(|| format!("{name} does not advertise a client registration endpoint."))?;
    let response = client()
        .post(endpoint)
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "client_name": spec.client_name.as_deref().unwrap_or(DEFAULT_CLIENT_NAME),
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "application_type": "native",
        }))
        .send()
        .await
        .map_err(|error| format!("{name} client registration failed: {error}"))?;

    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(oauth_error(&body)
            .unwrap_or_else(|| format!("Client registration failed (HTTP {}).", status.as_u16())));
    }
    string_field(&body, "client_id").ok_or_else(|| format!("{name} returned no client_id."))
}

/// Registers a client and builds the URL the user's browser must open.
pub async fn begin_login(
    spec: &ProviderOAuthSpec,
    redirect_uri: &str,
) -> Result<PendingLogin, String> {
    let metadata = discover(spec).await?;
    let client_id = register_client(spec, &metadata, redirect_uri).await?;

    let verifier = random_base64url(32);
    let state = random_base64url(16);

    Ok(PendingLogin {
        authorize_url: authorize_url(
            &metadata.authorization_endpoint,
            &client_id,
            redirect_uri,
            &verifier,
            &state,
            &spec.scope,
        )?,
        client_id,
        redirect_uri: redirect_uri.to_string(),
        verifier,
        state,
        created_at: now_ms(),
    })
}

/// The consent URL, with the seven parameters in the order the reference sets
/// them.
///
/// Built by parsing the endpoint rather than by formatting a string, because
/// the reference reaches for `URL.searchParams` — which keeps a query the
/// endpoint already carried instead of starting a second one, and encodes as
/// `application/x-www-form-urlencoded` so a space in a scope becomes `+`.
pub fn authorize_url(
    endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    verifier: &str,
    state: &str,
    scope: &str,
) -> Result<String, String> {
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut url =
        url::Url::parse(endpoint).map_err(|error| format!("Invalid authorize URL: {error}"))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("client_id", client_id);
        query.append_pair("redirect_uri", redirect_uri);
        query.append_pair("response_type", "code");
        query.append_pair("code_challenge", &challenge);
        query.append_pair("code_challenge_method", "S256");
        query.append_pair("state", state);
        query.append_pair("scope", scope);
    }
    Ok(url.to_string())
}

/// Exchanges the authorization code the callback received for tokens.
pub async fn complete_login(
    spec: &ProviderOAuthSpec,
    pending: &PendingLogin,
    code: &str,
) -> Result<OAuthTokens, String> {
    token_request(
        spec,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &pending.redirect_uri),
            ("client_id", &pending.client_id),
            ("code_verifier", &pending.verifier),
        ],
    )
    .await
}

/// Trades a refresh token for a fresh access token. Treat the returned
/// `refresh_token` as replacing the one passed in — providers rotate on use.
pub async fn refresh_tokens(
    spec: &ProviderOAuthSpec,
    client_id: &str,
    refresh_token: &str,
) -> Result<OAuthTokens, String> {
    token_request(
        spec,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", client_id),
        ],
    )
    .await
}

async fn token_request(
    spec: &ProviderOAuthSpec,
    form: &[(&str, &str)],
) -> Result<OAuthTokens, String> {
    let name = &spec.name;
    let metadata = discover(spec).await?;
    let response = client()
        .post(&metadata.token_endpoint)
        .header("Accept", "application/json")
        .form(form)
        .send()
        .await
        .map_err(|error| format!("{name} token request failed: {error}"))?;

    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(oauth_error(&body).unwrap_or_else(|| {
            format!("{name} token request failed (HTTP {}).", status.as_u16())
        }));
    }

    let access_token = string_field(&body, "access_token")
        .ok_or_else(|| format!("{name} returned no access token."))?;
    let expires_in = body
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or(3600);
    Ok(OAuthTokens {
        access_token,
        refresh_token: string_field(&body, "refresh_token"),
        expires_at: now_ms() + expires_in * 1000,
    })
}

/// The sign-ins awaiting their callback.
///
/// Kept in memory, never on disk: the PKCE verifier is only meaningful for the
/// minutes between the redirect and the callback, and a restart mid-login is
/// better restarted than resumed.
#[derive(Debug, Default)]
pub struct LoginSessions {
    pending: Mutex<HashMap<String, PendingLogin>>,
}

impl LoginSessions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn remember(&self, login: PendingLogin) {
        let mut pending = lock(&self.pending);
        sweep(&mut pending);
        pending.insert(login.state.clone(), login);
    }

    /// Returns and forgets the login for `state`; a code is only redeemable
    /// once.
    pub fn take(&self, state: &str) -> Option<PendingLogin> {
        let mut pending = lock(&self.pending);
        sweep(&mut pending);
        pending.remove(state)
    }
}

fn sweep(pending: &mut HashMap<String, PendingLogin>) {
    let cutoff = now_ms() - PENDING_LOGIN_TTL_MS;
    pending.retain(|_, login| login.created_at >= cutoff);
}

/// The loopback callback URL for a request that arrived on `host`.
///
/// Derived from the incoming `Host` header so the flow works on whatever port
/// the daemon (or the Vite dev proxy) is actually serving, and **rejected
/// unless it is loopback** — a redirect pointing anywhere else would hand the
/// authorization code to a host that is not this machine.
pub fn loopback_callback_url(
    spec: &ProviderOAuthSpec,
    host: Option<&str>,
) -> Result<String, String> {
    let refusal = || {
        format!(
            "{} sign-in requires a loopback address (localhost or 127.0.0.1).",
            spec.name
        )
    };
    let host = host.map(str::trim).filter(|host| !host.is_empty());
    let Some(host) = host else {
        return Err(refusal());
    };
    // Bracket-stripping before the port split, which is what makes `[::1]:4317`
    // read as `::1` rather than as an empty hostname.
    let hostname = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(':')
        .next()
        .unwrap_or_default();
    if !is_loopback_host(hostname) {
        return Err(refusal());
    }
    Ok(format!("http://{host}{}", spec.callback_path))
}

fn is_loopback_host(hostname: &str) -> bool {
    matches!(hostname, "localhost" | "127.0.0.1" | "::1")
}

/// One client for every OAuth call, with redirects refused rather than
/// followed: a 3xx out of an authorization server is something to inspect, not
/// to chase to whatever host it names.
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_default()
}

/// A URL-safe random string. `uuid` is already a dependency and is a CSPRNG
/// source here only in the sense that v4 uses `getrandom`; two of them give the
/// 256 bits PKCE wants without adding a `rand` dependency.
pub fn random_base64url(bytes: usize) -> String {
    let mut raw = Vec::with_capacity(bytes + 16);
    while raw.len() < bytes {
        raw.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    }
    raw.truncate(bytes);
    URL_SAFE_NO_PAD.encode(raw)
}

/// A string the authorization server actually sent, in the sense the reference
/// means it: present, a string, and not blank once trimmed.
pub fn string_field(body: &Value, field: &str) -> Option<String> {
    body.get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// The sentence an OAuth error body is worth, preferring the description and
/// naming the code beside it when both are there.
pub fn oauth_error(body: &Value) -> Option<String> {
    let description = string_field(body, "error_description");
    let error = string_field(body, "error");
    match (description, error) {
        (Some(description), Some(error)) => Some(format!("{description} ({error})")),
        (Some(description), None) => Some(description),
        (None, error) => error,
    }
}

/// A poisoned lock here means a previous holder panicked mid-update, not that
/// the map is unusable — the sign-in it belonged to is lost either way.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> ProviderOAuthSpec {
        ProviderOAuthSpec {
            name: "Vendor".into(),
            issuer: "https://vendor.test".into(),
            scope: "offline_access".into(),
            callback_path: "/api/providers/vendor/oauth/callback".into(),
            client_name: None,
        }
    }

    #[test]
    fn pkce_challenge_is_the_base64url_sha256_of_the_verifier() {
        // RFC 7636 appendix B's published vector.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let url = authorize_url(
            "https://vendor.test/authorize",
            "c",
            "http://127.0.0.1:1/cb",
            verifier,
            "s",
            "offline_access",
        )
        .unwrap();
        assert!(
            url.contains("code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"),
            "{url}"
        );
    }

    /// A query the endpoint already carried survives, because the reference
    /// sets parameters on a parsed URL rather than appending `?`.
    #[test]
    fn an_endpoint_that_already_has_a_query_keeps_it() {
        let url = authorize_url(
            "https://vendor.test/authorize?mode=dark",
            "c",
            "http://127.0.0.1:1/cb",
            "v",
            "s",
            "a b",
        )
        .unwrap();
        assert!(url.contains("mode=dark"), "{url}");
        // Form encoding, not percent encoding: a space in a scope is a `+`.
        assert!(url.contains("scope=a+b"), "{url}");
    }

    #[test]
    fn only_a_loopback_host_may_receive_the_code() {
        for host in ["127.0.0.1:4317", "localhost:4317", "localhost"] {
            assert_eq!(
                loopback_callback_url(&spec(), Some(host)).unwrap(),
                format!("http://{host}/api/providers/vendor/oauth/callback"),
                "{host}"
            );
        }
        for host in [
            "evil.example",
            "127.0.0.1.evil.example",
            "10.0.0.1:4317",
            "",
            "   ",
        ] {
            let refusal = loopback_callback_url(&spec(), Some(host)).unwrap_err();
            assert!(refusal.contains("loopback"), "{host}: {refusal}");
        }
        assert!(loopback_callback_url(&spec(), None).is_err());
    }

    /// **Every IPv6 form is refused, `::1` included** — including the one the
    /// loopback list itself names.
    ///
    /// Splitting on the first colon leaves an empty hostname for an address
    /// whose own separators are colons, so the `::1` arm above can never be
    /// reached. Reproduced deliberately rather than fixed: it is the
    /// reference's behaviour, a daemon reached on `[::1]` has this sign-in fail
    /// on both runtimes, and correcting it here alone would be a divergence
    /// that reads as a bug fix.
    #[test]
    fn an_ipv6_loopback_is_refused_although_the_list_names_it() {
        for host in ["[::1]:4317", "[::1]", "::1"] {
            assert!(
                loopback_callback_url(&spec(), Some(host)).is_err(),
                "{host}"
            );
        }
    }

    /// A verifier is only good for the minutes between the redirect and the
    /// callback, and a state is redeemable exactly once.
    #[test]
    fn a_session_is_taken_once_and_expires_on_its_own() {
        let sessions = LoginSessions::new();
        let login = PendingLogin {
            state: "s1".into(),
            verifier: "v".into(),
            client_id: "c".into(),
            redirect_uri: "http://127.0.0.1:1/cb".into(),
            authorize_url: "https://vendor.test/authorize".into(),
            created_at: now_ms(),
        };
        sessions.remember(login.clone());
        assert_eq!(sessions.take("s1").unwrap().verifier, "v");
        assert!(sessions.take("s1").is_none());

        sessions.remember(PendingLogin {
            state: "old".into(),
            created_at: now_ms() - PENDING_LOGIN_TTL_MS - 1,
            ..login
        });
        assert!(sessions.take("old").is_none());
    }

    #[test]
    fn oauth_errors_prefer_the_description() {
        let body = serde_json::json!({ "error": "invalid_grant", "error_description": "Expired" });
        assert_eq!(oauth_error(&body).unwrap(), "Expired (invalid_grant)");
        assert_eq!(
            oauth_error(&serde_json::json!({ "error": "bad" })).unwrap(),
            "bad"
        );
        assert_eq!(oauth_error(&serde_json::json!({})), None);
    }

    #[test]
    fn random_values_are_url_safe_and_distinct() {
        let first = random_base64url(32);
        let second = random_base64url(32);
        assert_ne!(first, second);
        assert!(!first.contains('+') && !first.contains('/') && !first.contains('='));
    }
}
