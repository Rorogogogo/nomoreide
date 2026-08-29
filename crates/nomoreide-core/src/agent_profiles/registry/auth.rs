//! Signing this machine in to the profile registry.
//!
//! The flow is OAuth-shaped but the daemon is not a confidential client: the
//! browser goes to the registry's web UI carrying a state this daemon minted,
//! and the registry redirects back to `/auth/finish` on loopback with a token
//! in the query. The state is what ties the tab that comes back to the request
//! that started it — a callback naming a state nobody issued is refused before
//! anything is stored.
//!
//! A settled outcome is read once and forgotten. That is what stops a tab left
//! open from re-reporting a sign-in that has since been signed out of.

use super::config::{self, TokenSource};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a sign-in may stay unfinished. Long enough to create an account
/// mid-flow, short enough that a state is not a standing invitation.
const STATE_TTL: Duration = Duration::from_secs(10 * 60);

/// How long a *finished* outcome waits to be collected. The dashboard polls
/// every second or two; a minute is for the case where it was backgrounded.
const OUTCOME_RETENTION: Duration = Duration::from_secs(60);

/// What became of one sign-in attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Pending,
    Success,
    Error(String),
}

impl Outcome {
    pub fn as_str(&self) -> &'static str {
        match self {
            Outcome::Pending => "pending",
            Outcome::Success => "success",
            Outcome::Error(_) => "error",
        }
    }

    fn settled(&self) -> bool {
        !matches!(self, Outcome::Pending)
    }
}

#[derive(Debug, Clone)]
struct Entry {
    expires_at: Instant,
    outcome: Outcome,
}

/// The sign-ins currently in flight.
///
/// In memory, and deliberately: a state that survived a daemon restart would
/// outlive the browser tab holding it, and there is nothing here worth keeping
/// across one.
#[derive(Clone, Default)]
pub struct AuthStates {
    inner: Arc<Mutex<HashMap<String, Entry>>>,
}

impl AuthStates {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mint a state, sweeping the expired ones on the way past. Sweeping here
    /// rather than on a timer is what keeps this a plain map: the only way the
    /// table grows is somebody starting a sign-in.
    pub fn issue(&self) -> String {
        let now = Instant::now();
        let state = uuid::Uuid::new_v4().simple().to_string();
        let mut states = self.lock();
        states.retain(|_, entry| entry.expires_at >= now);
        states.insert(
            state.clone(),
            Entry {
                expires_at: now + STATE_TTL,
                outcome: Outcome::Pending,
            },
        );
        state
    }

    /// Is this a state we issued and have not let expire? Expiry is collected
    /// on the way through, so an expired state is gone after the first look.
    pub fn is_live(&self, state: &str) -> bool {
        let mut states = self.lock();
        match states.get(state) {
            Some(entry) if entry.expires_at >= Instant::now() => true,
            Some(_) => {
                states.remove(state);
                false
            }
            None => false,
        }
    }

    /// Record what happened, and start the shorter clock: a settled outcome is
    /// waiting to be collected, not waiting to be finished.
    pub fn mark(&self, state: &str, outcome: Outcome) {
        let mut states = self.lock();
        let Some(entry) = states.get_mut(state) else {
            return;
        };
        if outcome.settled() {
            entry.expires_at = Instant::now() + OUTCOME_RETENTION;
        }
        entry.outcome = outcome;
    }

    /// Read the outcome, forgetting it if it has settled.
    ///
    /// `None` means "no such state", which is also what a second read of a
    /// settled outcome gets — the caller reports both as unknown.
    pub fn read(&self, state: &str) -> Option<Outcome> {
        let mut states = self.lock();
        let entry = match states.get(state) {
            Some(entry) if entry.expires_at >= Instant::now() => entry.clone(),
            Some(_) => {
                states.remove(state);
                return None;
            }
            None => return None,
        };
        if entry.outcome.settled() {
            states.remove(state);
        }
        Some(entry.outcome)
    }

    /// A poisoned lock means a handler panicked mid-update. The map is a cache
    /// of in-flight sign-ins, so the worst an inconsistent entry costs is one
    /// re-run of the flow.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// One answer from the registry, read to the end.
pub struct Fetched {
    pub status: u16,
    pub body: String,
}

impl Fetched {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// GET a registry path with whatever token this machine holds, refreshing once
/// if the answer is a 401.
///
/// The retry is what keeps a long-lived dashboard signed in: access tokens
/// expire on their own schedule and nobody is watching the clock. One retry,
/// never two — a refresh that yields a token the API also rejects is a signed
/// out machine, not a loop to keep running.
pub async fn authenticated_get(path: &str) -> Result<Fetched, String> {
    let url = absolute(path);
    let token = config::api_token_with_source().map(|(token, _)| token);
    let first = send(&url, token.as_deref()).await?;
    if first.status != 401 {
        return Ok(first);
    }
    match refresh().await? {
        Some(refreshed) => send(&url, Some(&refreshed)).await,
        None => Ok(first),
    }
}

/// Trade the refresh token for a new access token, persisting both.
///
/// A refused refresh drops *both* stored tokens: the pair is dead together, and
/// leaving the access token behind would make every later call spend a round
/// trip discovering that again.
async fn refresh() -> Result<Option<String>, String> {
    let Some(refresh_token) = config::refresh_token() else {
        return Ok(None);
    };
    let response = client()?
        .post(absolute("/auth/refresh"))
        .header("content-type", "application/json")
        .body(serde_json::json!({ "refresh_token": refresh_token }).to_string())
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        config::clear_tokens()?;
        return Ok(None);
    }
    let body = response.text().await.map_err(|error| error.to_string())?;
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|error| error.to_string())?;
    let access = parsed
        .get("access_token")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    config::save_tokens(
        &access,
        parsed.get("refresh_token").and_then(|value| value.as_str()),
    )?;
    Ok(Some(access))
}

async fn send(url: &str, token: Option<&str>) -> Result<Fetched, String> {
    let mut request = client()?.get(url);
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    Ok(Fetched { status, body })
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .build()
        .map_err(|error| error.to_string())
}

/// A path becomes a registry URL; a URL is left alone.
fn absolute(path_or_url: &str) -> String {
    if path_or_url.starts_with("http") {
        return path_or_url.to_string();
    }
    let base = config::api_base_url();
    let separator = if path_or_url.starts_with('/') {
        ""
    } else {
        "/"
    };
    format!("{base}{separator}{path_or_url}")
}

/// Save the tokens a finished sign-in carried.
pub fn save_tokens(access_token: &str, refresh_token: Option<&str>) -> Result<(), String> {
    config::save_tokens(access_token, refresh_token)
}

/// Sign out.
pub fn clear_tokens() -> Result<(), String> {
    config::clear_tokens()
}

pub fn token_source() -> Option<TokenSource> {
    config::api_token_with_source().map(|(_, source)| source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_state_nobody_issued_is_not_live() {
        let states = AuthStates::new();
        assert!(!states.is_live("nope"));
        assert_eq!(states.read("nope"), None);
    }

    #[test]
    fn a_state_is_thirty_two_hex_digits() {
        let states = AuthStates::new();
        let state = states.issue();
        assert_eq!(state.len(), 32);
        assert!(state.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(state.bytes().all(|byte| !byte.is_ascii_uppercase()));
    }

    /// The whole point of the outcome route: a settled result is collected
    /// once. A tab reloaded after that gets nothing rather than a stale yes.
    #[test]
    fn a_settled_outcome_is_read_once() {
        let states = AuthStates::new();
        let state = states.issue();
        assert_eq!(states.read(&state), Some(Outcome::Pending));
        assert_eq!(states.read(&state), Some(Outcome::Pending));
        states.mark(&state, Outcome::Success);
        assert_eq!(states.read(&state), Some(Outcome::Success));
        assert_eq!(states.read(&state), None);
    }

    #[test]
    fn an_error_carries_its_message() {
        let states = AuthStates::new();
        let state = states.issue();
        states.mark(&state, Outcome::Error("access_denied".into()));
        assert_eq!(
            states.read(&state),
            Some(Outcome::Error("access_denied".into()))
        );
    }

    #[test]
    fn marking_a_state_nobody_issued_does_nothing() {
        let states = AuthStates::new();
        states.mark("nope", Outcome::Success);
        assert_eq!(states.read("nope"), None);
    }

    #[test]
    fn a_path_joins_the_base_and_a_url_does_not() {
        assert!(absolute("https://elsewhere.test/me") == "https://elsewhere.test/me");
    }
}
