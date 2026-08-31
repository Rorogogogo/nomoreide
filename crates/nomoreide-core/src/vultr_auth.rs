//! Which Vultr credential to use, and what to say when there is none.
//!
//! The Rust half of `src/core/vultr-auth.ts`. Vultr has no CLI to log in with,
//! so the `cli` source here is backed by an environment variable rather than a
//! session file the vendor's own tool wrote. What makes it `cli` rather than
//! `stored` is the policy attached to it and not where the token lives: it is
//! never written to config, so it disappears when the environment does.

use crate::config::{Config, ConfigStore};
use serde_json::Value;

pub const VULTR_PROVIDER_ID: &str = "vultr";

/// What a caller needs to make a request, and where it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedCredential {
    pub source: String,
    pub token: String,
}

/// The message every not-connected path answers with. One string, because the
/// dashboard shows it in three places and they must agree.
pub const NOT_CONNECTED: &str =
    "Vultr is not connected. Add a Vultr API key, or export VULTR_API_KEY.";

/// Why the environment-backed source is unavailable, shown beside the paste box.
pub const NO_ENVIRONMENT_KEY: &str =
    "No VULTR_API_KEY in the environment. Export one, or paste a Vultr API key instead.";

/// The token an exported variable offers, if any.
///
/// Two names because the vendor's own documentation has used both, and a user
/// who exported the other one is not misconfigured.
pub fn environment_token() -> Option<String> {
    ["VULTR_API_KEY", "VULTR_API_TOKEN"]
        .iter()
        .find_map(|name| {
            std::env::var(name)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
}

/// Whether the environment-backed source is usable right now.
pub fn cli_status() -> (bool, Option<&'static str>) {
    match environment_token() {
        Some(_) => (true, None),
        None => (false, Some(NO_ENVIRONMENT_KEY)),
    }
}

/// The credential to use, preferring a stored key over the environment.
pub fn resolve(_store: &ConfigStore, config: &Config) -> Result<ResolvedCredential, String> {
    let connection = config.connections.get(VULTR_PROVIDER_ID);
    if connection.map(|entry| entry.source.as_str()) == Some("stored") {
        if let Some(token) = connection
            .and_then(|entry| entry.token.clone())
            .map(|token| token.trim().to_string())
            .filter(|token| !token.is_empty())
        {
            return Ok(ResolvedCredential {
                source: "stored".into(),
                token,
            });
        }
    }
    match environment_token() {
        Some(token) => Ok(ResolvedCredential {
            source: "cli".into(),
            token,
        }),
        None => Err(NOT_CONNECTED.into()),
    }
}

/// The connection stripped of its secrets, safe to return to the frontend.
///
/// A host credential is a bare API key with no scope or account attached, so
/// what survives is the source and nothing else — there is no non-secret half
/// worth showing beyond "where this came from".
pub fn public_connection(config: &Config) -> Option<Value> {
    let connection = config.connections.get(VULTR_PROVIDER_ID)?;
    let mut value = serde_json::to_value(connection).ok()?;
    if let Some(object) = value.as_object_mut() {
        object.remove("token");
        object.remove("refreshToken");
    }
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ProviderConnectionDef;

    fn stored(token: &str) -> ProviderConnectionDef {
        ProviderConnectionDef {
            source: "stored".into(),
            token: Some(token.into()),
            refresh_token: Some("secret-refresh".into()),
            expires_at: None,
            client_id: None,
            scope_id: None,
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
            .insert(VULTR_PROVIDER_ID.into(), stored("secret-token"));

        let public = public_connection(&config).unwrap();
        assert!(public.get("token").is_none());
        assert!(public.get("refreshToken").is_none());
        assert_eq!(public["source"], "stored");
        assert!(!serde_json::to_string(&public).unwrap().contains("secret"));
    }

    #[test]
    fn a_stored_key_is_used_and_trimmed() {
        let store = ConfigStore::new(std::path::PathBuf::from("/tmp/unused-vultr.json"));
        let mut config = Config::default();
        config
            .connections
            .insert(VULTR_PROVIDER_ID.into(), stored("  spaced-key  "));

        let credential = resolve(&store, &config).unwrap();
        assert_eq!(credential.source, "stored");
        assert_eq!(credential.token, "spaced-key");
    }

    #[test]
    fn no_credential_anywhere_says_so_once() {
        let store = ConfigStore::new(std::path::PathBuf::from("/tmp/unused-vultr.json"));
        let error = resolve(&store, &Config::default()).unwrap_err();
        assert_eq!(error, NOT_CONNECTED);
    }
}
