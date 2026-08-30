//! Saved bundles of MCP servers, skills, and plugins.
//!
//! A profile is a directory under the user's config holding a `profile.json`,
//! and this module is the CRUD over that tree. What a profile *contains* is
//! deliberately kept as documents rather than as a typed model of every field:
//! the tool layer has already validated the shape a caller sent, and the store
//! only has to hand back exactly what it was given. Modelling it twice would
//! give the two layers a chance to disagree.

mod apply;
mod credentials;
pub mod debug_setup;
pub mod publication;
mod registry;
mod snapshot;
mod store;
mod transfer;

use crate::agent_env::{Json, OrderedMap};
use serde::{Deserialize, Serialize};

pub use apply::{apply, ApplyOutcome, ApplyPreview};
pub use registry::{
    auth, config as registry_config, install, list_public_profiles, publish, register_github,
    InstallOutcome, PublishOutcome, PublishRequest,
};
pub use snapshot::{refresh, snapshot};
pub use store::profiles_root;
pub use transfer::{export, import, ExportOutcome, ImportOutcome};

/// One saved profile, as its own file holds it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub name: String,
    /// Absent rather than empty when the profile was created without one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Which agent a snapshot was taken from. Absent on a profile that was
    /// built by hand rather than captured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_agent: Option<String>,
    #[serde(default)]
    pub mcps: OrderedMap<Json>,
    #[serde(default)]
    pub skills: Vec<Json>,
    #[serde(default)]
    pub plugins: Vec<Json>,
}

/// A profile as a listing shows it: what it holds, not what is in it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSummary {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Carried into the listing, not only into the profile: which agent a
    /// bundle came from is how anyone tells two snapshots apart.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_agent: Option<String>,
    pub mcp_count: usize,
    pub skill_count: usize,
    pub plugin_count: usize,
    /// When the profile was last written. Read from the file rather than
    /// stored in it, so an edit made by any means keeps it honest.
    pub updated_at: String,
    /// Where this profile came from, when it came from the registry.
    ///
    /// Absent for a profile made here. Serialised after `updatedAt` because
    /// the reference spreads it in at that point.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub ok: bool,
    pub deleted: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CopyOutcome {
    pub ok: bool,
    pub copied_mcps: Vec<String>,
    pub copied_skills: Vec<String>,
    pub copied_plugins: Vec<String>,
}

/// What a profile may be called.
///
/// The name is also a directory name, so this is a safety boundary as much as
/// a validation rule: anything that could climb out of the profile root — a
/// slash, a leading dot-dot — is refused here rather than sanitised later.
fn valid_name(name: &str) -> bool {
    let mut characters = name.chars();
    let first = characters.next();
    first.is_some_and(|c| c.is_ascii_alphanumeric())
        && characters.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// The name a caller supplied, trimmed, if it is one this store will hold.
///
/// The padding is taken off *before* the check and the trimmed name is what is
/// used from then on — so `"  x  "` is the profile `x`, and a name that is only
/// spaces is refused as the empty string it trims down to rather than as the
/// spaces it arrived as.
pub(super) fn check_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if valid_name(trimmed) {
        return Ok(trimmed.to_string());
    }
    Err(format!(
        "Invalid profile name \"{trimmed}\". Use letters, numbers, \".\", \"_\", or \"-\"."
    ))
}

fn not_found(name: &str) -> String {
    format!("Profile \"{name}\" not found.")
}

/// Every profile, newest first.
pub fn list() -> Result<Vec<ProfileSummary>, String> {
    let mut summaries = store::summaries()?;
    // Most recently written first, so a listing leads with what the user was
    // last working on. Ties break by name, because two profiles written in the
    // same millisecond would otherwise come back in directory order.
    summaries.sort_by(|left, right| {
        right
            .1
            .cmp(&left.1)
            .then_with(|| left.0.name.cmp(&right.0.name))
    });
    Ok(summaries.into_iter().map(|(summary, _)| summary).collect())
}

/// Read a profile back.
///
/// The *asked-for* name is not checked, only the stored one. A profile that
/// only [`import`] could have created — its name is whatever the archive or
/// the `as` argument said — is still found, and is refused for what is in it
/// rather than for what it was called.
pub fn get(name: &str) -> Result<Profile, String> {
    store::load(name)?.ok_or_else(|| not_found(name))
}

pub fn create(name: &str, description: Option<&str>) -> Result<Profile, String> {
    let name = check_name(name)?;
    if store::exists(&name) {
        return Err(format!("Profile \"{name}\" already exists."));
    }
    let profile = Profile {
        name: name.clone(),
        description: description.map(str::to_string),
        ..Profile::default()
    };
    store::save(&profile)?;
    Ok(profile)
}

/// Change only what was named. Every field is optional, and one left out is
/// left alone rather than cleared — an update that sends only a description
/// must not empty the profile.
pub fn update(
    name: &str,
    description: Option<&str>,
    mcps: Option<OrderedMap<Json>>,
    skills: Option<Vec<Json>>,
    plugins: Option<Vec<Json>>,
) -> Result<Profile, String> {
    let mut profile = get(name)?;
    if let Some(description) = description {
        profile.description = Some(description.to_string());
    }
    if let Some(mcps) = mcps {
        profile.mcps = canonical_servers(&mcps);
    }
    if let Some(skills) = skills {
        profile.skills = skills;
    }
    if let Some(plugins) = plugins {
        profile.plugins = plugins;
    }
    store::save(&profile)?;
    Ok(profile)
}

/// Every server rebuilt in the shape a profile stores.
///
/// A caller's own field order does not survive, and neither do fields the
/// other kind of server uses — a `remote` sent with a `command` is stored
/// without one. Two profiles holding the same servers are then the same file,
/// however the callers that built them happened to spell it.
fn canonical_servers(mcps: &OrderedMap<Json>) -> OrderedMap<Json> {
    let mut out = OrderedMap::new();
    for (name, entry) in mcps.iter() {
        out.insert(name.to_string(), canonical_server(entry));
    }
    out
}

fn canonical_server(entry: &Json) -> Json {
    let Some(fields) = entry.as_object() else {
        return entry.clone();
    };
    let mut server = OrderedMap::new();
    let carry = |server: &mut OrderedMap<Json>, key: &str| {
        if let Some(value) = fields.get(key) {
            server.insert(key.to_string(), value.clone());
        }
    };
    let remote = matches!(fields.get("kind"), Some(Json::String(kind)) if kind == "remote");
    carry(&mut server, "kind");
    if remote {
        for key in ["transport", "url", "headers", "env"] {
            carry(&mut server, key);
        }
    } else {
        for key in ["command", "args", "env"] {
            carry(&mut server, key);
        }
    }
    Json::Object(server)
}

pub fn delete(name: &str) -> Result<DeleteOutcome, String> {
    if !store::exists(name) {
        return Err(not_found(name));
    }
    store::remove(name)?;
    Ok(DeleteOutcome {
        ok: true,
        deleted: name.to_string(),
    })
}

/// Copy named items from one profile into another.
///
/// All or nothing: every item is looked up before anything is written, so a
/// request naming one item that does not exist leaves the target untouched
/// rather than half-copied.
pub fn copy_items(
    from: &str,
    to: &str,
    mcps: &[String],
    skills: &[String],
    plugins: &[String],
) -> Result<CopyOutcome, String> {
    let source = get(from)?;
    let mut target = get(to)?;

    let taken_mcps = mcps
        .iter()
        .map(|key| {
            source
                .mcps
                .get(key)
                .cloned()
                .map(|entry| (key.clone(), entry))
                .ok_or_else(|| format!("MCP \"{key}\" not found in profile \"{from}\"."))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let taken_skills = pick(&source.skills, skills, "Skill", from)?;
    let taken_plugins = pick(&source.plugins, plugins, "Plugin", from)?;

    for (key, entry) in &taken_mcps {
        target.mcps.set(key.clone(), entry.clone());
    }
    replace_by_name(&mut target.skills, &taken_skills);
    replace_by_name(&mut target.plugins, &taken_plugins);
    store::save(&target)?;

    Ok(CopyOutcome {
        ok: true,
        copied_mcps: taken_mcps.into_iter().map(|(key, _)| key).collect(),
        copied_skills: skills.to_vec(),
        // A plugin is reported by its id rather than its name — the name alone
        // does not say which agent it came from, and two agents may each have
        // one called the same thing.
        copied_plugins: taken_plugins.iter().map(apply::plugin_id).collect(),
    })
}

/// The named entries of a list, in the order they were asked for.
fn pick(
    available: &[Json],
    wanted: &[String],
    label: &str,
    from: &str,
) -> Result<Vec<Json>, String> {
    wanted
        .iter()
        .map(|name| {
            available
                .iter()
                .find(|entry| entry_name(entry) == Some(name.as_str()))
                .cloned()
                .ok_or_else(|| format!("{label} \"{name}\" not found in profile \"{from}\"."))
        })
        .collect()
}

fn entry_name(entry: &Json) -> Option<&str> {
    entry.as_object()?.get("name")?.as_str()
}

/// Add each entry, replacing one of the same name rather than duplicating it.
fn replace_by_name(target: &mut Vec<Json>, incoming: &[Json]) {
    for entry in incoming {
        match target
            .iter_mut()
            .find(|existing| entry_name(existing) == entry_name(entry))
        {
            Some(existing) => *existing = entry.clone(),
            None => target.push(entry.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_may_not_climb_out_of_the_profile_root() {
        for refused in [
            "../escape",
            "a/b",
            "-nope",
            ".hidden",
            "",
            "with space",
            "a\\\\b",
        ] {
            assert!(!valid_name(refused), "{refused} should be refused");
        }
        for accepted in ["alpha", "a", "A1", "a.b_c-d", "9lives"] {
            assert!(valid_name(accepted), "{accepted} should be accepted");
        }
    }

    #[test]
    fn the_refusal_names_what_was_wrong_with_it() {
        assert_eq!(
            check_name("../escape").unwrap_err(),
            "Invalid profile name \"../escape\". Use letters, numbers, \".\", \"_\", or \"-\"."
        );
    }
}
