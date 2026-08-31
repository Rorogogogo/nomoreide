//! Browser sign-in for Vercel: OAuth 2.0 authorization code + PKCE against a
//! loopback redirect (RFC 8252, "OAuth 2.0 for Native Apps").
//!
//! The Rust counterpart of `src/core/vercel-oauth.ts`: Vercel's four constants
//! and the bindings that pin `providers/oauth.rs` to them. Everything the
//! protocol needs — discovery, dynamic client registration, PKCE, the code
//! exchange, rotating refresh — is in that shared module and is not
//! Vercel-specific.
//!
//! What *is* here is a second way to receive the callback. The daemon redirects
//! to a path on its own HTTP server (`deploy_providers/oauth.rs`); the desktop
//! app has no server, so this module binds a `TcpListener` on an ephemeral
//! loopback port, serves exactly one request, and shuts down. That is also why
//! its redirect URI is minted per sign-in rather than fixed, and why the two
//! flows share the protocol but not the transport.
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

use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;

use crate::providers::api_base::provider_api_base;
use crate::providers::oauth::{authorize_url, random_base64url, ProviderOAuthSpec};

pub use crate::providers::oauth::{now_ms, OAuthMetadata, OAuthTokens, TOKEN_REFRESH_SKEW_MS};

/// Where Vercel's authorization server lives.
///
/// Overridable the same loopback-only way the API base is
/// ([`provider_api_base`]), so a sign-in can be driven end to end against a
/// stub — the token exchange and the connection it writes are otherwise the one
/// part of this flow no test can reach without a real Vercel account.
const VERCEL_ISSUER: &str = "https://vercel.com";
const ISSUER_VARIABLE: &str = "NOMOREIDE_VERCEL_OAUTH_ISSUER";
const OAUTH_SCOPE: &str = "offline_access";
/// How long to wait for the user to finish consenting in their browser.
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(600);

/// Vercel's half of the shared browser sign-in — four constants, and nothing
/// else.
///
/// Why not the device flow used for GitHub: Vercel restricts
/// `urn:ietf:params:oauth:grant-type:device_code` to first-party clients, and a
/// client we register is refused with `unauthorized_client`.
///
/// `offline_access` is **required** here specifically — without it Vercel's
/// grant comes back with no refresh token and dies after an hour.
pub fn vercel_oauth() -> ProviderOAuthSpec {
    ProviderOAuthSpec {
        name: "Vercel".into(),
        issuer: provider_api_base(ISSUER_VARIABLE, VERCEL_ISSUER),
        scope: OAUTH_SCOPE.into(),
        callback_path: "/api/providers/vercel/oauth/callback".into(),
        client_name: None,
    }
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

    let spec = vercel_oauth();
    let metadata = crate::providers::oauth::discover(&spec).await?;
    let client_id =
        crate::providers::oauth::register_client(&spec, &metadata, &redirect_uri).await?;

    let verifier = random_base64url(32);
    let state = random_base64url(16);
    let authorize_url = authorize_url(
        &metadata.authorization_endpoint,
        &client_id,
        &redirect_uri,
        &verifier,
        &state,
        &spec.scope,
    )?;

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
            Ok(code) => {
                match exchange_code(&self.redirect_uri, &self.client_id, &self.verifier, &code)
                    .await
                {
                    Ok(tokens) => Ok(tokens),
                    Err(error) => Err(error),
                }
            }
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

            let state = params
                .iter()
                .find(|(key, _)| key == "state")
                .map(|(_, v)| v);
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
    crate::providers::oauth::complete_login(
        &vercel_oauth(),
        &crate::providers::oauth::PendingLogin {
            state: String::new(),
            verifier: verifier.to_string(),
            client_id: client_id.to_string(),
            redirect_uri: redirect_uri.to_string(),
            authorize_url: String::new(),
            created_at: now_ms(),
        },
        code,
    )
    .await
}

/// Trades a refresh token for a fresh access token. The returned
/// `refresh_token` replaces the one passed in — Vercel rotates on every use.
pub async fn refresh_tokens(client_id: &str, refresh_token: &str) -> Result<OAuthTokens, String> {
    crate::providers::oauth::refresh_tokens(&vercel_oauth(), client_id, refresh_token).await
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_parsing_decodes_percent_escapes() {
        let params = parse_query("code=abc%2F123&state=xy+z");
        assert_eq!(params[0], ("code".into(), "abc/123".into()));
        assert_eq!(params[1], ("state".into(), "xy z".into()));
    }

    #[test]
    fn callback_html_escapes_network_supplied_text() {
        assert_eq!(escape_html("<script>"), "&lt;script&gt;");
    }
}
