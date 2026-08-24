//! Where the registry lives and who this machine is to it.
//!
//! The registry began life as the brainctl platform, so every lookup falls back
//! to the old `~/.brainctl/config.json` and `BRAINCTL_*` names — an existing
//! brainctl sign-in keeps working. The old names are the *fallback*, never the
//! override: a stale `BRAINCTL_API_BASE_URL` in a shell profile must not win
//! over the current one.

use serde::Deserialize;
use std::path::PathBuf;

pub const DEFAULT_API_BASE_URL: &str = "https://api.nomoreide.com";

/// `NOMOREIDE_<suffix>`, falling back to the pre-rename `BRAINCTL_<suffix>`.
fn branded_env(suffix: &str) -> Option<String> {
    std::env::var(format!("NOMOREIDE_{suffix}"))
        .ok()
        .or_else(|| std::env::var(format!("BRAINCTL_{suffix}")).ok())
        .filter(|value| !value.trim().is_empty())
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredConfig {
    api_base_url: Option<String>,
    api_token: Option<String>,
}

fn home() -> PathBuf {
    branded_env("HOME")
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn config_path() -> PathBuf {
    if let Some(explicit) = branded_env("CONFIG_PATH") {
        return PathBuf::from(explicit);
    }
    home().join(".nomoreide").join("config.json")
}

/// `None` when the current path was set explicitly — there is nothing older to
/// fall back to.
fn legacy_config_path() -> Option<PathBuf> {
    if branded_env("CONFIG_PATH").is_some() {
        return None;
    }
    Some(home().join(".brainctl").join("config.json"))
}

fn stored() -> StoredConfig {
    let read = |path: PathBuf| {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<StoredConfig>(&text).ok())
    };
    read(config_path())
        .or_else(|| legacy_config_path().and_then(read))
        .unwrap_or_default()
}

/// The API this machine talks to: the environment first, then the stored
/// config, then the one compiled in.
pub fn api_base_url() -> String {
    let configured = branded_env("API_BASE_URL")
        .or_else(|| branded_env("API_URL"))
        .or_else(|| stored().api_base_url)
        .unwrap_or_else(|| DEFAULT_API_BASE_URL.to_string());
    configured.trim().trim_end_matches('/').to_string()
}

/// The token, or the message a caller who has none should be shown.
///
/// Reading is anonymous — a public profile installs without one — so only the
/// tools that write ask for this.
pub fn api_token() -> Result<String, String> {
    branded_env("API_TOKEN")
        .or_else(|| stored().api_token)
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            "Not signed in to the profile registry. Sign in from the web UI (Agent Environments → Registry) or set NOMOREIDE_API_TOKEN."
                .to_string()
        })
}
