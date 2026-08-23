//! Where profiles live on disk, and nothing about what they mean.

use super::{Profile, ProfileSummary};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// `~/.config/nomoreide/agent-profiles`, honouring `XDG_CONFIG_HOME` the way
/// the rest of this program's configuration does.
pub fn profiles_root() -> PathBuf {
    let base = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".config")
        });
    base.join("nomoreide").join("agent-profiles")
}

/// A profile's own directory. The name has already been checked against
/// [`super::valid_name`], so it cannot reach outside the root.
fn directory(name: &str) -> PathBuf {
    profiles_root().join(name)
}

fn file(name: &str) -> PathBuf {
    directory(name).join("profile.json")
}

pub(super) fn exists(name: &str) -> bool {
    file(name).is_file()
}

pub(super) fn load(name: &str) -> Result<Option<Profile>, String> {
    let path = file(name);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(None);
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))
}

pub(super) fn save(profile: &Profile) -> Result<(), String> {
    let directory = directory(&profile.name);
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create {}: {error}", directory.display()))?;
    let path = file(&profile.name);
    let mut text = serde_json::to_string_pretty(profile)
        .map_err(|error| format!("Failed to render {}: {error}", path.display()))?;
    text.push('\n');
    std::fs::write(&path, text)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

pub(super) fn remove(name: &str) -> Result<(), String> {
    let directory = directory(name);
    std::fs::remove_dir_all(&directory)
        .map_err(|error| format!("Failed to remove {}: {error}", directory.display()))
}

/// Every profile in the root, each with when it was last written.
///
/// A directory that holds no readable `profile.json` is skipped rather than
/// reported as an error: the root is a place the user can put things, and one
/// stray directory must not make the whole listing fail.
pub(super) fn summaries() -> Result<Vec<(ProfileSummary, SystemTime)>, String> {
    let root = profiles_root();
    let Ok(listing) = std::fs::read_dir(&root) else {
        return Ok(Vec::new());
    };
    let mut summaries = Vec::new();
    for entry in listing.filter_map(Result::ok) {
        if !entry.path().is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(profile) = load(&name)? else {
            continue;
        };
        let path = file(&name);
        let modified = std::fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        summaries.push((
            ProfileSummary {
                name: profile.name,
                description: profile.description,
                mcp_count: profile.mcps.len(),
                skill_count: profile.skills.len(),
                plugin_count: profile.plugins.len(),
                updated_at: iso_instant(modified),
            },
            modified,
        ));
    }
    Ok(summaries)
}

/// Where a profile keeps the skill directories it carries.
fn skills_directory(name: &str) -> PathBuf {
    directory(name).join("skills")
}

/// Copy a skill's directory into the profile, so the profile carries the
/// skill rather than only its name.
pub(super) fn bundle_skill(profile: &str, skill: &str, source: &Path) -> Result<(), String> {
    let target = skills_directory(profile).join(skill);
    std::fs::create_dir_all(&target)
        .map_err(|error| format!("Failed to create {}: {error}", target.display()))?;
    crate::agent_env::copy_tree(source, &target)
}

/// The directory a profile carries for `skill`, if it carries one at all.
pub(super) fn bundled_skill(profile: &str, skill: &str) -> Option<PathBuf> {
    let path = skills_directory(profile).join(skill);
    path.is_dir().then_some(path)
}

/// An ISO-8601 instant in UTC to the millisecond, which is what the reference's
/// `toISOString` produces.
fn iso_instant(time: SystemTime) -> String {
    let millis = time
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0);
    chrono::DateTime::from_timestamp_millis(millis)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_instant_is_rendered_to_the_millisecond_in_utc() {
        let time = SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(1_787_478_097_582);
        assert_eq!(iso_instant(time), "2026-08-23T09:41:37.582Z");
    }
}
