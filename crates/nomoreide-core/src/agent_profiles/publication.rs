//! The link between a local profile and the registry entry it came from.
//!
//! Written next to the profile as `registry.json` when it is installed or
//! published, and read back into the listing so the dashboard can say where a
//! profile came from and whether it has been edited since.
//!
//! **"Edited since" is a content digest, not a timestamp.** A profile's file is
//! rewritten by operations that change nothing a registry cares about, and its
//! mtime moves every time; what matters is whether the servers, skills and
//! plugins still hash to what was published. The digest is taken over the
//! *redacted* config, because exporting redacts too — a user filling in their
//! own token has not diverged from the published profile.
//!
//! The hashing is the reference's, byte for byte — sha256 over a canonical JSON
//! with sorted keys, and a directory walked in sorted order with `.git` and
//! `.DS_Store` skipped — so a `registry.json` written by either runtime reads
//! correctly in the other.

use super::credentials::{self, Source};
use super::{store, Profile};
use crate::agent_env::{Json, OrderedMap};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

/// What a profile hashed to when it was linked.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_agent: Option<String>,
    pub mcps: std::collections::BTreeMap<String, String>,
    pub skills: std::collections::BTreeMap<String, String>,
    pub plugins: std::collections::BTreeMap<String, String>,
    pub content_digest: String,
}

/// `registry.json` itself.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegistryLink {
    pub schema_version: u32,
    /// `installed` or `published`.
    pub origin: String,
    pub slug: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    pub linked_at: String,
    pub baseline: Snapshot,
}

/// What a caller supplies; the rest of the link is derived here.
#[derive(Debug, Clone, Default)]
pub struct NewLink<'a> {
    pub origin: &'a str,
    pub slug: &'a str,
    pub version: &'a str,
    pub profile_id: Option<&'a str>,
    pub version_id: Option<&'a str>,
}

fn link_file(name: &str) -> std::path::PathBuf {
    store::directory_of(name).join("registry.json")
}

/// Record where a profile came from, hashing it as it stands.
///
/// A failure to write is *not* a failure of the install or publish that called
/// it — the profile is on disk and the registry has the version; only the
/// provenance note is missing. Callers ignore the error for that reason.
pub fn write_link(name: &str, new: NewLink<'_>) -> Result<RegistryLink, String> {
    let Some(profile) = store::load(name)? else {
        return Err(format!("Profile \"{name}\" not found."));
    };
    let link = RegistryLink {
        schema_version: 1,
        origin: new.origin.to_string(),
        slug: new.slug.to_string(),
        version: new.version.to_string(),
        profile_id: new.profile_id.map(str::to_string),
        version_id: new.version_id.map(str::to_string),
        linked_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        baseline: snapshot(&profile, &store::directory_of(name)),
    };
    let path = link_file(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    let mut text = serde_json::to_string_pretty(&link)
        .map_err(|error| format!("Failed to render registry.json: {error}"))?;
    text.push('\n');
    // Written beside and renamed, so a reader never sees half a link.
    let staging = path.with_extension(format!(
        "json.tmp.{}",
        chrono::Utc::now().timestamp_millis()
    ));
    std::fs::write(&staging, text)
        .map_err(|error| format!("Failed to write {}: {error}", staging.display()))?;
    std::fs::rename(&staging, &path)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    Ok(link)
}

/// The link a profile carries, or nothing. A malformed one is nothing too —
/// provenance that cannot be parsed is not provenance.
pub fn read_link(name: &str) -> Option<RegistryLink> {
    let text = std::fs::read_to_string(link_file(name)).ok()?;
    serde_json::from_str(&text).ok()
}

/// The link as the listing reports it: where it came from, and whether it has
/// drifted since.
pub fn summary(name: &str, profile: &Profile) -> Option<serde_json::Value> {
    let link = read_link(name)?;
    let current = snapshot(profile, &store::directory_of(name));
    let mut summary = serde_json::Map::new();
    summary.insert("origin".into(), serde_json::json!(link.origin));
    summary.insert("slug".into(), serde_json::json!(link.slug));
    summary.insert("version".into(), serde_json::json!(link.version));
    summary.insert("linkedAt".into(), serde_json::json!(link.linked_at));
    summary.insert(
        "hasLocalChanges".into(),
        serde_json::json!(current.content_digest != link.baseline.content_digest),
    );
    Some(serde_json::Value::Object(summary))
}

/// Hash a profile: each server, skill and plugin on its own, and the whole
/// thing once more so a single comparison answers "has anything changed".
pub fn snapshot(profile: &Profile, directory: &Path) -> Snapshot {
    let mut mcps = std::collections::BTreeMap::new();
    for (name, server) in profile.mcps.iter() {
        mcps.insert(name.to_string(), digest_value(&redacted(server)));
    }

    let mut skills = std::collections::BTreeMap::new();
    for skill in &profile.skills {
        let Some(name) = skill
            .as_object()
            .and_then(|map| map.get("name"))
            .and_then(Json::as_str)
        else {
            continue;
        };
        skills.insert(
            name.to_string(),
            digest_directory(&directory.join("skills").join(basename(name))),
        );
    }

    let mut plugins = std::collections::BTreeMap::new();
    for plugin in &profile.plugins {
        let Some(fields) = plugin.as_object() else {
            continue;
        };
        let Some(name) = fields.get("name").and_then(Json::as_str) else {
            continue;
        };
        let bundle = fields
            .get("bundleKey")
            .and_then(Json::as_str)
            .unwrap_or_default();
        let files = digest_directory(&directory.join("plugins").join(bundle));
        let mut described = OrderedMap::new();
        described.insert("metadata".into(), plugin.clone());
        described.insert("files".into(), Json::String(files));
        plugins.insert(name.to_string(), digest_value(&Json::Object(described)));
    }

    // The digest is taken over this object, and both optional fields are
    // *omitted* when absent rather than written as null — a null would change
    // the hash.
    let mut content = OrderedMap::new();
    let description = profile
        .description
        .clone()
        .filter(|value| !value.is_empty());
    let source_agent = profile
        .source_agent
        .clone()
        .filter(|value| !value.is_empty());
    if let Some(description) = description.clone() {
        content.insert("description".into(), Json::String(description));
    }
    if let Some(agent) = source_agent.clone() {
        content.insert("sourceAgent".into(), Json::String(agent));
    }
    content.insert("mcps".into(), digest_map(&mcps));
    content.insert("skills".into(), digest_map(&skills));
    content.insert("plugins".into(), digest_map(&plugins));
    let content_digest = digest_value(&Json::Object(content));

    Snapshot {
        description,
        source_agent,
        mcps,
        skills,
        plugins,
        content_digest,
    }
}

/// A name-to-digest map as a JSON object, so the whole content can be hashed
/// in one pass.
fn digest_map(entries: &std::collections::BTreeMap<String, String>) -> Json {
    let mut map = OrderedMap::new();
    for (name, digest) in entries {
        map.insert(name.clone(), Json::String(digest.clone()));
    }
    Json::Object(map)
}

/// One server with its secrets taken out, which is what gets hashed: a user
/// who filled in their own token has not diverged from what was published.
fn redacted(server: &Json) -> Json {
    let mut server = server.clone();
    if let Some(map) = server.as_object_mut() {
        for (field, source) in [("env", Source::Env), ("headers", Source::Header)] {
            if let Some(Json::Object(values)) = map.get_mut(field) {
                let _: Vec<_> = credentials::redact(values, source);
            }
        }
    }
    server
}

fn digest_value(value: &Json) -> String {
    let mut hash = Sha256::new();
    hash.update(canonical_json(value).as_bytes());
    format!("{:x}", hash.finalize())
}

/// `JSON.stringify` with object keys sorted, which is what makes a digest
/// stable across two runtimes that order their maps differently.
fn canonical_json(value: &Json) -> String {
    match value {
        Json::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Json::Object(map) => {
            let mut entries: Vec<(&str, &Json)> = map.iter().collect();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        other => serde_json::to_string(other).unwrap_or_else(|_| "null".to_string()),
    }
}

/// Hash a directory's contents: names, shape and bytes.
///
/// A directory that is not there hashes to a fixed marker rather than failing,
/// so a profile whose skill folder was deleted reads as *changed* instead of
/// unreadable.
fn digest_directory(directory: &Path) -> String {
    let mut hash = Sha256::new();
    visit(&mut hash, directory, "");
    format!("{:x}", hash.finalize())
}

fn visit(hash: &mut Sha256, current: &Path, relative: &str) {
    let Ok(listing) = std::fs::read_dir(current) else {
        hash.update(b"missing\0");
        return;
    };
    let mut entries: Vec<_> = listing
        .filter_map(Result::ok)
        .map(|entry| (entry.file_name().to_string_lossy().into_owned(), entry))
        .collect();
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    for (name, entry) in entries {
        // Neither belongs to the profile: one is a checkout, the other is the
        // Finder's.
        if name == ".git" || name == ".DS_Store" {
            continue;
        }
        let child = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        let path = entry.path();
        if path.is_dir() {
            hash.update(format!("dir\0{child}\0").as_bytes());
            visit(hash, &path, &child);
        } else if path.is_file() {
            hash.update(format!("file\0{child}\0").as_bytes());
            if let Ok(bytes) = std::fs::read(&path) {
                hash.update(&bytes);
            }
            hash.update(b"\0");
        }
    }
}

fn basename(name: &str) -> &str {
    name.rsplit(['/', std::path::MAIN_SEPARATOR])
        .find(|segment| !segment.is_empty())
        .unwrap_or(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Json {
        serde_json::from_str::<Json>(text).expect("valid json")
    }

    #[test]
    fn keys_are_sorted_whatever_order_they_arrived_in() {
        assert_eq!(
            canonical_json(&parse(r#"{"b":1,"a":{"d":2,"c":3}}"#)),
            r#"{"a":{"c":3,"d":2},"b":1}"#
        );
    }

    #[test]
    fn arrays_keep_their_order() {
        assert_eq!(canonical_json(&parse("[3,1,2]")), "[3,1,2]");
    }

    /// The digest is the reference's: sha256 over the canonical form. Pinned by
    /// value so a change to either half is visible rather than silent.
    #[test]
    fn a_digest_is_sha256_of_the_canonical_form() {
        let expected = {
            let mut hash = Sha256::new();
            hash.update(br#"{"a":1}"#);
            format!("{:x}", hash.finalize())
        };
        assert_eq!(digest_value(&parse(r#"{"a":1}"#)), expected);
    }

    #[test]
    fn a_directory_that_is_not_there_has_its_own_digest() {
        let missing = digest_directory(Path::new("/definitely/not/here"));
        let also_missing = digest_directory(Path::new("/also/not/here"));
        assert_eq!(missing, also_missing);
        assert_ne!(missing, digest_directory(Path::new("/")));
    }
}
