//! Writing a profile into an agent's live configuration.
//!
//! Two modes with different answers. A dry run reports what *would* happen,
//! item by item, with the warnings that say where a target agent cannot hold
//! everything the profile carries — Codex has nowhere to put a remote server's
//! transport, so applying one there loses it, and the caller is told before
//! rather than after. A real run reports what was applied, what was skipped,
//! and every backup it took on the way.
//!
//! Plugins are reported but not installed: a profile carrying a *bundled*
//! plugin is not yet ported, and one that merely names a plugin it does not
//! carry is skipped exactly as the reference skips it.

use super::{store, Profile};
use crate::agent_env::{self, Agent, Json, Scope, ServerSpec};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewItem {
    pub category: &'static str,
    pub name: String,
    /// Only a plugin has one, and it names where the plugin came from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub status: &'static str,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPreview {
    pub profile: String,
    pub agent: &'static str,
    pub items: Vec<PreviewItem>,
    pub unresolved_credentials: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub profile: String,
    pub agent: &'static str,
    pub mcps_applied: Vec<String>,
    pub skills_applied: Vec<String>,
    pub plugins_applied: Vec<String>,
    pub skipped: Vec<String>,
    pub backups: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(untagged)]
pub enum Applied {
    Preview(ApplyPreview),
    Outcome(ApplyOutcome),
}

pub fn apply(
    name: &str,
    agent: Agent,
    dry_run: bool,
    skip_mcps: &[String],
    skip_skills: &[String],
    skip_plugins: &[String],
    cwd: &Path,
) -> Result<Applied, String> {
    let profile = super::get(name)?;
    if dry_run {
        return Ok(Applied::Preview(preview(&profile, agent)));
    }
    Ok(Applied::Outcome(run(
        &profile,
        agent,
        skip_mcps,
        skip_skills,
        skip_plugins,
        cwd,
    )?))
}

fn preview(profile: &Profile, agent: Agent) -> ApplyPreview {
    let mut items = Vec::new();
    for (key, entry) in profile.mcps.iter() {
        items.push(PreviewItem {
            category: "mcp",
            name: key.to_string(),
            id: None,
            status: "add",
            warnings: mcp_warnings(agent, entry),
        });
    }
    for skill in &profile.skills {
        items.push(PreviewItem {
            category: "skill",
            name: entry_name(skill).unwrap_or_default().to_string(),
            id: None,
            status: "add",
            warnings: Vec::new(),
        });
    }
    for plugin in &profile.plugins {
        let name = entry_name(plugin).unwrap_or_default().to_string();
        items.push(PreviewItem {
            category: "plugin",
            id: Some(plugin_id(plugin)),
            status: "add",
            warnings: plugin_warnings(agent, &name),
            name,
        });
    }
    ApplyPreview {
        profile: profile.name.clone(),
        agent: agent.id(),
        items,
        unresolved_credentials: Vec::new(),
    }
}

/// What a target agent cannot keep. Only Codex loses anything: its config has
/// a URL and nothing else to say how to reach it.
fn mcp_warnings(agent: Agent, entry: &Json) -> Vec<String> {
    let remote = entry
        .as_object()
        .and_then(|map| map.get("kind"))
        .and_then(Json::as_str)
        == Some("remote");
    if remote && matches!(agent, Agent::Codex) {
        return vec![
            "Codex config only stores a URL for remote MCPs; transport and headers will be dropped."
                .to_string(),
        ];
    }
    Vec::new()
}

/// A plugin captured from one agent and applied to another arrives as files
/// rather than as that agent's own plugin format.
fn plugin_warnings(agent: Agent, name: &str) -> Vec<String> {
    if matches!(agent, Agent::Claude) {
        return Vec::new();
    }
    vec![format!(
        "Plugin \"{name}\" will be installed as portable assets rather than a native {} plugin.",
        agent.id()
    )]
}

/// `<sourceAgent>:<name>@<version>`, with a plugin that was never published
/// reported as local.
pub(super) fn plugin_id(plugin: &Json) -> String {
    let field = |key: &str| {
        plugin
            .as_object()
            .and_then(|map| map.get(key))
            .and_then(Json::as_str)
    };
    format!(
        "{}:{}@{}",
        field("sourceAgent").unwrap_or("claude"),
        field("name").unwrap_or_default(),
        field("version").unwrap_or("local")
    )
}

fn run(
    profile: &Profile,
    agent: Agent,
    skip_mcps: &[String],
    skip_skills: &[String],
    skip_plugins: &[String],
    cwd: &Path,
) -> Result<ApplyOutcome, String> {
    let mut applied = Vec::new();
    let mut skipped = Vec::new();
    // One copy of the config before anything is written, then one per server —
    // the same rhythm the writes themselves keep.
    let mut backups = agent_env::snapshot_agent(agent)?.backups;

    for (key, entry) in profile.mcps.iter() {
        if skip_mcps.iter().any(|name| name == key) {
            skipped.push(format!("mcp \"{key}\""));
            continue;
        }
        let outcome = agent_env::apply_mcp(agent, key, &spec_of(entry), Scope::User, cwd)?;
        backups.extend(outcome.backups);
        applied.push(key.to_string());
    }

    let mut skills_applied = Vec::new();
    for skill in &profile.skills {
        let name = entry_name(skill).unwrap_or_default().to_string();
        if skip_skills.contains(&name) {
            skipped.push(format!("skill \"{name}\""));
            continue;
        }
        // A profile may name a skill it does not carry — one built by hand, or
        // one whose bundle was never captured. There is nothing to install.
        match store::bundled_skill(&profile.name, &name) {
            Some(source) => {
                agent_env::install_user_skill(agent, &name, &source)?;
                skills_applied.push(name);
            }
            None => skipped.push(format!("skill \"{name}\" (missing from profile bundle)")),
        }
    }

    for plugin in &profile.plugins {
        let name = entry_name(plugin).unwrap_or_default().to_string();
        if skip_plugins.contains(&name) {
            skipped.push(format!("plugin \"{name}\""));
            continue;
        }
        skipped.push(format!("plugin \"{name}\" (missing from profile bundle)"));
    }

    Ok(ApplyOutcome {
        profile: profile.name.clone(),
        agent: agent.id(),
        mcps_applied: applied,
        skills_applied,
        plugins_applied: Vec::new(),
        skipped,
        backups,
    })
}

/// A profile entry read back as something an agent's config can be given.
fn spec_of(entry: &Json) -> ServerSpec {
    let field = |key: &str| {
        entry
            .as_object()
            .and_then(|map| map.get(key))
            .and_then(Json::as_str)
            .map(str::to_string)
    };
    let object = |key: &str| {
        entry
            .as_object()
            .and_then(|map| map.get(key))
            .and_then(Json::as_object)
            .cloned()
    };
    ServerSpec {
        command: field("command"),
        args: entry
            .as_object()
            .and_then(|map| map.get("args"))
            .and_then(|args| match args {
                Json::Array(values) => Some(
                    values
                        .iter()
                        .filter_map(|value| value.as_str().map(str::to_string))
                        .collect(),
                ),
                _ => None,
            })
            .unwrap_or_default(),
        env: object("env"),
        url: field("url"),
        transport: field("transport"),
    }
}

fn entry_name(entry: &Json) -> Option<&str> {
    entry.as_object()?.get("name")?.as_str()
}
