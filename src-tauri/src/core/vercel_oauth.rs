//! Browser sign-in for Vercel: OAuth 2.0 authorization code + PKCE against a
//! loopback redirect (RFC 8252, "OAuth 2.0 for Native Apps").
//!
//! The Rust counterpart of `src/core/vercel-oauth.ts`, with one structural
//! difference. The Node build redirects to a path on the daemon's own HTTP
//! server; the desktop app has no server, so this module binds a `TcpListener`
//! on an ephemeral loopback port, serves exactly one request, and shuts down.
//! That is also why the redirect URI is minted per sign-in rather than fixed.
//!
//! Two behaviours of Vercel's authorization server this is built around:
//!
//! 1. `offline_access` is **required**. Without it the grant comes back with no
//!    refresh token and dies after an hour.
//! 2. Refresh **rotates**: every refresh returns a new refresh token and
//!    invalidates the previous one, so the caller must persist what comes back.
//!
//! Why not the device flow used for GitHub (`commands/github.rs`): Vercel
//! restricts `urn:ietf:params:oauth:grant-type:device_code` to first-party
//! clients, and a client we register is refused with `unauthorized_client`.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;

const VERCEL_ISSUER: &str = "https://vercel.com";
const OAUTH_SCOPE: &str = "offline_access";
/// Refresh a little early so a call never starts with an about-to-expire token.
pub const TOKEN_REFRESH_SKEW_MS: i64 = 60_000;
/// How long to wait for the user to finish consenting in their browser.
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone)]
pub struct OAuthMetadata {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Epoch ms at which `access_token` stops being accepted.
    pub expires_at: i64,
}

/// A sign-in that has been started: the browser URL to open, plus everything
/// needed to redeem the code the loopback listener is now waiting for.
pub struct PendingLogin {
    pub authorize_url: String,
    pub client_id: String,
    redirect_uri: String,
    verifier: String,
    state: String,
    listener: TcpListener,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The issuer's advertised endpoints. Discovered rather than hard-coded so a
/// move of the token or registration endpoint doesn't silently break sign-in.
pub async fn discover() -> Result<OAuthMetadata, String> {
    let response = reqwest::Client::new()
        .get(format!("{VERCEL_ISSUER}/.well-known/openid-configuration"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("Vercel OAuth discovery failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Vercel OAuth discovery failed (HTTP {status})."));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Vercel OAuth discovery returned no JSON: {error}"))?;

    let authorization_endpoint = string_field(&body, "authorization_endpoint");
    let token_endpoint = string_field(&body, "token_endpoint");
    match (authorization_endpoint, token_endpoint) {
        (Some(authorization_endpoint), Some(token_endpoint)) => Ok(OAuthMetadata {
            authorization_endpoint,
            token_endpoint,
            registration_endpoint: string_field(&body, "registration_endpoint"),
        }),
        _ => Err("Vercel OAuth discovery is missing its authorization or token endpoint.".into()),
    }
}

/// Registers a client for `redirect_uri` (RFC 7591).
///
/// Called immediately before every sign-in rather than once at install time:
/// the endpoint hands back a shared client whose redirect list is replaced by
/// whatever was registered last, so re-registering is what guarantees our own
/// redirect — including this run's ephemeral port — is the one in force.
async fn register_client(metadata: &OAuthMetadata, redirect_uri: &str) -> Result<String, String> {
    let endpoint = metadata
        .registration_endpoint
        .as_deref()
        .ok_or("Vercel does not advertise a client registration endpoint.")?;
    let response = reqwest::Client::new()
        .post(endpoint)
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "client_name": "NoMoreIDE",
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "application_type": "native",
        }))
        .send()
        .await
        .map_err(|error| format!("Vercel client registration failed: {error}"))?;

    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(oauth_error(&body)
            .unwrap_or_else(|| format!("Client registration failed (HTTP {status}).")));
    }
    string_field(&body, "client_id").ok_or_else(|| "Vercel returned no client_id.".into())
}

/// Binds the loopback listener, registers a client for it, and builds the URL
/// the user's browser must open.
pub async fn begin() -> Result<PendingLogin, String> {
    // Port 0: the OS picks a free port, and registering the client immediately
    // afterwards is what makes that port acceptable as a redirect target.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("Could not open a local port for Vercel sign-in: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let metadata = discover().await?;
    let client_id = register_client(&metadata, &redirect_uri).await?;

    let verifier = random_base64url(32);
    let state = random_base64url(16);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));

    let authorize_url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&code_challenge={}&code_challenge_method=S256&state={}&scope={}",
        metadata.authorization_endpoint,
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(&challenge),
        urlencoding::encode(&state),
        urlencoding::encode(OAUTH_SCOPE),
    );

    Ok(PendingLogin {
        authorize_url,
        client_id,
        redirect_uri,
        verifier,
        state,
        listener,
    })
}

impl PendingLogin {
    /// Waits for Vercel to redirect the browser back, then exchanges the code.
    ///
    /// Serves the browser a small page either way, so the user sees an outcome
    /// in the tab rather than a connection error, and consumes the listener so
    /// a code can only ever be redeemed once.
    pub async fn wait_for_tokens(self) -> Result<OAuthTokens, String> {
        let outcome = timeout(CALLBACK_TIMEOUT, self.accept_callback())
            .await
            .map_err(|_| "Vercel sign-in timed out. Start the sign-in again.".to_string())?;

        match outcome {
            Ok(code) => match exchange_code(&self.redirect_uri, &self.client_id, &self.verifier, &code).await {
                Ok(tokens) => Ok(tokens),
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        }
    }

    /// Accepts connections until one carries a callback for *our* `state`.
    ///
    /// Browsers and link scanners open stray connections to a fresh loopback
    /// port; treating the first one as the answer would abort a sign-in that
    /// is still perfectly live.
    async fn accept_callback(&self) -> Result<String, String> {
        loop {
            let (mut stream, _) = self
                .listener
                .accept()
                .await
                .map_err(|error| format!("Vercel sign-in callback failed: {error}"))?;

            let Some(target) = read_request_target(&mut stream).await else {
                continue;
            };
            let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
            let params = parse_query(query);

            if let Some(denied) = params
                .iter()
                .find(|(key, _)| key == "error_description" || key == "error")
                .map(|(_, value)| value.clone())
            {
                respond(&mut stream, "Vercel sign-in failed", &denied).await;
                return Err(denied);
            }

            let state = params.iter().find(|(key, _)| key == "state").map(|(_, v)| v);
            // An unknown `state` is not our callback — a stray probe, a stale
            // tab, or a forged request. Keep listening rather than failing.
            if state.map(String::as_str) != Some(self.state.as_str()) {
                respond(&mut stream, "Not this sign-in", "You can close this tab.").await;
                continue;
            }

            let code = params
                .iter()
                .find(|(key, _)| key == "code")
                .map(|(_, value)| value.clone());
            match code {
                Some(code) => {
                    respond(
                        &mut stream,
                        "Connected to Vercel",
                        "You can close this tab and return to NoMoreIDE.",
                    )
                    .await;
                    return Ok(code);
                }
                None => {
                    let message = "This sign-in link has expired. Start the sign-in again.";
                    respond(&mut stream, "Vercel sign-in failed", message).await;
                    return Err(message.into());
                }
            }
        }
    }
}

/// Exchanges the authorization code the callback received for tokens.
async fn exchange_code(
    redirect_uri: &str,
    client_id: &str,
    verifier: &str,
    code: &str,
) -> Result<OAuthTokens, String> {
    token_request(vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", code.to_string()),
        ("redirect_uri", redirect_uri.to_string()),
        ("client_id", client_id.to_string()),
        ("code_verifier", verifier.to_string()),
    ])
    .await
}

/// Trades a refresh token for a fresh access token. The returned
/// `refresh_token` replaces the one passed in — Vercel rotates on every use.
pub async fn refresh_tokens(client_id: &str, refresh_token: &str) -> Result<OAuthTokens, String> {
    token_request(vec![
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", refresh_token.to_string()),
        ("client_id", client_id.to_string()),
    ])
    .await
}

async fn token_request(form: Vec<(&str, String)>) -> Result<OAuthTokens, String> {
    let metadata = discover().await?;
    let response = reqwest::Client::new()
        .post(&metadata.token_endpoint)
        .header("Accept", "application/json")
        .form(&form)
        .send()
        .await
        .map_err(|error| format!("Vercel token request failed: {error}"))?;

    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(oauth_error(&body)
            .unwrap_or_else(|| format!("Vercel token request failed (HTTP {status}).")));
    }

    let access_token =
        string_field(&body, "access_token").ok_or("Vercel returned no access token.")?;
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

// ---------------------------------------------------------------------------
// Minimal HTTP for the one-shot loopback listener
// ---------------------------------------------------------------------------

/// The request target from the first line of an HTTP request ("GET /x?y HTTP/1.1").
async fn read_request_target(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = [0_u8; 8192];
    let read = timeout(Duration::from_secs(10), stream.read(&mut buffer))
        .await
        .ok()?
        .ok()?;
    let request = String::from_utf8_lossy(&buffer[..read]);
    let mut parts = request.lines().next()?.split_whitespace();
    let method = parts.next()?;
    if method != "GET" {
        return None;
    }
    Some(parts.next()?.to_string())
}

fn parse_query(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            let plus_decoded = value.replace('+', " ");
            let value = urlencoding::decode(&plus_decoded).ok()?;
            Some((key.to_string(), value.into_owned()))
        })
        .collect()
}

async fn respond(stream: &mut TcpStream, heading: &str, detail: &str) {
    let page = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{heading}</title>\
<style>body{{font:15px/1.5 ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#111}}\
@media(prefers-color-scheme:dark){{body{{background:#0a0a0a;color:#fafafa}}}}\
div{{text-align:center;max-width:32rem;padding:2rem}}p{{opacity:.7}}</style></head>\
<body><div><h2>{}</h2><p>{}</p></div></body></html>",
        escape_html(heading),
        escape_html(detail)
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        page.len(),
        page
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;
}

/// Error text reaches this page from the network, so it is escaped, not raw.
fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A URL-safe random string. `uuid` is already a dependency and is a CSPRNG
/// source here only in the sense that v4 uses `getrandom`; two of them give the
/// 256 bits PKCE wants without adding a `rand` dependency.
fn random_base64url(bytes: usize) -> String {
    let mut raw = Vec::with_capacity(bytes + 16);
    while raw.len() < bytes {
        raw.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    }
    raw.truncate(bytes);
    URL_SAFE_NO_PAD.encode(raw)
}

fn string_field(body: &Value, field: &str) -> Option<String> {
    body.get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn oauth_error(body: &Value) -> Option<String> {
    let description = string_field(body, "error_description");
    let error = string_field(body, "error");
    match (description, error) {
        (Some(description), Some(error)) => Some(format!("{description} ({error})")),
        (Some(description), None) => Some(description),
        (None, error) => error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_the_base64url_sha256_of_the_verifier() {
        // RFC 7636 appendix B's published vector.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn random_values_are_url_safe_and_distinct() {
        let a = random_base64url(32);
        let b = random_base64url(32);
        assert_ne!(a, b);
        assert!(!a.contains('+') && !a.contains('/') && !a.contains('='));
    }

    #[test]
    fn query_parsing_decodes_percent_escapes() {
        let params = parse_query("code=abc%2F123&state=xy+z");
        assert_eq!(params[0], ("code".into(), "abc/123".into()));
        assert_eq!(params[1], ("state".into(), "xy z".into()));
    }

    #[test]
    fn oauth_errors_prefer_the_description() {
        let body = serde_json::json!({ "error": "invalid_grant", "error_description": "Expired" });
        assert_eq!(oauth_error(&body).unwrap(), "Expired (invalid_grant)");
        assert_eq!(
            oauth_error(&serde_json::json!({ "error": "bad" })).unwrap(),
            "bad"
        );
    }

    #[test]
    fn callback_html_escapes_network_supplied_text() {
        assert_eq!(escape_html("<script>"), "&lt;script&gt;");
    }
}
