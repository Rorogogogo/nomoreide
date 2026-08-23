//! The token the Cloudflare integration should use — the Rust counterpart of
//! `src/core/cloudflare-auth.ts`.
//!
//! Two sources rather than Vercel's three, and not because Cloudflare has no
//! OAuth: our browser sign-in mints its own client at runtime through dynamic
//! client registration, and Cloudflare has no registration endpoint. So
//! Cloudflare connects with an API token, or by inheriting Wrangler's own
//! login.
//!
//! A Wrangler token is never copied into NoMoreIDE's config. It is re-read from
//! Wrangler's own auth file each time, which is what makes `wrangler logout`
//! revoke our access too.

use serde_json::Value;
use std::path::PathBuf;

use crate::config::{Config, ConfigStore};

pub const CLOUDFLARE_PROVIDER_ID: &str = "cloudflare";

#[derive(Debug, Clone)]
pub struct ResolvedCredential {
    pub source: String,
    pub token: String,
    /// The Cloudflare account this client is scoped to, when one is known.
    pub account_id: Option<String>,
}

/// Wrangler's own login, when there is one.
pub struct WranglerSession {
    pub token: String,
    /// The account Wrangler is pointed at, used as the default scope.
    pub current_account: Option<String>,
}

/// Candidate locations of Wrangler's `config/default.toml`, newest convention
/// first. Wrangler resolves these through `xdg-app-paths` under the app name
/// `.wrangler`; the trailing entry is the pre-XDG path that long-lived installs
/// still carry, and `WRANGLER_HOME` overrides all of them.
pub fn wrangler_config_dirs() -> Vec<PathBuf> {
    // `HOME` from the environment rather than the resolved home directory, so
    // an overridden environment redirects every candidate and not just the XDG
    // one — otherwise a caller that points `XDG_CONFIG_HOME` somewhere still
    // falls through to the real user's login.
    let home = env_trimmed("HOME")
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_default();
    let mut dirs = Vec::new();
    if let Some(wrangler_home) = env_trimmed("WRANGLER_HOME") {
        dirs.push(PathBuf::from(wrangler_home));
    }
    if let Some(xdg) = env_trimmed("XDG_CONFIG_HOME") {
        dirs.push(PathBuf::from(xdg).join(".wrangler"));
    }
    #[cfg(target_os = "macos")]
    dirs.push(home.join("Library").join("Preferences").join(".wrangler"));
    #[cfg(target_os = "windows")]
    if let Some(app_data) = env_trimmed("APPDATA") {
        dirs.push(PathBuf::from(app_data).join(".wrangler").join("Config"));
    }
    dirs.push(home.join(".config").join(".wrangler"));
    dirs.push(home.join(".wrangler"));
    dirs
}

/// The ambient Cloudflare credential, or none when there is none.
///
/// Two sources, in the order Wrangler itself prefers them: the environment,
/// which is how Wrangler runs in CI and in most shells set up for it, then the
/// OAuth token `wrangler login` wrote.
///
/// An expired stored token reads as "not logged in" rather than being handed
/// out. Wrangler refreshes it roughly hourly and rotates the refresh token when
/// it does, so renewing it here would invalidate Wrangler's own copy.
pub async fn read_wrangler_session() -> Option<WranglerSession> {
    let current_account =
        env_trimmed("CLOUDFLARE_ACCOUNT_ID").or_else(|| env_trimmed("CF_ACCOUNT_ID"));
    if let Some(token) = env_trimmed("CLOUDFLARE_API_TOKEN").or_else(|| env_trimmed("CF_API_TOKEN"))
    {
        return Some(WranglerSession {
            token,
            current_account,
        });
    }

    for directory in wrangler_config_dirs() {
        let fields = read_toml_fields(&directory.join("config").join("default.toml")).await;
        let Some(token) = fields.get("oauth_token").cloned() else {
            continue;
        };
        if let Some(expires_at) = fields
            .get("expiration_time")
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        {
            if expires_at.timestamp_millis() <= chrono::Utc::now().timestamp_millis() {
                return None;
            }
        }
        return Some(WranglerSession {
            token,
            current_account,
        });
    }
    None
}

/// The top-level `key = "value"` pairs of a TOML file, or nothing if anything
/// goes wrong.
///
/// Deliberately not a TOML parser: Wrangler's auth file is flat and quoted, and
/// a malformed or missing file must read as "not logged in", never as an error
/// the UI has to explain.
async fn read_toml_fields(path: &std::path::Path) -> std::collections::HashMap<String, String> {
    let mut fields = std::collections::HashMap::new();
    let Ok(raw) = tokio::fs::read_to_string(path).await else {
        return fields;
    };
    for line in raw.split('\n') {
        // Stop at the first table header: everything Wrangler stores is
        // top-level, and a nested table's keys are not the same keys.
        if line.trim_start().starts_with('[') {
            break;
        }
        let Some((key, rest)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || !key.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') {
            continue;
        }
        let value = rest.trim();
        let Some(value) = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')) else {
            continue;
        };
        if !value.is_empty() && !value.contains('"') {
            fields.insert(key.to_string(), value.to_string());
        }
    }
    fields
}

/// The token the Cloudflare integration should use, given the saved connection.
pub async fn resolve(_store: &ConfigStore, config: &Config) -> Result<ResolvedCredential, String> {
    let connection = config.connections.get(CLOUDFLARE_PROVIDER_ID);
    let account_id = connection.and_then(|entry| entry.scope_id.clone());

    if connection.map(|entry| entry.source.as_str()) == Some("stored") {
        let token = connection
            .and_then(|entry| entry.token.clone())
            .filter(|token| !token.is_empty())
            .ok_or("No Cloudflare token stored. Reconnect Cloudflare with an API token.")?;
        return Ok(ResolvedCredential {
            source: "stored".into(),
            token,
            account_id,
        });
    }

    match read_wrangler_session().await {
        Some(session) => Ok(ResolvedCredential {
            source: "cli".into(),
            token: session.token,
            // An explicitly chosen account wins; otherwise follow whatever
            // account the environment points Wrangler at.
            account_id: account_id.or(session.current_account),
        }),
        None => Err(
            if connection.map(|entry| entry.source.as_str()) == Some("cli") {
                "Wrangler is no longer logged in. Run `wrangler login` again, or connect with a Cloudflare API token.".into()
            } else {
                "Cloudflare is not connected. Run `wrangler login`, or add a Cloudflare API token."
                    .into()
            },
        ),
    }
}

/// The connection stripped of its secrets, safe to return to the frontend.
pub fn public_connection(config: &Config) -> Option<Value> {
    let connection = config.connections.get(CLOUDFLARE_PROVIDER_ID)?;
    let mut value = serde_json::to_value(connection).ok()?;
    if let Some(object) = value.as_object_mut() {
        object.remove("token");
        object.remove("refreshToken");
    }
    Some(value)
}

fn env_trimmed(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ProviderConnectionDef;

    fn connection() -> ProviderConnectionDef {
        ProviderConnectionDef {
            source: "stored".into(),
            token: Some("secret-token".into()),
            refresh_token: Some("secret-refresh".into()),
            expires_at: None,
            client_id: None,
            scope_id: Some("acc_1".into()),
            scope_slug: None,
            legacy_team_id: None,
            legacy_team_slug: None,
            username: None,
        }
    }

    #[test]
    fn the_public_connection_masks_both_secrets() {
        let mut config = Config::default();
        config
            .connections
            .insert(CLOUDFLARE_PROVIDER_ID.into(), connection());

        let public = public_connection(&config).unwrap();
        assert!(public.get("token").is_none());
        assert!(public.get("refreshToken").is_none());
        // The account the UI shows has to survive the masking.
        assert_eq!(public["scopeId"], "acc_1");
        assert!(!serde_json::to_string(&public).unwrap().contains("secret"));
    }

    #[tokio::test]
    async fn a_stored_connection_uses_its_token_and_account() {
        let store = ConfigStore::new(std::path::PathBuf::from("/tmp/unused-cloudflare.json"));
        let mut config = Config::default();
        config
            .connections
            .insert(CLOUDFLARE_PROVIDER_ID.into(), connection());

        let credential = resolve(&store, &config).await.unwrap();
        assert_eq!(credential.source, "stored");
        assert_eq!(credential.token, "secret-token");
        assert_eq!(credential.account_id.as_deref(), Some("acc_1"));
    }

    #[tokio::test]
    async fn a_flat_quoted_file_is_read_and_a_table_ends_it() {
        let root = std::env::temp_dir().join(format!("nomoreide-wrangler-{}", std::process::id()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let path = root.join("default.toml");
        tokio::fs::write(
            &path,
            "oauth_token = \"tok\"\nexpiration_time = \"2030-01-01T00:00:00Z\"\n[table]\nhidden = \"no\"\n",
        )
        .await
        .unwrap();

        let fields = read_toml_fields(&path).await;
        assert_eq!(fields.get("oauth_token").map(String::as_str), Some("tok"));
        assert_eq!(fields.get("hidden"), None);

        tokio::fs::remove_dir_all(&root).await.ok();
    }

    #[tokio::test]
    async fn an_unreadable_file_is_not_logged_in_rather_than_an_error() {
        let fields = read_toml_fields(std::path::Path::new("/nonexistent/default.toml")).await;
        assert!(fields.is_empty());
    }
}
