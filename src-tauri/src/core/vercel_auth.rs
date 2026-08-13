//! Where a Vercel token comes from — the Rust counterpart of
//! `src/core/vercel-auth.ts`.
//!
//! Mirrors the GitHub integration's "CLI account or pasted token" split: if the
//! user has already run `vercel login`, reuse that session rather than asking
//! them to mint a personal access token. CLI tokens are *never* copied into
//! NoMoreIDE's config — they are re-read from the CLI's own auth file at use
//! time, so `vercel logout` revokes our access too.

use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use tokio::fs;

use super::config::{Config, ConfigStore};
use super::vercel_oauth::{now_ms, refresh_tokens, TOKEN_REFRESH_SKEW_MS};

#[derive(Debug, Clone)]
pub struct ResolvedCredential {
    /// "cli" | "stored" | "oauth"
    pub source: String,
    pub token: String,
    /// Team scope; absent means the personal account.
    pub team_id: Option<String>,
}

impl ResolvedCredential {
    /// Whether identity comes from the OIDC userinfo endpoint rather than
    /// `/v2/user` — see `vercel_manager::Identity`.
    pub fn is_oauth(&self) -> bool {
        self.source == "oauth"
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct CliSession {
    pub token: String,
    /// The CLI's currently selected scope, used as the default team.
    pub current_team: Option<String>,
}

/// Candidate locations of the Vercel CLI's `auth.json`, newest convention
/// first. The CLI resolves these through `xdg-app-paths` under the app name
/// `com.vercel.cli`; the trailing entries are the pre-rename legacy paths that
/// long-lived installs still carry.
fn cli_data_dirs() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let mut dirs_list = Vec::new();
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.trim().is_empty() {
            dirs_list.push(PathBuf::from(xdg).join("com.vercel.cli"));
        }
    }
    #[cfg(target_os = "macos")]
    dirs_list.push(
        home.join("Library")
            .join("Application Support")
            .join("com.vercel.cli"),
    );
    #[cfg(target_os = "windows")]
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        if !local.trim().is_empty() {
            dirs_list.push(PathBuf::from(local).join("com.vercel.cli").join("Data"));
        }
    }
    dirs_list.push(home.join(".local").join("share").join("com.vercel.cli"));
    dirs_list.push(home.join(".vercel"));
    dirs_list.push(home.join(".now"));
    dirs_list
}

/// The Vercel CLI's stored login, or None when the user has not run
/// `vercel login` on this machine. Best-effort by design: an unreadable or
/// malformed auth file is "not logged in", never an error the UI has to explain.
pub async fn read_cli_session() -> Option<CliSession> {
    for dir in cli_data_dirs() {
        let Some(token) = read_json_field(&dir.join("auth.json"), "token").await else {
            continue;
        };
        let current_team = read_json_field(&dir.join("config.json"), "currentTeam").await;
        return Some(CliSession {
            token,
            current_team,
        });
    }
    None
}

pub async fn cli_status() -> CliStatus {
    if read_cli_session().await.is_some() {
        return CliStatus {
            available: true,
            error: None,
        };
    }
    CliStatus {
        available: false,
        error: Some(
            "No Vercel CLI login found. Run `vercel login`, or paste a token instead.".into(),
        ),
    }
}

/// The token the Vercel integration should use, given the saved connection.
///
/// Returns an actionable message rather than None: every caller needs a token
/// to do anything, and the message is what the UI shows.
pub async fn resolve(store: &ConfigStore, config: &Config) -> Result<ResolvedCredential, String> {
    let connection = config.vercel.as_ref();
    let team_id = connection.and_then(|c| c.team_id.clone());

    match connection.map(|c| c.source.as_str()) {
        Some("oauth") => Ok(ResolvedCredential {
            source: "oauth".into(),
            token: oauth_access_token(store, config).await?,
            team_id,
        }),
        Some("stored") => {
            let token = connection
                .and_then(|c| c.token.clone())
                .filter(|token| !token.trim().is_empty())
                .ok_or("No Vercel token stored. Reconnect Vercel with a token.")?;
            Ok(ResolvedCredential {
                source: "stored".into(),
                token,
                team_id,
            })
        }
        other => match read_cli_session().await {
            Some(session) => Ok(ResolvedCredential {
                source: "cli".into(),
                token: session.token,
                // An explicitly chosen scope wins; otherwise inherit whatever
                // scope the CLI is pointed at, so the dashboard opens on the
                // same team `vercel` uses.
                team_id: team_id.or(session.current_team),
            }),
            None => Err(if other == Some("cli") {
                "The Vercel CLI is no longer logged in. Run `vercel login`, sign in to Vercel, or connect with a token.".into()
            } else {
                "Vercel is not connected. Sign in to Vercel, run `vercel login`, or add a Vercel token.".into()
            }),
        },
    }
}

/// A valid access token for an `oauth` connection, refreshing it first when it
/// has expired (or is about to). The rotated pair is persisted, because the
/// refresh token we just spent is no longer accepted.
async fn oauth_access_token(store: &ConfigStore, config: &Config) -> Result<String, String> {
    let connection = config.vercel.as_ref().ok_or("Vercel is not connected.")?;
    let expires_at = connection.expires_at.unwrap_or(0);
    if let Some(token) = connection.token.as_ref() {
        if now_ms() + TOKEN_REFRESH_SKEW_MS < expires_at {
            return Ok(token.clone());
        }
    }

    let (Some(client_id), Some(refresh_token)) = (
        connection.client_id.as_ref(),
        connection.refresh_token.as_ref(),
    ) else {
        return Err("Your Vercel sign-in has expired. Sign in to Vercel again.".into());
    };

    let tokens = refresh_tokens(client_id, refresh_token)
        .await
        .map_err(|error| {
            format!("Could not renew your Vercel sign-in ({error}). Sign in to Vercel again.")
        })?;
    store
        .update_vercel_tokens(
            tokens.access_token.clone(),
            tokens.refresh_token.clone(),
            tokens.expires_at,
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(tokens.access_token)
}

/// The connection stripped of its secrets, safe to return to the frontend.
pub fn public_connection(config: &Config) -> Option<Value> {
    let connection = config.vercel.as_ref()?;
    let mut value = serde_json::to_value(connection).ok()?;
    if let Some(object) = value.as_object_mut() {
        object.remove("token");
        object.remove("refreshToken");
    }
    Some(value)
}

async fn read_json_field(path: &PathBuf, field: &str) -> Option<String> {
    let raw = fs::read_to_string(path).await.ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    parsed
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::config::VercelConnectionDef;

    fn connection(source: &str) -> VercelConnectionDef {
        VercelConnectionDef {
            source: source.into(),
            token: Some("secret-token".into()),
            refresh_token: Some("secret-refresh".into()),
            expires_at: None,
            client_id: Some("cl_1".into()),
            team_id: Some("team_1".into()),
            team_slug: None,
            username: None,
        }
    }

    #[test]
    fn the_public_connection_masks_both_secrets() {
        let mut config = Config::default();
        config.vercel = Some(connection("oauth"));

        let public = public_connection(&config).unwrap();
        assert!(public.get("token").is_none());
        assert!(public.get("refreshToken").is_none());
        // The non-secret scope must survive, or the UI cannot show it.
        assert_eq!(public["teamId"], "team_1");
        assert!(!serde_json::to_string(&public).unwrap().contains("secret"));
    }

    #[tokio::test]
    async fn a_stored_connection_uses_its_token_and_scope() {
        let store = ConfigStore::new(std::path::PathBuf::from("/tmp/unused-vercel.json"));
        let mut config = Config::default();
        config.vercel = Some(connection("stored"));

        let credential = resolve(&store, &config).await.unwrap();
        assert_eq!(credential.token, "secret-token");
        assert_eq!(credential.team_id.as_deref(), Some("team_1"));
        assert!(!credential.is_oauth());
    }

    #[tokio::test]
    async fn an_expired_oauth_connection_without_a_refresh_token_asks_for_a_new_sign_in() {
        let store = ConfigStore::new(std::path::PathBuf::from("/tmp/unused-vercel.json"));
        let mut config = Config::default();
        let mut oauth = connection("oauth");
        oauth.refresh_token = None;
        oauth.expires_at = Some(0);
        config.vercel = Some(oauth);

        let error = resolve(&store, &config).await.unwrap_err();
        assert!(error.contains("Sign in to Vercel again"));
    }

    #[tokio::test]
    async fn a_fresh_oauth_token_is_used_without_a_refresh() {
        let store = ConfigStore::new(std::path::PathBuf::from("/tmp/unused-vercel.json"));
        let mut config = Config::default();
        let mut oauth = connection("oauth");
        oauth.expires_at = Some(now_ms() + 3_600_000);
        config.vercel = Some(oauth);

        // Would otherwise hit the network, which a unit test must not do.
        let credential = resolve(&store, &config).await.unwrap();
        assert_eq!(credential.token, "secret-token");
        assert!(credential.is_oauth());
    }
}
