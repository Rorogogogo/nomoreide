//! Where the registry lives and who this machine is to it.
//!
//! This used to carry a whole second set of names — a pre-rename config file, a
//! pre-rename environment prefix, and a pre-rename pair of hosts — so that a
//! sign-in from before the rename kept working. All of it is gone: the hosts it
//! pointed at no longer exist, and nothing was ever installed against them.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DEFAULT_API_BASE_URL: &str = "https://api.nomoreide.com";
pub const DEFAULT_FRONTEND_URL: &str = "https://registry.nomoreide.com";

/// API base → registry web UI, for the hosts we actually run.
const KNOWN_FRONTENDS: [(&str, &str); 1] = [(DEFAULT_API_BASE_URL, DEFAULT_FRONTEND_URL)];

/// `NOMOREIDE_<suffix>`.
fn branded_env(suffix: &str) -> Option<String> {
    std::env::var(format!("NOMOREIDE_{suffix}"))
        .ok()
        .filter(|value| !value.trim().is_empty())
}

/// The four keys this file may hold. Anything else in it is dropped on the
/// first write, because the reference re-serialises what it parsed rather than
/// editing the document in place.
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_frontend_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_refresh_token: Option<String>,
}

fn home() -> PathBuf {
    branded_env("HOME")
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn config_path() -> PathBuf {
    if let Some(explicit) = branded_env("CONFIG_PATH") {
        return PathBuf::from(explicit);
    }
    home().join(".nomoreide").join("config.json")
}

/// Trim, drop trailing slashes, and insist on http(s).
///
/// A stored value that fails this is dropped rather than raised: the reference
/// throws, which turns one bad line in a config file into a 500 on every
/// registry route, and there is no gate reaching that case to hold either
/// behaviour in place.
fn normalize_base_url(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let parsed = url::Url::parse(trimmed).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    Some(trimmed.to_string())
}

/// The same cleanup the reference runs over a parsed file: blank values are no
/// values, and the two URLs are normalised on the way in so the writers below
/// never have to.
fn normalize(mut config: StoredConfig) -> StoredConfig {
    config.api_base_url = config
        .api_base_url
        .as_deref()
        .and_then(normalize_base_url_owned);
    config.api_frontend_url = config
        .api_frontend_url
        .as_deref()
        .and_then(normalize_base_url_owned);
    config.api_token = config.api_token.and_then(non_empty);
    config.api_refresh_token = config.api_refresh_token.and_then(non_empty);
    config
}

fn normalize_base_url_owned(value: &str) -> Option<String> {
    normalize_base_url(value)
}

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// The config as it reads today.
pub fn stored() -> StoredConfig {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|text| serde_json::from_str::<StoredConfig>(&text).ok())
        .map(normalize)
        .unwrap_or_default()
}

/// Read, change one key, write the whole file back — to the *current* path,
/// whichever one the read came from.
fn update(change: impl FnOnce(&mut StoredConfig)) -> Result<(), String> {
    let mut config = stored();
    change(&mut config);
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("Failed to serialise registry config: {error}"))?;
    std::fs::write(&path, format!("{body}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

/// Persist the tokens a fresh sign-in returned.
///
/// A sign-in that carried no refresh token leaves any existing one alone —
/// which is the reference's `if (refreshToken)`, not an oversight.
pub fn save_tokens(access_token: &str, refresh_token: Option<&str>) -> Result<(), String> {
    let access = access_token.trim().to_string();
    if access.is_empty() {
        return Err("apiToken cannot be empty.".to_string());
    }
    let refresh = refresh_token.and_then(|value| non_empty(value.to_string()));
    update(|config| {
        config.api_token = Some(access);
        if let Some(refresh) = refresh {
            config.api_refresh_token = Some(refresh);
        }
    })
}

/// Sign out: drop both tokens.
pub fn clear_tokens() -> Result<(), String> {
    update(|config| {
        config.api_token = None;
        config.api_refresh_token = None;
    })
}

pub fn refresh_token() -> Option<String> {
    stored().api_refresh_token
}

/// Where the token came from, which the dashboard shows: a token from the
/// environment cannot be signed out of, and saying so is the difference
/// between a broken button and an explained one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenSource {
    Env,
    Config,
}

impl TokenSource {
    pub fn as_str(self) -> &'static str {
        match self {
            TokenSource::Env => "env",
            TokenSource::Config => "config",
        }
    }
}

/// Which API this machine talks to, and how that was decided.
#[derive(Debug, Clone)]
pub struct ApiTarget {
    pub api_base_url: String,
    /// `env` | `config` | `default`
    pub source: &'static str,
    /// `local` | `prod` | `custom`
    pub mode: &'static str,
}

pub fn api_target() -> ApiTarget {
    let (raw, source) = match branded_env("API_BASE_URL").or_else(|| branded_env("API_URL")) {
        Some(value) => (value, "env"),
        None => match stored().api_base_url {
            Some(value) => (value, "config"),
            None => (DEFAULT_API_BASE_URL.to_string(), "default"),
        },
    };
    let api_base_url =
        normalize_base_url(&raw).unwrap_or_else(|| raw.trim().trim_end_matches('/').to_string());
    ApiTarget {
        mode: mode_of(&api_base_url),
        api_base_url,
        source,
    }
}

/// A loopback host is a developer's own stack; the two published bases are
/// production; anything else is someone's private deployment.
///
/// `::1` is spelled with brackets by every URL parser worth the name, so the
/// bare form the reference tests for never matches. Kept as found — the
/// consequence is that a daemon pointed at `http://[::1]:8080` reports `custom`
/// rather than `local`, which changes a label and nothing else.
fn mode_of(api_base_url: &str) -> &'static str {
    if KNOWN_FRONTENDS.iter().any(|(api, _)| *api == api_base_url) {
        return "prod";
    }
    let host = url::Url::parse(api_base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_default();
    if host == "localhost" || host == "127.0.0.1" || host == "::1" {
        "local"
    } else {
        "custom"
    }
}

/// The API this machine talks to: the environment first, then the stored
/// config, then the one compiled in.
pub fn api_base_url() -> String {
    api_target().api_base_url
}

/// The registry web UI — where the browser sign-in flow lives.
///
/// Derived from the API base only as a last guess, because the two are
/// separately configurable and a deployment is free to put them anywhere.
pub fn frontend_url(api_base_url: Option<&str>) -> String {
    if let Some(from_env) = branded_env("FRONTEND_URL") {
        if let Some(normalized) = normalize_base_url(&from_env) {
            return normalized;
        }
    }
    if let Some(from_config) = stored().api_frontend_url {
        return from_config;
    }
    api_base_url
        .and_then(derive_frontend_url)
        .unwrap_or_else(|| DEFAULT_FRONTEND_URL.to_string())
}

/// The last guess: a published base has a known web UI, a loopback base means
/// the Vite dev server next door, and `api.<domain>` conventionally faces
/// `app.<domain>`. Nothing else can be guessed, so nothing else is.
fn derive_frontend_url(api_base_url: &str) -> Option<String> {
    if let Some(normalized) = normalize_base_url(api_base_url) {
        if let Some((_, known)) = KNOWN_FRONTENDS.iter().find(|(api, _)| *api == normalized) {
            return Some((*known).to_string());
        }
    }
    let url = url::Url::parse(api_base_url).ok()?;
    let host = url.host_str().unwrap_or_default();
    let scheme = url.scheme();
    if host == "localhost" || host == "127.0.0.1" {
        return Some(format!("{scheme}://{host}:5173"));
    }
    host.strip_prefix("api.")
        .map(|rest| format!("{scheme}://app.{rest}"))
}

/// The token and where it came from, or nothing when this machine is signed
/// out.
pub fn api_token_with_source() -> Option<(String, TokenSource)> {
    if let Some(token) = branded_env("API_TOKEN").and_then(non_empty) {
        return Some((token, TokenSource::Env));
    }
    stored()
        .api_token
        .and_then(non_empty)
        .map(|token| (token, TokenSource::Config))
}

/// The token, or the message a caller who has none should be shown.
///
/// Reading is anonymous — a public profile installs without one — so only the
/// tools that write ask for this.
pub fn api_token() -> Result<String, String> {
    api_token_with_source()
        .map(|(token, _)| token)
        .ok_or_else(|| {
            "Not signed in to the profile registry. Sign in from the web UI (Agent Environments → Registry) or set NOMOREIDE_API_TOKEN."
                .to_string()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trailing_slash_is_not_part_of_the_base() {
        assert_eq!(
            normalize_base_url("https://api.example.com/"),
            Some("https://api.example.com".to_string())
        );
    }

    /// One location, and only one.
    ///
    /// This replaces a parity case that covered reading a *second*, pre-rename
    /// file when the first was absent. That fallback is gone, so what is worth
    /// pinning is that there is nothing to fall back to.
    #[test]
    fn the_config_lives_in_exactly_one_place() {
        let path = config_path();
        assert!(
            path.ends_with(".nomoreide/config.json"),
            "unexpected config path: {}",
            path.display()
        );
    }

    #[test]
    fn a_non_http_url_is_not_a_registry() {
        assert_eq!(normalize_base_url("file:///etc/passwd"), None);
        assert_eq!(normalize_base_url("   "), None);
    }

    #[test]
    fn the_published_bases_read_as_production() {
        assert_eq!(mode_of(DEFAULT_API_BASE_URL), "prod");
        assert_eq!(mode_of("http://127.0.0.1:8787"), "local");
        assert_eq!(mode_of("http://localhost:8787"), "local");
        assert_eq!(mode_of("https://api.someone-else.dev"), "custom");
    }

    /// The reference tests a bracketless `::1` against a hostname that always
    /// carries brackets, so this never reads as local. Pinned so a later
    /// "cleanup" of the host comparison is a visible change of behaviour.
    #[test]
    fn an_ipv6_loopback_reads_as_custom() {
        assert_eq!(mode_of("http://[::1]:8787"), "custom");
    }

    /// The pure half of the frontend lookup: the environment and the config
    /// file are ambient, so only the guess is asserted here.
    #[test]
    fn a_frontend_is_guessed_from_the_api_host() {
        assert_eq!(
            derive_frontend_url("https://api.someone-else.dev").as_deref(),
            Some("https://app.someone-else.dev")
        );
        assert_eq!(
            derive_frontend_url("http://127.0.0.1:8787").as_deref(),
            Some("http://127.0.0.1:5173")
        );
        assert_eq!(
            derive_frontend_url(DEFAULT_API_BASE_URL).as_deref(),
            Some(DEFAULT_FRONTEND_URL)
        );
        assert_eq!(derive_frontend_url("https://example.com"), None);
    }
}
