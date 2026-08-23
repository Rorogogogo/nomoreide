//! Moving a profile between machines as a `.tar.gz`.
//!
//! The archive is the interchange format, so it is a contract with whoever
//! wrote the one being read — including older versions of this program. It
//! holds a `manifest.json` naming the secrets it needs, a `profile.json` with
//! those secrets replaced by placeholders, and a `skills/` tree carrying the
//! skill directories the profile names.
//!
//! Reading someone else's archive is the dangerous half: a member path is
//! attacker-controlled, so every one is checked to stay inside the directory it
//! is being unpacked into before anything is written.

use super::credentials::{self, Credential, Source};
use super::{store, Profile};
use crate::agent_env::Json;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

/// What an archive says about itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    profile_name: String,
    created_by: CreatedBy,
    /// Left out entirely when a profile needs no secrets, which is what the
    /// reference writes — an archive with an empty list and one with no list
    /// are the same archive.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    credentials: Vec<Credential>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CreatedBy {
    tool: String,
    version: String,
}

/// The only schema this program writes, and the only one it reads.
const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    /// Reported exactly as it was asked for. A relative path stays relative,
    /// because that is what the caller will look for it under.
    pub archive_path: String,
    pub credentials: Vec<Credential>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub name: String,
    pub mcp_count: usize,
    pub skill_count: usize,
    pub plugin_count: usize,
    /// The secrets the archive asked for that nothing supplied. Their
    /// placeholders are still in the saved profile, so importing again with the
    /// secrets in hand finishes the job.
    pub missing_credentials: Vec<Credential>,
}

/// Write a profile out as a portable archive.
pub fn export(name: &str, output_path: Option<&str>, cwd: &Path) -> Result<ExportOutcome, String> {
    let Some(profile) = store::load(name)? else {
        return Err(format!("Profile \"{name}\" not found."));
    };
    let archive_path = output_path.map(str::to_string).unwrap_or_else(|| {
        cwd.join(format!("{name}.tar.gz"))
            .to_string_lossy()
            .to_string()
    });

    let (redacted, credentials) = redact(&profile);
    let staging = temp_directory("nomoreide-profile-export");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)
        .map_err(|error| format!("Failed to create {}: {error}", staging.display()))?;
    let result = stage_and_pack(
        &profile,
        &redacted,
        &credentials,
        &staging,
        Path::new(&archive_path),
    );
    let _ = std::fs::remove_dir_all(&staging);
    result?;

    Ok(ExportOutcome {
        archive_path,
        credentials,
    })
}

fn stage_and_pack(
    profile: &Profile,
    redacted: &Profile,
    credentials: &[Credential],
    staging: &Path,
    archive_path: &Path,
) -> Result<(), String> {
    let manifest = Manifest {
        schema_version: SCHEMA_VERSION,
        profile_name: profile.name.clone(),
        created_by: CreatedBy {
            tool: "nomoreide".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        },
        credentials: credentials.to_vec(),
    };
    write_json(&staging.join("manifest.json"), &manifest)?;
    write_json(&staging.join("profile.json"), redacted)?;

    // A profile that names a skill it does not carry cannot be exported: the
    // archive would name a skill the far side has no way to install.
    for skill in &profile.skills {
        let Some(skill_name) = skill.as_object().and_then(|entry| entry.get("name")) else {
            continue;
        };
        let Json::String(skill_name) = skill_name else {
            continue;
        };
        let Some(source) = store::bundled_skill(&profile.name, skill_name) else {
            return Err(format!(
                "Profile \"{}\" is missing bundled skill \"{skill_name}\".",
                profile.name
            ));
        };
        let target = staging.join("skills").join(skill_name);
        std::fs::create_dir_all(&target)
            .map_err(|error| format!("Failed to create {}: {error}", target.display()))?;
        crate::agent_env::copy_tree(&source, &target)?;
    }

    if let Some(parent) = archive_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    let file = std::fs::File::create(archive_path)
        .map_err(|error| format!("Failed to write {}: {error}", archive_path.display()))?;
    let mut builder = tar::Builder::new(GzEncoder::new(file, Compression::default()));
    builder
        .append_dir_all(".", staging)
        .and_then(|()| builder.into_inner()?.finish().map(|_| ()))
        .map_err(|error| format!("Failed to write {}: {error}", archive_path.display()))
}

/// Read a portable archive back into a saved profile.
pub fn import(
    archive_path: &Path,
    force: bool,
    rename_to: Option<&str>,
    supplied: &BTreeMap<String, String>,
) -> Result<ImportOutcome, String> {
    if !archive_path.is_file() {
        return Err(format!("Archive not found: {}", archive_path.display()));
    }
    let staging = temp_directory("nomoreide-profile-import");
    let _ = std::fs::remove_dir_all(&staging);
    let result =
        unpack(archive_path, &staging).and_then(|()| adopt(&staging, force, rename_to, supplied));
    let _ = std::fs::remove_dir_all(&staging);
    result
}

fn unpack(archive_path: &Path, staging: &Path) -> Result<(), String> {
    std::fs::create_dir_all(staging)
        .map_err(|error| format!("Failed to create {}: {error}", staging.display()))?;
    let unreadable =
        || "Could not extract the archive — is it a .tar.gz profile export?".to_string();
    let file = std::fs::File::open(archive_path).map_err(|_| unreadable())?;
    let mut archive = tar::Archive::new(GzDecoder::new(file));
    let entries = archive.entries().map_err(|_| unreadable())?;
    for entry in entries {
        let mut entry = entry.map_err(|_| unreadable())?;
        let path = entry.path().map_err(|_| unreadable())?.into_owned();
        // The member path comes from whoever built the archive, so it is
        // checked before it is joined to anything: an absolute path or a `..`
        // would otherwise write wherever it liked.
        if !is_contained(&path) {
            return Err(format!(
                "Profile archive contains an unsafe path: {}",
                path.display()
            ));
        }
        // A link is refused whatever it points at, and before it is created.
        // A symlink to somewhere outside turns every *later* member into a
        // write wherever it points, which no check on those members would see.
        if entry.header().entry_type().is_symlink() || entry.header().entry_type().is_hard_link() {
            return Err(format!(
                "Profile archive contains a link entry, which is not allowed: {}",
                path.display()
            ));
        }
        entry.unpack_in(staging).map_err(|_| unreadable())?;
    }
    Ok(())
}

/// Whether a member path stays inside the directory it is unpacked into.
fn is_contained(path: &Path) -> bool {
    path.components()
        .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

fn adopt(
    staging: &Path,
    force: bool,
    rename_to: Option<&str>,
    supplied: &BTreeMap<String, String>,
) -> Result<ImportOutcome, String> {
    // Each half of the archive is refused by name, so a reader is told which
    // one it is. A file that is *absent* is reported by `read_json` instead —
    // those two cases do not share a message.
    let not_ours = || {
        "Archive has a missing or invalid manifest.json — not a nomoreide profile archive."
            .to_string()
    };
    let manifest: Manifest = read_json(&staging.join("manifest.json"))?.ok_or_else(not_ours)?;
    if manifest.schema_version != SCHEMA_VERSION {
        return Err(not_ours());
    }
    let mut profile: Profile = read_json(&staging.join("profile.json"))?
        .ok_or_else(|| "Archive has a missing or invalid profile.json.".to_string())?;

    if let Some(name) = rename_to {
        profile.name = name.to_string();
    }
    if store::exists(&profile.name) && !force {
        return Err(format!(
            "Profile \"{}\" already exists. Re-import with force to overwrite.",
            profile.name
        ));
    }

    let unresolved = resolve(&mut profile, supplied);
    store::save(&profile)?;

    let bundled = staging.join("skills");
    if bundled.is_dir() {
        for skill in &profile.skills {
            let Some(Json::String(skill_name)) =
                skill.as_object().and_then(|entry| entry.get("name"))
            else {
                continue;
            };
            let source = bundled.join(skill_name);
            if source.is_dir() {
                store::bundle_skill(&profile.name, skill_name, &source)?;
            }
        }
    }

    Ok(ImportOutcome {
        name: profile.name.clone(),
        mcp_count: profile.mcps.len(),
        skill_count: profile.skills.len(),
        plugin_count: profile.plugins.len(),
        // In the order the profile was walked, not the order the manifest
        // lists them: a reader fixing these goes through the servers, and the
        // manifest sorts each server's secrets while the walk does not.
        missing_credentials: unresolved
            .iter()
            .filter_map(|key| {
                manifest
                    .credentials
                    .iter()
                    .find(|credential| &credential.key == key)
                    .cloned()
            })
            .collect(),
    })
}

/// Take every secret out of a profile, and say what was taken.
///
/// The credentials of one server are collected from its `env` and its `headers`
/// together and reported in key order; servers themselves keep the order the
/// profile lists them in. Where two servers want the same credential the first
/// one fixes where it appears and the last one describes it — the description
/// is replaced rather than extended, so it always names one server's spelling
/// of the secret rather than every server's.
fn redact(profile: &Profile) -> (Profile, Vec<Credential>) {
    let mut redacted = profile.clone();
    let mut order: Vec<String> = Vec::new();
    let mut described: BTreeMap<String, Credential> = BTreeMap::new();

    let names: Vec<String> = redacted
        .mcps
        .iter()
        .map(|(name, _)| name.to_string())
        .collect();
    for name in names {
        let Some(Json::Object(server)) = redacted.mcps.get_mut(&name) else {
            continue;
        };
        // One server's secrets, gathered before any of them is described: the
        // same credential can be named in both its env and its headers, and
        // the description names every place it was found.
        let mut mentions = Vec::new();
        for (field, source) in [("env", Source::Env), ("headers", Source::Header)] {
            if let Some(Json::Object(map)) = server.get_mut(field) {
                mentions.extend(credentials::redact(map, source));
            }
        }
        let mut keys: Vec<String> = Vec::new();
        for mention in &mentions {
            if !keys.contains(&mention.key) {
                keys.push(mention.key.clone());
            }
        }
        keys.sort();
        for key in keys {
            let named: Vec<_> = mentions
                .iter()
                .filter(|mention| mention.key == key)
                .cloned()
                .collect();
            if !order.contains(&key) {
                order.push(key.clone());
            }
            described.insert(
                key.clone(),
                Credential {
                    key,
                    required: true,
                    description: credentials::description(&named),
                },
            );
        }
    }

    let listed = order
        .into_iter()
        .filter_map(|key| described.remove(&key))
        .collect();
    (redacted, listed)
}

/// Fill in every placeholder that something has a value for, and report the
/// keys nothing did.
///
/// A credential is looked up by its own key — `github_token`, not
/// `GITHUB_TOKEN` — first among what the caller supplied and then in the
/// environment.
fn resolve(profile: &mut Profile, supplied: &BTreeMap<String, String>) -> Vec<String> {
    let lookup = |key: &str| {
        supplied
            .get(key)
            .cloned()
            .or_else(|| std::env::var(key).ok())
    };
    let mut unresolved = Vec::new();
    let names: Vec<String> = profile
        .mcps
        .iter()
        .map(|(name, _)| name.to_string())
        .collect();
    for name in names {
        let Some(Json::Object(server)) = profile.mcps.get_mut(&name) else {
            continue;
        };
        for field in ["env", "headers"] {
            if let Some(Json::Object(map)) = server.get_mut(field) {
                credentials::resolve(map, &lookup, &mut unresolved);
            }
        }
    }
    unresolved
}

fn temp_directory(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("{label}-{}", uuid::Uuid::new_v4().simple()))
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let mut text = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Failed to render {}: {error}", path.display()))?;
    text.push('\n');
    std::fs::write(path, text)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

/// An archive member this program expects to find.
///
/// A file that is *absent* is reported the way the reference's own reader
/// reports it — the archive was unpacked into a directory of this program's
/// choosing, and the caller sees that path in the message. One that is present
/// but unreadable comes back as `None`, for the caller to name.
fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, String> {
    let text = std::fs::read_to_string(path).map_err(|_| {
        format!(
            "ENOENT: no such file or directory, open '{}'",
            path.display()
        )
    })?;
    Ok(serde_json::from_str(&text).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_a_member_that_would_write_outside() {
        assert!(is_contained(Path::new("manifest.json")));
        assert!(is_contained(Path::new("./skills/review/SKILL.md")));
        assert!(!is_contained(Path::new("../escape.txt")));
        assert!(!is_contained(Path::new("/tmp/absolute.txt")));
        assert!(!is_contained(Path::new("skills/../../escape.txt")));
    }
}
