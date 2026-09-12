//! Whether a newer NoMoreIDE has been released.
//!
//! **A notice, not an updater.** Nothing here replaces a binary. A process that
//! overwrites itself while running needs signing, a rollback path and a story
//! for the daemon whose services are mid-flight — and none of that is the
//! problem people actually have, which is *not knowing*. This answers the
//! question and leaves the upgrade to `install.sh`.
//!
//! The project already knew about the gap. `remote/protocol/version.rs` says it
//! outright: "this project's own development machine ran a v0.1.103 daemon
//! against a v0.3.0 client for days, and the only signal was one warning line.
//! People do not upgrade daemons promptly." This is the missing signal.
//!
//! **Cached for a day, and failure is silence.** GitHub rate-limits an
//! unauthenticated caller hard, and a dashboard that polls on every page load
//! would burn that allowance for news that changes weekly at most. A check that
//! cannot reach GitHub reports "no newer version" rather than an error: an
//! offline laptop has not learned that it is out of date, and saying so would
//! be a red banner about the network on a tool that works fine without one.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const RELEASES_API: &str = "https://api.github.com/repos/Rorogogogo/nomoreide/releases/latest";
const CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// What the dashboard renders. `latest` is absent until a check succeeds.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// The version this binary was built as.
    pub current: String,
    /// The newest release GitHub reported, when one is known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    /// `latest` is strictly newer than `current`.
    pub update_available: bool,
    /// How to get it. Fixed text rather than a link, because the answer is a
    /// command and a link would need the reader to find it again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upgrade_command: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Cached {
    latest: String,
    checked_at_unix: u64,
}

/// Beside the settings, because this is a cache *about* the install rather
/// than part of any one workspace — `$XDG_CONFIG_HOME/nomoreide/`, the same
/// root [`crate::app_settings::default_settings_path`] resolves.
pub fn default_cache_dir() -> PathBuf {
    crate::app_settings::default_settings_path()
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_default()
}

fn cache_path(state_dir: &std::path::Path) -> PathBuf {
    state_dir.join("update-check.json")
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

/// Compare two `x.y.z` strings numerically.
///
/// **Not a string compare**, which is the bug this exists to avoid: `"0.9.0"`
/// sorts after `"0.18.0"` lexically, so a string compare would announce an
/// upgrade to an older release every time the minor version passed nine.
/// Anything unparseable sorts as zero, so a malformed tag never claims to be
/// newer than a real one.
fn is_newer(latest: &str, current: &str) -> bool {
    fn parts(version: &str) -> Vec<u64> {
        version
            .trim()
            .trim_start_matches('v')
            .split('-')
            .next()
            .unwrap_or_default()
            .split('.')
            .map(|part| part.parse().unwrap_or(0))
            .collect()
    }
    let (latest, current) = (parts(latest), parts(current));
    for index in 0..latest.len().max(current.len()) {
        let (a, b) = (
            latest.get(index).copied().unwrap_or(0),
            current.get(index).copied().unwrap_or(0),
        );
        if a != b {
            return a > b;
        }
    }
    false
}

fn status_for(current: &str, latest: Option<String>) -> UpdateStatus {
    let available = latest
        .as_deref()
        .is_some_and(|latest| is_newer(latest, current));
    UpdateStatus {
        current: current.to_string(),
        latest,
        update_available: available,
        upgrade_command: available
            .then(|| "curl -fsSL https://www.nomoreide.com/install.sh | sh".to_string()),
    }
}

/// The cached answer, or a fresh one when the cache is older than a day.
pub async fn check(state_dir: &std::path::Path, current: &str) -> UpdateStatus {
    if let Some(cached) = read_cache(state_dir) {
        if now_unix().saturating_sub(cached.checked_at_unix) < CACHE_TTL.as_secs() {
            return status_for(current, Some(cached.latest));
        }
    }
    match fetch_latest().await {
        Some(latest) => {
            write_cache(state_dir, &latest);
            status_for(current, Some(latest))
        }
        // Unreachable GitHub is not "you are up to date", but it is also not
        // news — so the last thing known is better than nothing, and nothing is
        // better than an error.
        None => status_for(current, read_cache(state_dir).map(|cached| cached.latest)),
    }
}

fn read_cache(state_dir: &std::path::Path) -> Option<Cached> {
    let raw = std::fs::read_to_string(cache_path(state_dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_cache(state_dir: &std::path::Path, latest: &str) {
    let cached = Cached {
        latest: latest.to_string(),
        checked_at_unix: now_unix(),
    };
    if let Ok(body) = serde_json::to_string(&cached) {
        let _ = std::fs::create_dir_all(state_dir);
        let _ = std::fs::write(cache_path(state_dir), body);
    }
}

async fn fetch_latest() -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;
    let response = client
        .get(RELEASES_API)
        // GitHub refuses an unauthenticated request with no user agent.
        .header("user-agent", "nomoreide")
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: serde_json::Value = response.json().await.ok()?;
    let tag = body.get("tag_name")?.as_str()?;
    Some(tag.trim_start_matches('v').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_larger_minor_is_newer_even_though_it_sorts_earlier_as_text() {
        // The reason this is not a string compare.
        assert!(is_newer("0.18.0", "0.9.0"));
        assert!(!is_newer("0.9.0", "0.18.0"));
    }

    #[test]
    fn the_same_version_is_not_an_update() {
        assert!(!is_newer("0.18.1", "0.18.1"));
        assert!(!is_newer("v0.18.1", "0.18.1"));
    }

    #[test]
    fn a_patch_counts_and_so_does_a_missing_one() {
        assert!(is_newer("0.18.1", "0.18.0"));
        assert!(is_newer("0.18", "0.17.9"));
        assert!(!is_newer("0.18", "0.18.0"));
    }

    #[test]
    fn a_prerelease_suffix_is_compared_on_its_numbers() {
        assert!(is_newer("0.19.0-rc.1", "0.18.1"));
    }

    #[test]
    fn an_unparseable_tag_never_claims_to_be_newer() {
        assert!(!is_newer("not-a-version", "0.18.1"));
    }

    #[test]
    fn an_unknown_latest_is_not_an_update_and_offers_no_command() {
        let status = status_for("0.18.1", None);
        assert!(!status.update_available);
        assert_eq!(status.upgrade_command, None);
        assert_eq!(status.current, "0.18.1");
    }

    #[test]
    fn an_available_update_names_the_command_that_installs_it() {
        let status = status_for("0.17.0", Some("0.18.1".to_string()));
        assert!(status.update_available);
        assert!(status
            .upgrade_command
            .expect("a command")
            .contains("install.sh"));
    }
}
